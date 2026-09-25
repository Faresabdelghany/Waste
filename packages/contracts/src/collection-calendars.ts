// When work may not happen, on the wire (Issue #97): the Collection Calendar
// and its holidays. A calendar is effective-dated (ADR-0005) and a project has
// one in force at a time — the per-year records tile the project's timeline,
// which the database holds — so a Route Scheme reads its project's calendars
// and never picks one, and `CollectionCalendarListQuery.validOn` is how a
// caller asks which one a day falls in.
//
// The holidays travel with the calendar and are replaced whole: read with
// the record, sorted by day, and changed through `PUT …/holidays` with the
// whole list, since "add one, remove one" over a list the client already
// holds is two requests that can disagree. Each is a day and a name, the name
// null where nobody gave one (the prototype's JSON of date to name, #36,
// becomes rows). A set body refuses the same day twice, because the
// database's key refuses it as a duplicate and a 400 naming the rule is a
// better answer than a 409 naming a constraint; a body is bounded at 400
// entries — a year has a few dozen holidays, and more than that is an import —
// and the resource is not, since a calendar already stored has to read back
// whatever it holds. Each day lies inside the calendar's period: the create
// body carries both and holds it here (`withinPeriod`, refused at
// `holidays.N.day` with `OUTSIDE_CALENDAR_PERIOD`); the set body carries only
// the days and a patch only the period, so the route holds the rule for those
// against the stored row, in the same words.
//
// The prototype's `weekStart` and `timezone` are not here: the working week is
// the Project's (`weekend`) and so is the timezone. Whether the holidays are
// read at all is the Project's `holidayList`: a project with none rests on its
// weekend only, whatever calendars it has.
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { eachOnce } from "./planning"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, somethingToChange, stamped } from "./resource"
import { Label } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/** The most holidays a body may carry: a year's list, not an import. */
export const HOLIDAYS_MAX = 400

/** What a holiday on a day the calendar does not cover is told, at that entry's day. */
export const OUTSIDE_CALENDAR_PERIOD = "Outside the calendar's period"

/** Whether a day lies inside the half-open period: on or after the start, before the end; an open end covers every later day. */
export const withinPeriod = (period: { validFrom: string; validTo?: string | null }, day: string): boolean =>
  day >= period.validFrom && (period.validTo == null || day < period.validTo)

/**
 * The indexes, in body order, of the holidays whose day the period does not
 * cover: what the create schema (which sees the period in the same body) and
 * the set route (which reads it off the stored calendar) each turn into a 400
 * at `holidays.N.day` with `OUTSIDE_CALENDAR_PERIOD`, so the rule and the path
 * are spelled once.
 */
export const holidaysOutside = (period: { validFrom: string; validTo?: string | null }, holidays: readonly { day: string }[]): number[] =>
  holidays.flatMap((holiday, n) => (withinPeriod(period, holiday.day) ? [] : [n]))

/** One holiday: the day, and what it is called where somebody said. */
export const CollectionCalendarHoliday = z.strictObject({
  day: IsoDate,
  /** `Grundlovsdag`; null where nobody named it. */
  name: Label.nullable(),
})
export type CollectionCalendarHoliday = z.infer<typeof CollectionCalendarHoliday>

const Holidays = z.array(CollectionCalendarHoliday)
const HolidaysBody = Holidays.max(HOLIDAYS_MAX)

/** What a list with one day twice is told, and where. */
export const ONE_HOLIDAY_PER_DAY = "Name each day once: a calendar holds one holiday per day"
const oneHolidayPerDay = { message: ONE_HOLIDAY_PER_DAY, path: ["holidays"] }
const noRepeatedDay = (holidays: readonly { day: string }[]): boolean => eachOnce(holidays, (holiday) => holiday.day)

type Dated = { validFrom?: unknown; validTo?: unknown; holidays?: unknown }

/**
 * Every holiday of a create body lies inside the period the same body gives.
 * zod 4 runs a check on a body whose fields failed, so a half-seen body — no
 * start, no list, an entry without a day — is not judged here.
 */
const holidaysWithinPeriod = (body: Dated, ctx: z.RefinementCtx) => {
  const { validFrom, validTo, holidays } = body
  if (typeof validFrom !== "string" || !Array.isArray(holidays) || (validTo != null && typeof validTo !== "string")) return
  const dated: { day: string }[] = []
  for (const holiday of holidays as { day?: unknown }[]) {
    if (typeof holiday?.day !== "string") return
    dated.push({ day: holiday.day })
  }
  for (const n of holidaysOutside({ validFrom, validTo: validTo as string | null | undefined }, dated)) {
    ctx.addIssue({ code: "custom", message: OUTSIDE_CALENDAR_PERIOD, path: ["holidays", n, "day"] })
  }
}

export const CollectionCalendar = z
  .object({
    ...stamped,
    projectId: Id,
    /** What a person reads: `Copenhagen Central 2027`. Unique per project. */
    name: Label,
    /** The holidays of the period, by day; replaced whole through their own route. */
    holidays: Holidays,
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type CollectionCalendar = z.infer<typeof CollectionCalendar>

export const CollectionCalendarCreate = z
  .strictObject({
    projectId: Id,
    name: Label,
    holidays: HolidaysBody.default([]).describe("The holidays the calendar starts with, each inside its period; none when absent."),
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
  .refine((body) => noRepeatedDay(body.holidays), oneHolidayPerDay)
  .superRefine(holidaysWithinPeriod)
export type CollectionCalendarCreate = z.infer<typeof CollectionCalendarCreate>

/** The name and the period; the holidays are a set and are replaced whole. Whether the new period still holds every holiday is the route's question. */
export const CollectionCalendarPatch = z
  .strictObject({
    name: Label.optional(),
    validFrom: IsoDate.optional(),
    /** Null reopens the period; a day ends it. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
  .refine(validityOrdered, endsAfterItStarts)
export type CollectionCalendarPatch = z.infer<typeof CollectionCalendarPatch>

/** The whole list, replacing what the calendar had. An empty list is a year without holidays. */
export const CollectionCalendarHolidaysSet = z.strictObject({ holidays: HolidaysBody }).refine((body) => noRepeatedDay(body.holidays), oneHolidayPerDay)
export type CollectionCalendarHolidaysSet = z.infer<typeof CollectionCalendarHolidaysSet>

/** A page of calendars, from one project, in force on a day. */
export const CollectionCalendarListQuery = ProjectScopedListQuery.extend({
  /** The day the period is read against; absent asks for every calendar, whenever it ran. */
  validOn: IsoDate.optional(),
})
export type CollectionCalendarListQuery = z.infer<typeof CollectionCalendarListQuery>
