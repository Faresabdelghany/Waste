// The company's Holiday Lists on the wire (Settings › Operations › Holiday
// lists, 2026-11-05): one per country, with the days it rests on and their
// names, which every Project that rests on it names by the list's name
// (`Project.holidayList`). A list is the company's, not a project's, so two
// projects in one country share one list.
//
// The days travel with the list and are replaced whole:
// read with the list, sorted by day, and changed through `PUT …/holidays`
// with the whole set, since "add one, remove one" over a list the client
// already holds is two requests that can disagree. A body refuses the same
// day twice and carries at most `HOLIDAYS_MAX` — several years of holidays,
// not an import. The country is ISO 3166-1 alpha-2, checked by shape, once
// per company; so is the name.
import { HOLIDAYS_MAX, ONE_LISTED_HOLIDAY_PER_DAY } from "@waste/domain/planning/holiday-lists"
import { eachOnce } from "@waste/domain/requests"
import * as z from "zod"

import { Country } from "./codes"
import { IsoDate } from "./dates"
import { PageRequest } from "./pagination"
import { resourceBodies, stamped } from "./resource"
import { Label } from "./text"

export const HolidayListHoliday = z.strictObject({
  day: IsoDate,
  /** `Grundlovsdag`; null where nobody named it. */
  name: Label.nullable(),
})
export type HolidayListHoliday = z.infer<typeof HolidayListHoliday>

const Holidays = z.array(HolidayListHoliday)
const HolidaysBody = Holidays.max(HOLIDAYS_MAX)

const oneHolidayPerDay = { message: ONE_LISTED_HOLIDAY_PER_DAY, path: ["holidays"] }
const noRepeatedDay = (holidays: readonly { day: string }[]): boolean => eachOnce(holidays, (holiday) => holiday.day)

export const HolidayList = z.object({
  ...stamped,
  /** ISO 3166-1 alpha-2 (`DK`); once per company. */
  country: Country,
  /** What a person reads and a project names (`Danish public holidays`); once per company. */
  name: Label,
  /** Every day of the list, by day; replaced whole through their own route. */
  holidays: Holidays,
  /** How many of the company's projects rest on the list; one that any does cannot be deleted. */
  projectCount: z.number().int().nonnegative(),
})
export type HolidayList = z.infer<typeof HolidayList>

/** A patch takes the country and the name; the days are a set and are replaced whole. A rename follows to every project on the list. */
const holidayListBodies = resourceBodies(
  {
    country: Country,
    name: Label,
    holidays: HolidaysBody.default([]).describe("The days the list starts with; none when absent."),
  },
  { createOnly: { holidays: true } },
)

export const HolidayListCreate = holidayListBodies.create.refine((body) => noRepeatedDay(body.holidays), oneHolidayPerDay)
export type HolidayListCreate = z.infer<typeof HolidayListCreate>

export const HolidayListPatch = holidayListBodies.patch
export type HolidayListPatch = z.infer<typeof HolidayListPatch>

/** The whole set, replacing what the list had. An empty set is a list without holidays. */
export const HolidayListHolidaysSet = z.strictObject({ holidays: HolidaysBody }).refine((body) => noRepeatedDay(body.holidays), oneHolidayPerDay)
export type HolidayListHolidaysSet = z.infer<typeof HolidayListHolidaysSet>

export const HolidayListListQuery = PageRequest
export type HolidayListListQuery = z.infer<typeof HolidayListListQuery>
