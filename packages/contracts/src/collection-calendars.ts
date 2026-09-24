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
// whatever it holds. Whether each day lies inside the calendar's period is the
// route's question (a patch may move the period under the days), answered as
// a 400 on `holidays.N.day`.
//
// The prototype's `weekStart` and `timezone` are not here: the working week is
// the Project's (`weekend`) and so is the timezone. Whether the holidays are
// read at all is the Project's `holidayList`: a project with none rests on its
// weekend only, whatever calendars it has.
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, somethingToChange, stamped } from "./resource"
import { Label } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/** The most holidays a body may carry: a year's list, not an import. */
export const HOLIDAYS_MAX = 400

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
const noRepeatedDay = (holidays: readonly { day: string }[]): boolean => new Set(holidays.map((holiday) => holiday.day)).size === holidays.length

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
