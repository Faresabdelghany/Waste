// The project's clock and calendar as a statement reads them, spelled once
// for the API, the worker and the commands (lifted from `apps/api/src/routes/
// fleet-lookups.ts` with the commands the worker runs, Issue #112 part B; the
// SQL twins and the calendar read since #574): its timezone, what an instant
// is rendered as a day in (@waste/domain/clock); its currency, ISO 4217 as the
// contracts checked it; today on its clock; and its calendar, the weekend it
// rests on and the holidays of the list it names. The project is the
// caller's — proved under the request's scope a moment ago, or the one a job's
// event names — so its absence here is a bug and is thrown.
//
// A statement that judges on the project's clock spells it through the SQL
// twins below, never `at time zone` by hand: `dayOnClock` is `dayInTimezone`,
// `timeOnClock` `timeInTimezone`, `instantOnClock` `instantOnDay`, and
// `project-clock.test.ts` holds each to its twin over clock changes and
// timezones either side of UTC. The instant a statement judges "now" on is
// the caller's injected clock (`instantAt`), never Postgres's `now()`, so a
// test or a request pinned to a clock sees one clock.
//
// A project's holidays are the days of the company's Holiday List the project
// names (`project.holiday_list`, a key into `holiday_list` by name), each with
// the name a person gave it, else the known list's own (`holidayListOf`,
// @waste/domain/planning/generation). Every reader of a project's calendar —
// generation, the occurrence read, a route's operating day, the held routes a
// change re-decides, the collection days, the public map and the bulky
// bookings — reads it through `readProjectCalendar`; a project without a list
// has no holidays.
import { dayInTimezone } from "@waste/domain/clock"
import { NO_HOLIDAYS } from "@waste/domain/days"
import { holidayListOf } from "@waste/domain/planning/generation"
import type { SchemeCalendar } from "@waste/domain/planning/occurrences"
import { and, asc, eq, gte, inArray, lte, sql, type SQL, type SQLWrapper } from "drizzle-orm"

import type { Tx } from "../client"
import { holidayList, holidayListHoliday, project } from "../schema/organisation"

/** A company and one of its projects: what every project-scoped statement is bounded by. */
export type Scope = { companyId: string; projectId: string }

/** The project's timezone, an IANA name the contracts checked on the way in. */
export async function projectTimezone(tx: Tx, companyId: string, projectId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`projectTimezone: no project ${projectId} in company ${companyId}`)
  return row.timezone
}

/** The project's currency: what a price list defaults to and a default list must be in, and what a provider price is quoted in. */
export async function projectCurrency(tx: Tx, companyId: string, projectId: string): Promise<string> {
  const [row] = await tx
    .select({ currency: project.currency })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`projectCurrency: no project ${projectId} in company ${companyId}`)
  return row.currency
}

/** Today on a project's clock, asked for at most once per request or job. */
export type Today = () => Promise<string>

/**
 * Today on the project's clock — the caller's `now` rendered as a day in
 * `project.timezone` — read once, however many times it is asked, and not at
 * all when nobody asks: a Collection Group's licence day, a billing run's
 * `issuedOn`, a credit note's. The clock is the caller's and never
 * `new Date()` here, so a test pins the day.
 */
export function projectToday(tx: Tx, scope: Scope, now: () => Date): Today {
  let today: Promise<string> | undefined
  return () => (today ??= projectTimezone(tx, scope.companyId, scope.projectId).then((timezone) => dayInTimezone(now(), timezone)))
}

/** Each of the projects' timezones, by project id, one statement for them all; a project asked for that is not the company's is thrown. */
export async function projectTimezones(tx: Tx, companyId: string, projectIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const asked = [...new Set(projectIds)]
  if (asked.length === 0) return new Map()
  const rows = await tx
    .select({ id: project.id, timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), inArray(project.id, asked)))
  const zones = new Map(rows.map((row) => [row.id, row.timezone]))
  const missing = asked.find((id) => !zones.has(id))
  if (missing !== undefined) throw new Error(`projectTimezones: no project ${missing} in company ${companyId}`)
  return zones
}

/** Today on each of the projects' clocks at `now`, by project id. */
export async function projectTodays(tx: Tx, companyId: string, projectIds: readonly string[], now: Date): Promise<ReadonlyMap<string, string>> {
  const zones = await projectTimezones(tx, companyId, projectIds)
  return new Map([...zones].map(([id, timezone]) => [id, dayInTimezone(now, timezone)]))
}

/* ------------------------------ the SQL twins ------------------------------ */

/** The caller's instant as a statement's `timestamptz`: what a statement judges "now" on, in place of Postgres's `now()`. */
export const instantAt = (at: Date): SQL => sql`${at.toISOString()}::timestamptz`

/**
 * An instant (a `timestamptz`) as text, UTC to the microsecond as Postgres
 * holds it (`2026-10-01T05:30:00.123456Z`): `toISOString` with the
 * microseconds, which `Date.parse` reads back whatever the session's style —
 * what a key or a row read as text spells an instant by.
 */
export const utcInstantText = (instant: SQLWrapper): SQL<string> => sql<string>`to_char((${instant}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** The day `instant` (a `timestamptz`) falls on, on the clock of `timezone` (a column or a value naming one): `dayInTimezone` in SQL, a `date`. */
export const dayOnClock = (instant: SQLWrapper, timezone: SQLWrapper): SQL<string> => sql<string>`(${instant} at time zone ${timezone})::date`

/** Today on the clock of `timezone` at the caller's `now`: `projectToday` in SQL, a `date`. */
export const todayOnClock = (now: Date, timezone: SQLWrapper): SQL<string> => dayOnClock(instantAt(now), timezone)

/** The time of day `instant` reads on the clock of `timezone`, to the minute (`06:00`): `timeInTimezone` in SQL, as text. */
export const timeOnClock = (instant: SQLWrapper, timezone: SQLWrapper): SQL<string> => sql<string>`to_char(${instant} at time zone ${timezone}, 'HH24:MI')`

/** The day and the time `instant` reads on the clock of `timezone`, as a person reads them (`2026-10-01 05:30`), as text. */
export const shownOnClock = (instant: SQLWrapper, timezone: SQLWrapper): SQL<string> => sql<string>`to_char(${instant} at time zone ${timezone}, 'YYYY-MM-DD HH24:MI')`

/**
 * The instant a time of a project's day falls at, a `timestamptz`: `time` (a
 * `time` column, midnight when none is given) of `day` (a `date` column or a
 * `YYYY-MM-DD` value) on the clock of `timezone` — `instantOnDay` in SQL, a
 * time the clocks skip read in the offset before the change.
 */
export function instantOnClock(day: SQLWrapper | string, timezone: SQLWrapper, time?: SQLWrapper): SQL {
  const local = time === undefined ? sql`(${day})::date::timestamp` : sql`((${day})::date + ${time})`
  return sql`(${local} at time zone ${timezone})`
}

/* ------------------------------- the calendar ------------------------------ */

/** Both ends included, as ISO days; none reads every holiday of the list. */
export type HolidayWindow = { from?: string; to?: string }

/**
 * The project's calendar: the weekend it rests on, and the holidays of the
 * list it names inside the window, in date order, named as generation names
 * them; none for a project without a list. Fenced by the company: the caller's
 * transaction carries its tenant, and the key says it again.
 */
export async function readProjectCalendar(tx: Tx, scope: Scope, window: HolidayWindow = {}): Promise<SchemeCalendar> {
  const [row] = await tx
    .select({ weekend: project.weekend, holidayList: project.holidayList })
    .from(project)
    .where(and(eq(project.companyId, scope.companyId), eq(project.id, scope.projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`readProjectCalendar: no project ${scope.projectId} in company ${scope.companyId}`)
  if (row.holidayList === null) return { weekend: row.weekend, holidays: NO_HOLIDAYS }
  const conditions: SQL[] = [eq(holidayList.companyId, scope.companyId), eq(holidayList.name, row.holidayList)]
  if (window.from !== undefined) conditions.push(gte(holidayListHoliday.day, window.from))
  if (window.to !== undefined) conditions.push(lte(holidayListHoliday.day, window.to))
  const days = await tx
    .select({ day: holidayListHoliday.day, name: holidayListHoliday.name })
    .from(holidayListHoliday)
    .innerJoin(holidayList, and(eq(holidayList.companyId, holidayListHoliday.companyId), eq(holidayList.id, holidayListHoliday.holidayListId)))
    .where(and(...conditions))
    .orderBy(asc(holidayListHoliday.day))
  return { weekend: row.weekend, holidays: holidayListOf(days, row.holidayList) }
}
