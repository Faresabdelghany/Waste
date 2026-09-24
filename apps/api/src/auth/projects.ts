// Which projects the caller works in, as a statement can ask it (Issue #78).
// Organisation & Access needed none of this: a company's projects, roles and
// users are the company's, and `company_id = the caller's` was the whole
// scope. The Registry is the first context whose rows belong to a Project —
// a service frequency, a product, a property, an agreement, a container —
// and an account reaches some projects and not others (`all_projects`, else
// its Project Access rows, resolved once per request in principal.ts).
//
// So a project-scoped statement carries two conditions, never one: the
// tenant, as everywhere, and `inProjects`, the projects of the principal.
// They are not the same fence and neither implies the other — the tenant
// fence in the database knows nothing about Project Access — and a route that
// spells only the first would show one project's products to an account that
// works in another.
//
// The two answers a scope gives are different on purpose:
//
//   a read     — a row outside the caller's projects is a row that is not
//                there. A list leaves it out and a single-row read is the
//                family's own 404, the same as an id nobody minted: telling
//                an account which projects exist that it may not see is
//                telling it something about the company it was not given.
//   a write    — a body naming such a project is a 400 on that field
//                (`requireProject`), because the caller chose the project and
//                can choose another; a 404 on the row it was going to make
//                would say nothing about what to fix.
//
// An account that works in no project at all — a Service Provider's, which
// reaches its own provider and not the company's projects — reaches nothing
// project-scoped: `inProjects` is `false`, so its lists are empty pages and
// its reads are 404s, and every write it names a project in is refused. That
// is a filter and not a refusal by design: whether the surface is open to it
// at all is its role's grant (require.ts), and a provider that may see
// products still only sees the products of projects it works in, which is
// none of them.
import { inArray, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import { problem } from "../problem"
import type { Principal } from "./principal"

/** The ids of the projects the caller works in; empty for an account that works in none. */
export function projectIdsOf(principal: Principal): string[] {
  return principal.projects.map((project) => project.id)
}

/**
 * The `where` fragment that keeps a project-scoped statement to the projects
 * the caller works in. `false` when there are none, rather than an `in ()`
 * Postgres will not parse or a condition left out, which would widen the
 * statement to the whole company.
 */
export function inProjects(column: PgColumn, principal: Principal): SQL {
  const ids = projectIdsOf(principal)
  return ids.length === 0 ? sql`false` : inArray(column, ids)
}

/** What a request that names a project out of reach is told; the same sentence wherever the id came from. */
const NOT_A_PROJECT = "Not a project this account works in"

/**
 * Holds a project a request named to the ones the caller works in, or refuses
 * the request with a 400 naming the field — the validator's own shape, since
 * this is the same kind of "that value will not do" and only the principal
 * could tell. `path` is where the id sat (`projectId` on a create body, a
 * dotted path inside a list), and `target` says which part of the request it
 * sat in, so a list filtered by `?projectId=` is not told its body is wrong.
 */
export function requireProject(principal: Principal, projectId: string, path = "projectId", target: "body" | "query" = "body"): void {
  if (projectIdsOf(principal).includes(projectId)) return
  throw problem(400, { detail: `The request ${target} is invalid`, errors: [{ path, message: NOT_A_PROJECT }] })
}
