// What every resource route repeats, once. Three route modules answer the
// Organisation & Access resources (company.ts, projects.ts,
// service-providers.ts) and they agree on four things:
//
//   the path id      — `/projects/:id` takes an `Id` and nothing else, so a
//                      path that is not one is a 400 naming `id` before the
//                      handler runs and before Postgres is asked to read a
//                      malformed uuid;
//   the 200 body     — one JSON body described by its contracts schema;
//   the timestamps   — `timestamptz` arrives as a Date and goes out as the
//                      contracts' IsoDateTime, which is its ISO string;
//   a duplicate      — the unique constraints a route can foresee become a
//                      sentence a client can show, instead of the constraint
//                      name the generic 23505 mapping would print
//                      (problem.ts). A collision nobody foresaw still lands
//                      there, as a 409 either way.
//
// The Registry added the same thing one SQLSTATE along (Issue #78): an
// effective-dated table refuses a row whose period overlaps one already there
// with 23P01, which is the same kind of news and gets the same treatment,
// `refuseOverlap` beside `refuseDuplicate`. Two doors and not one taking a
// SQLSTATE, because a route foresees the two separately — the same table's
// name key and its `no_overlap` constraint say different things to a person —
// and a sentence written for one must not answer the other.
//
// Nothing here knows a table or a resource: what is not shared by every route
// module stays in the one that owns it.
import { Id } from "@waste/contracts/ids"
import { resolver } from "hono-openapi"
import * as z from "zod"

import { exclusionConstraintOf, problem, uniqueConstraintOf } from "../problem"

/** The path parameter of every `/<resource>/:id` route. */
export const IdParam = z.object({ id: Id })

type Schema = Parameters<typeof resolver>[0]

/** What a route says about a JSON body in its OpenAPI description. */
export function describeJson(description: string, schema: Schema) {
  return { description, content: { "application/json": { schema: resolver(schema) } } }
}

/** The instants of a row, as the wire spells them. */
export function stampsOf(row: { createdAt: Date; updatedAt: Date }): { createdAt: string; updatedAt: string } {
  return { createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}

/**
 * Runs a write, and turns a unique violation the route named into a 409 with
 * that sentence. A constraint the route did not name is left to the error
 * handler, which is still a 409 — with the constraint's name, which is the
 * signal that a sentence is missing here.
 */
export async function refuseDuplicate<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refused(uniqueConstraintOf, sentences, write)
}

/**
 * The same for an exclusion constraint: a row whose period overlaps one
 * already there (23P01, the Registry's effective-dated tables). A constraint
 * the route did not name is left to the error handler, a 409 either way.
 */
export async function refuseOverlap<T>(sentences: Readonly<Record<string, string>>, write: () => Promise<T>): Promise<T> {
  return await refused(exclusionConstraintOf, sentences, write)
}

/** What the two above share: run the write, and answer the sentence the route wrote for the constraint it hit. */
async function refused<T>(
  constraintOf: (error: unknown) => string | undefined,
  sentences: Readonly<Record<string, string>>,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write()
  } catch (error) {
    const constraint = constraintOf(error)
    const detail = constraint === undefined ? undefined : sentences[constraint]
    if (detail === undefined) throw error
    throw problem(409, { detail })
  }
}
