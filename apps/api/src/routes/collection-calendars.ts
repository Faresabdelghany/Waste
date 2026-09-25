// When work may not happen (Issue #97, ADR-0002, ADR-0005): the Collection
// Calendar and its holidays. `GET /collection-calendars` lists them, `POST
// /collection-calendars` writes one, `GET`/`PATCH /collection-calendars/:id`
// read and amend one and `PUT /collection-calendars/:id/holidays` replaces
// the days it rests on. No delete: a calendar ends by its period, and a year
// that is over is history a generation run may still be asked about.
//
// A calendar is effective-dated and a project has one in force at a time —
// the per-year records tile the project's timeline, which the database holds
// with an exclusion constraint over the project alone — so a Route Scheme
// reads its project's calendars and never picks one, and `?validOn=` is how a
// caller asks which one a day falls in. `refuseOverlap` gives that constraint
// its sentence; the name's key gets its own through `refuseDuplicate`.
//
// The holidays are the set that travels with the record, in the sense of
// routes/members.ts: read with the calendar, sorted by day, and replaced
// whole, since "add one, remove one" over a list the client already holds is
// two requests that can disagree. They are not members.ts's mechanics,
// though — an entry there is a row named by id with a role, and a holiday is
// a day with a name and names no row — so the same four steps are spelled
// here as a sibling: a page loads every calendar's holidays in one query and
// groups them, a set is held to its rule in memory, and the replacement is
// delete-then-insert inside the request's one transaction, the record's own
// row stamped first so the PUT answers "no such calendar" the same way every
// other route does and `updatedAt` moves, since the set is part of the
// calendar on the wire.
//
// The rule the set is held to is containment, the day inside the period,
// and like routes/periods.ts it has two sides: a holiday put outside the
// calendar's period is a 400 naming the entry (`holidays.N.day`), since the
// caller chose it; a period shortened under its holidays is a 409 counting
// them (`refuseStranded`, routes/periods.ts, handed the `where` over the
// day), since the rows in the way are not in the body and have to be removed
// first. Postgres cannot say a child's day lies inside its parent's period
// without a trigger, so the API says it, under the calendar's row lock
// (`lockRow`, routes/shared.ts) on the patch — the PUT's own stamping update
// takes the same lock — so a shortening and a replacement serialise on the
// row and neither passes on a state the other has not written. The
// contracts already refuse two holidays on one day (a 400 on `holidays`, not
// the key's 409), and hold a create body's holidays inside its own period
// where they can see both; the PUT's body has no period, so the same
// predicate (`holidaysOutside`) and the same sentence (`OUTSIDE_CALENDAR_PERIOD`)
// run here against the stored row, and a client reads one answer whichever
// noticed. A write answers the set it was handed, sorted the way the table
// reads it back — by day, which a set names once — rather than reading it
// again: the rows carry nothing the database adds.
//
// The rest is the shape every project-scoped family has: each statement
// carries the tenant and `inProjects` (auth/projects.ts), a create names a
// project the caller works in and a record never moves between projects.
// Whether the holidays are read at all is the Project's `holidayList`
// (routes/projects.ts): a project with none rests on its weekend only,
// whatever calendars it has.
//
// The grant is `configure.calendars` throughout, holidays included: a holiday
// is a line of a calendar and not a surface of its own.
import {
  CollectionCalendar,
  CollectionCalendarCreate,
  CollectionCalendarHolidaysSet,
  CollectionCalendarListQuery,
  CollectionCalendarPatch,
  holidaysOutside,
  OUTSIDE_CALENDAR_PERIOD,
  type CollectionCalendarHoliday,
} from "@waste/contracts/collection-calendars"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { collectionCalendar, collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { count } from "@waste/domain/text"
import { and, asc, eq, gt, gte, inArray, lt, or } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { periodAfter, refuseStranded, requireOrdered, type Period } from "./periods"
import { describeJson, IdParam, lockRow, refuseDuplicate, refuseOverlap, stamp, stampsOf } from "./shared"

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

/** One holiday as the wire and the table both spell it: a day, and a name or null. */
type Holiday = CollectionCalendarHoliday

/** The calendar a set hangs on, and the scope every row of the set inherits from it. */
type Parent = { companyId: string; projectId: string; id: string }

/** The row on the wire, with the holidays the page loaded for it, by day. */
function calendarOf(row: Row, holidays: readonly Holiday[]): CollectionCalendar {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    holidays: [...holidays],
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

/** What a period the holidays do not fit inside is refused with; the rows in the way are not in the body, so the caller removes them first. */
const strandedHolidays = (rows: number) =>
  `${count(rows, "holiday")} ${rows === 1 ? "falls" : "fall"} outside the new period; remove ${rows === 1 ? "it" : "them"} first`

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

/**
 * Holds a whole list of holidays to the calendar's period, or refuses the
 * request naming every entry that lies outside, at the path the body spelled
 * it — the contracts' own predicate and sentence (`holidaysOutside`,
 * `OUTSIDE_CALENDAR_PERIOD`), which the create schema runs where it can see
 * the period and this runs where only the stored row knows it. Every entry
 * rather than the lowest, because the check is in memory and a form can mark
 * them all at once.
 */
function requireHolidaysWithin(period: Period, holidays: readonly Holiday[]): void {
  const errors = holidaysOutside(period, holidays).map((n) => ({ path: `holidays.${n}.day`, message: OUTSIDE_CALENDAR_PERIOD }))
  if (errors.length > 0) throw invalidRequest("body", errors)
}

/** The body's holidays in the order the table reads them back — by day, which a set names once — so what a write answers is what the next read says, without reading. */
const byDay = (holidays: readonly Holiday[]): Holiday[] => [...holidays].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

/**
 * The holidays of a whole page in one query, grouped by calendar and sorted
 * by day: a list of fifty calendars is two statements, never fifty-one. The
 * order is the same for a page, a single read and the answer to a write, so
 * what a write answers is what the next read says.
 */
async function holidaysOf(tx: Tx, companyId: string, calendarIds: readonly string[]): Promise<Map<string, Holiday[]>> {
  const byCalendar = new Map<string, Holiday[]>()
  if (calendarIds.length === 0) return byCalendar
  const rows = await tx
    .select({ calendar: collectionCalendarHoliday.collectionCalendarId, day: collectionCalendarHoliday.day, name: collectionCalendarHoliday.name })
    .from(collectionCalendarHoliday)
    .where(and(eq(collectionCalendarHoliday.companyId, companyId), inArray(collectionCalendarHoliday.collectionCalendarId, [...calendarIds])))
    .orderBy(asc(collectionCalendarHoliday.day))
  for (const row of rows) {
    const holiday: Holiday = { day: row.day, name: row.name }
    const found = byCalendar.get(row.calendar)
    if (found === undefined) byCalendar.set(row.calendar, [holiday])
    else found.push(holiday)
  }
  return byCalendar
}

/** One calendar's holidays, read the way a page reads them. */
async function holidaysFor(tx: Tx, companyId: string, calendarId: string): Promise<Holiday[]> {
  return (await holidaysOf(tx, companyId, [calendarId])).get(calendarId) ?? []
}

/** Writes the holidays a calendar starts with, or the set that replaces them. Nothing to write is no statement. */
async function writeHolidays(tx: Tx, parent: Parent, holidays: readonly Holiday[]): Promise<void> {
  if (holidays.length === 0) return
  await tx.insert(collectionCalendarHoliday).values(
    holidays.map((holiday) => ({
      id: newId(),
      companyId: parent.companyId,
      projectId: parent.projectId,
      collectionCalendarId: parent.id,
      day: holiday.day,
      name: holiday.name,
    })),
  )
}

/**
 * The `where` of the holidays a calendar's move would strand, for
 * `refuseStranded` (routes/periods.ts): this company's rows of the calendar
 * on a day the new period does not cover — before the start, or on or after
 * the end where there is one. A holiday is a day and not a period, which is
 * why this is not `notWithin`.
 */
const strandedHolidayDays = (parent: { companyId: string; id: string }, period: Period) => {
  const before = lt(collectionCalendarHoliday.day, period.validFrom)
  const outside = period.validTo === null ? before : or(before, gte(collectionCalendarHoliday.day, period.validTo))
  return and(eq(collectionCalendarHoliday.companyId, parent.companyId), eq(collectionCalendarHoliday.collectionCalendarId, parent.id), outside)
}

/** One calendar on the wire, its holidays read back the way a page reads them, so an answer equals the next read. */
async function calendarWithHolidays(tx: Tx, companyId: string, row: Row): Promise<CollectionCalendar> {
  return calendarOf(row, await holidaysFor(tx, companyId, row.id))
}

export function collectionCalendarRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/collection-calendars",
      describeRoute({
        operationId: "listCollectionCalendars",
        summary: "The collection calendars of the caller's projects",
        description:
          "One page of collection calendars, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page — each with its holidays by day. `projectId` narrows it to one of those projects; naming another is refused. `validOn` asks for the calendars in force on that day, `validFrom` inclusive and `validTo` exclusive: at most one per project, since a project has one calendar at a time. Hand `nextCursor` back as `cursor` for the next page.",
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
        // Paged first, so the row that only proves there is a next page is
        // not one of the calendars whose holidays are loaded.
        const { items, nextCursor } = pageOf(rows, limit)
        const held = await holidaysOf(tx, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => calendarOf(row, held.get(row.id) ?? [])), nextCursor })
      },
    )
    .post(
      "/collection-calendars",
      describeRoute({
        operationId: "createCollectionCalendar",
        summary: "Write a collection calendar",
        description:
          "Writes a collection calendar in one project, which must be a project the caller works in. The name is unique inside the project. The period is half-open — `validFrom` is the first day in force and `validTo` the first day out of it, absent meaning the calendar is still running — and a project has one calendar in force at a time, so a period overlapping the project's other calendar is refused (409): the per-year calendars tile the project's timeline, and the next begins where the earlier one ends. `holidays` is the list the calendar starts with, each a day inside the period (400 on `holidays.N.day` otherwise) and each day named once (400 on `holidays`); the name of a holiday may be null. The server mints the ids.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The calendar as it was written, with its holidays by day.", CollectionCalendar),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, ends on or before the day it starts, names the same day twice, carries more than 400 holidays, or puts a holiday outside the calendar's period.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `configure.calendars`."),
          409: describeProblem("The project already has a calendar with that name, or one in force over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", CollectionCalendarCreate),
      async (c) => {
        const { holidays, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const [row] = await refuseOverlap({ [CALENDAR_RUNNING]: CALENDAR_RUNNING_SENTENCE }, () =>
          refuseDuplicate({ [NAME_TAKEN]: nameTaken(values.name) }, () =>
            tx
              .insert(collectionCalendar)
              .values({ ...values, id: newId(), companyId: principal.companyId })
              .returning(columns),
          ),
        )
        await writeHolidays(tx, { companyId: principal.companyId, projectId: row.projectId, id: row.id }, holidays)
        return c.json(calendarOf(row, byDay(holidays)), 201)
      },
    )
    .get(
      "/collection-calendars/:id",
      describeRoute({
        operationId: "getCollectionCalendar",
        summary: "One collection calendar",
        description:
          "One collection calendar of a project the caller works in, with its holidays by day. A calendar of another company, or of a project this account does not work in, is a calendar that does not exist here.",
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
        return c.json(await calendarWithHolidays(tx, principal.companyId, row))
      },
    )
    .patch(
      "/collection-calendars/:id",
      describeRoute({
        operationId: "patchCollectionCalendar",
        summary: "Amend a collection calendar",
        description:
          "Changes the name or the period of one collection calendar of a project the caller works in; every field is optional and at least one must be given. The project is not patchable, since a record does not move between projects, and the holidays are a set, so they are `PUT /collection-calendars/{id}/holidays`. Moving the period is held to three rules: the end still comes after the start, which a body naming one bound cannot see by itself; the new period still holds every holiday of the calendar — a shortening that would leave one outside is refused (409) counting them, and the holidays have to be removed first; and the period may not overlap the project's other calendar (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The calendar as it now stands, with its holidays.", CollectionCalendar),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the project and the holidays included), or ends on or before the day it starts."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.calendars`."),
          404: describeProblem("No collection calendar with that id in the projects this account works in."),
          409: describeProblem("Holidays of the calendar would fall outside the new period, the project already has another calendar with that name, or one in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", CollectionCalendarPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row this patch counts holidays against, locked before it is
        // read: a shortening and a replacement of the set are the two halves
        // of one rule, and they serialise here (routes/shared.ts).
        await lockRow(tx, collectionCalendar, { companyId: principal.companyId, id })
        const current = await findCalendar(tx, principal, id)
        if (current === undefined) throw noSuchCalendar(id)

        if (patch.validFrom !== undefined || patch.validTo !== undefined) {
          const period = periodAfter(current, patch)
          requireOrdered(period)
          await refuseStranded(tx, collectionCalendarHoliday, strandedHolidayDays({ companyId: principal.companyId, id }, period), strandedHolidays)
        }

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
        return c.json(await calendarWithHolidays(tx, principal.companyId, row))
      },
    )
    .put(
      "/collection-calendars/:id/holidays",
      describeRoute({
        operationId: "putCollectionCalendarHolidays",
        summary: "Replace a calendar's holidays",
        description:
          "Replaces the whole list with the one in the body: a holiday the body leaves out is not a holiday afterwards, and an empty list is a year without holidays. Each entry is a day inside the calendar's period (400 on `holidays.N.day` otherwise) and a name or null, and each day is named once (400 on `holidays`). The calendar's `updatedAt` moves, since the holidays are part of the calendar on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The calendar with the holidays it now has.", CollectionCalendar),
          400: describeProblem(
            "The path does not hold an id, or the body is missing `holidays`, names a member it does not own, names the same day twice, carries more than 400 holidays, or puts a holiday outside the calendar's period.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `configure.calendars`."),
          404: describeProblem("No collection calendar with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", CollectionCalendarHolidaysSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { holidays } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The calendar's own row is stamped first: the set is part of the
        // calendar on the wire, so replacing it changes the calendar, the
        // update is what says so, and it is also what answers "no such
        // calendar here" — it runs the caller's own scope. It takes the row
        // lock too, so a patch shortening the period waits for this or this
        // for it, and the period read back is the one the days are held to.
        const [row] = await tx
          .update(collectionCalendar)
          .set(stamp())
          .where(and(scope(principal), eq(collectionCalendar.id, id)))
          .returning(columns)
        if (row === undefined) throw noSuchCalendar(id)
        requireHolidaysWithin(row, holidays)
        await tx
          .delete(collectionCalendarHoliday)
          .where(and(eq(collectionCalendarHoliday.companyId, principal.companyId), eq(collectionCalendarHoliday.collectionCalendarId, id)))
        await writeHolidays(tx, { companyId: principal.companyId, projectId: row.projectId, id: row.id }, holidays)
        return c.json(calendarOf(row, byDay(holidays)))
      },
    )
}
