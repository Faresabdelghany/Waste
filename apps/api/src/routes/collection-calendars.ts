// When work may not happen (Issue #97, ADR-0002, ADR-0005): the Collection
// Calendar. `GET /collection-calendars` lists them, `POST
// /collection-calendars` writes one, and `GET`/`PATCH
// /collection-calendars/:id` read and amend one. No delete: a calendar ends by
// its period, and a year that is over is history a generation run may still
// be asked about.
//
// A calendar is effective-dated and a project has one in force at a time —
// the per-year records tile the project's timeline, which the database holds
// with an exclusion constraint over the project alone — so a Route Scheme
// reads its project's calendars and never picks one, and `?validOn=` is how a
// caller asks which one a day falls in. `refuseOverlap` gives that constraint
// its sentence; the name's key gets its own through `refuseDuplicate`.
//
// A calendar carries no holidays (2026-11-05): a project's holidays are the
// days of the company's Holiday List it names (routes/holiday-lists.ts,
// `Project.holidayList`), and the calendar's own holidays, read by nothing
// once the lists came, were dropped with their `PUT …/holidays`.
//
// The rest is the shape every project-scoped family has: each statement
// carries the tenant and `inProjects` (auth/projects.ts), a create names a
// project the caller works in and a record never moves between projects.
//
// The grant is `configure.calendars` throughout.
import { CollectionCalendar, CollectionCalendarCreate, CollectionCalendarListQuery, CollectionCalendarPatch } from "@waste/contracts/collection-calendars"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { collectionCalendar } from "@waste/db/schema/collection-calendars"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { newId } from "@waste/db/ids"
import { refuseDuplicate, refuseOverlap } from "@waste/db/commands/shared"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { periodAfter, requireOrdered } from "./periods"
import { created, describeCreated, describeJson, IdParam, lockRow, stampsOf, strengthFor } from "./shared"

const MODULE = "configure.calendars"
const CollectionCalendarPage = Page(CollectionCalendar)

const columns = {
  id: collectionCalendar.id,
  projectId: collectionCalendar.projectId,
  name: collectionCalendar.name,
  validFrom: collectionCalendar.validFrom,
  validTo: collectionCalendar.validTo,
  createdAt: collectionCalendar.createdAt,
  updatedAt: collectionCalendar.updatedAt,
}

type Row = Pick<typeof collectionCalendar.$inferSelect, keyof typeof columns>

/** The row on the wire. */
function calendarOf(row: Row): CollectionCalendar {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** `unique (company_id, project_id, name)`: a name is one calendar's inside a project, and free in the next. */
const NAME_TAKEN = "collection_calendar_project_id_name_key"
const nameTaken = (name: string) => `This project already has a collection calendar called ${JSON.stringify(name)}`

/** `EXCLUDE USING gist (company_id, project_id, daterange)`: one calendar of a project is in force at a time, and the next may follow it. */
const CALENDAR_RUNNING = "collection_calendar_no_overlap"
const CALENDAR_RUNNING_SENTENCE = "This project already has a calendar in force over that period; a project has one calendar at a time"

const noSuchCalendar = (id: string) => problem(404, { detail: `No collection calendar ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every calendar statement is bounded by. */
const scope = (principal: Principal) =>
  and(eq(collectionCalendar.companyId, principal.companyId), inProjects(collectionCalendar.projectId, principal))

/** One calendar of this company by id, inside the caller's projects; undefined when it is neither. */
async function findCalendar(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(collectionCalendar)
    .where(and(scope(principal), eq(collectionCalendar.id, id)))
    .limit(1)
  return row
}

// The writes the routes and the calendars' CSV import (routes/import-rows.ts,
// O30 of #290) share, so an imported row is held to every rule a form's is and
// refused in the same sentence.

/** Writes a calendar in a project the caller works in. */
export async function createCalendar(tx: Tx, principal: Principal, body: CollectionCalendarCreate): Promise<CollectionCalendar> {
  requireProject(principal, body.projectId)
  const [row] = await refuseOverlap({ [CALENDAR_RUNNING]: CALENDAR_RUNNING_SENTENCE }, () =>
    refuseDuplicate({ [NAME_TAKEN]: nameTaken(body.name) }, () =>
      tx
        .insert(collectionCalendar)
        .values({ ...body, id: newId(), companyId: principal.companyId })
        .returning(columns),
    ),
  )
  return calendarOf(row)
}

/** Renames a calendar or moves its period, under its row lock. The 404 where the caller reaches no such calendar. */
export async function patchCalendar(tx: Tx, principal: Principal, id: string, patch: CollectionCalendarPatch): Promise<CollectionCalendar> {
  await lockRow(tx, collectionCalendar, { companyId: principal.companyId, id }, strengthFor(collectionCalendar, patch))
  const current = await findCalendar(tx, principal, id)
  if (current === undefined) throw noSuchCalendar(id)
  if (patch.validFrom !== undefined || patch.validTo !== undefined) requireOrdered(periodAfter(current, patch))

  const sentences: Record<string, string> = patch.name === undefined ? {} : { [NAME_TAKEN]: nameTaken(patch.name) }
  const [row] = await refuseOverlap({ [CALENDAR_RUNNING]: CALENDAR_RUNNING_SENTENCE }, () =>
    refuseDuplicate(sentences, () =>
      tx
        .update(collectionCalendar)
        .set(patch)
        .where(and(scope(principal), eq(collectionCalendar.id, id)))
        .returning(columns),
    ),
  )
  if (row === undefined) throw noSuchCalendar(id)
  return calendarOf(row)
}

/** A project's calendar with this name; undefined where there is none. */
export async function calendarByName(tx: Tx, principal: Principal, projectId: string, name: string): Promise<CollectionCalendar | undefined> {
  const [row] = await tx
    .select(columns)
    .from(collectionCalendar)
    .where(and(scope(principal), eq(collectionCalendar.projectId, projectId), eq(collectionCalendar.name, name)))
    .limit(1)
  return row === undefined ? undefined : calendarOf(row)
}

export function collectionCalendarRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/collection-calendars",
      describeRoute({
        operationId: "listCollectionCalendars",
        summary: "The collection calendars of the caller's projects",
        description:
          "One page of collection calendars, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `validOn` asks for the calendars in force on that day, `validFrom` inclusive and `validTo` exclusive: at most one per project, since a project has one calendar at a time. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of collection calendars.", CollectionCalendarPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `validOn` is not a calendar day, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.calendars`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", CollectionCalendarListQuery),
      async (c) => {
        const { limit, cursor, projectId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(collectionCalendar)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(collectionCalendar.projectId, projectId),
              day === undefined ? undefined : validOn(collectionCalendar, day),
              after === undefined ? undefined : gt(collectionCalendar.id, after),
            ),
          )
          .orderBy(asc(collectionCalendar.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(calendarOf), nextCursor })
      },
    )
    .post(
      "/collection-calendars",
      describeRoute({
        operationId: "createCollectionCalendar",
        summary: "Write a collection calendar",
        description:
          "Writes a collection calendar in one project, which must be a project the caller works in. The name is unique inside the project. The period is half-open — `validFrom` is the first day in force and `validTo` the first day out of it, absent meaning the calendar is still running — and a project has one calendar in force at a time, so a period overlapping the project's other calendar is refused (409): the per-year calendars tile the project's timeline, and the next begins where the earlier one ends. A calendar carries no holidays: a project's are the days of the company's holiday list it names. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The calendar as it was written.", CollectionCalendar),
          400: describeProblem(
            "The body is missing a field, names a member a calendar does not carry (its holidays among them), names a project this account does not work in, or ends on or before the day it starts.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.calendars`."),
          409: describeProblem("The project already has a calendar with that name, or one in force over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", CollectionCalendarCreate),
      async (c) => created(c, "/collection-calendars", await createCalendar(c.get("tx"), c.get("principal"), c.req.valid("json"))),
    )
    .get(
      "/collection-calendars/:id",
      describeRoute({
        operationId: "getCollectionCalendar",
        summary: "One collection calendar",
        description:
          "One collection calendar of a project the caller works in. A calendar of another company, or of a project this account does not work in, is a calendar that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The calendar.", CollectionCalendar),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `configure.calendars`."),
          404: describeProblem("No collection calendar with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findCalendar(tx, principal, id)
        if (row === undefined) throw noSuchCalendar(id)
        return c.json(calendarOf(row))
      },
    )
    .patch(
      "/collection-calendars/:id",
      describeRoute({
        operationId: "patchCollectionCalendar",
        summary: "Amend a collection calendar",
        description:
          "Changes the name or the period of one collection calendar of a project the caller works in; every field is optional and at least one must be given. The project is not patchable, since a record does not move between projects. Moving the period is held to two rules: the end still comes after the start, which a body naming one bound cannot see by itself; and the period may not overlap the project's other calendar (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The calendar as it now stands.", CollectionCalendar),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the project included), or ends on or before the day it starts."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.calendars`."),
          404: describeProblem("No collection calendar with that id in the projects this account works in."),
          409: describeProblem("The project already has another calendar with that name, or one in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", CollectionCalendarPatch),
      async (c) => c.json(await patchCalendar(c.get("tx"), c.get("principal"), c.req.valid("param").id, c.req.valid("json"))),
    )
}
