// A company's Holiday List as a record (Settings › Operations › Holiday
// lists, 2026-11-05): one per country, named, with its dated, named
// holidays across every year, which a Project rests on by naming it
// (`holidayList`, project-calendar.ts). The record rides in the Collection
// Calendars module (`configure.calendars`) beside the per-year calendars,
// told apart by its kind; its dates and names are spelled as a calendar's
// are — `holidayDates` and `holidayNames` (holidays.ts) — so the readers
// that already parse a calendar's holidays parse a list's. Pure data logic
// (type-only import of BusinessRecord).

import type { BusinessRecord } from "../prototype-record"
import { typedString } from "../record-values"
import { parseHolidayDates } from "./calendar"
import { holidayNamesForCountry } from "./holiday-names"
import type { HolidayEntry } from "./holiday-lists"
import { HOLIDAY_NAMES_KEY, parseHolidayNames } from "./holidays"

/** The record kind a holiday list carries. */
export const HOLIDAY_LIST_KIND = "Holiday List"
/** The id prefix a holiday list carries: `holiday-list-<uuid>` on the Pilot. */
export const HOLIDAY_LIST_PREFIX = "holiday-list"

/** The typed values a holiday list record keeps. */
export const HOLIDAY_LIST_KEYS = {
  name: "listName",
  country: "country",
  dates: "holidayDates",
  names: HOLIDAY_NAMES_KEY,
} as const

type RecordLike = Pick<BusinessRecord, "id" | "recordKind">

/** Whether the record is a holiday list, not a per-year calendar beside it. */
export function isHolidayListRecord(record: RecordLike): boolean {
  return record.recordKind === HOLIDAY_LIST_KIND || record.id.startsWith(`${HOLIDAY_LIST_PREFIX}-`)
}

/** The list's name, as a project names it. */
export function holidayListName(record: BusinessRecord): string {
  return typedString(record.submittedValues, HOLIDAY_LIST_KEYS.name) ?? record.name
}

/** The list's country, ISO 3166-1 alpha-2; undefined where the record names none. */
export function holidayListCountry(record: BusinessRecord): string | undefined {
  return typedString(record.submittedValues, HOLIDAY_LIST_KEYS.country)
}

/** The company's list of this name among the records, soft-deleted ones the caller has left out. */
export function holidayListNamed(name: string | null | undefined, records: readonly BusinessRecord[] | undefined): BusinessRecord | undefined {
  if (!name || !records) return undefined
  return records.find((record) => isHolidayListRecord(record) && holidayListName(record) === name)
}

/** Every holiday of the list in date order: a name it carries, else what its country's known list says, else unnamed. */
export function holidayListEntries(record: BusinessRecord): HolidayEntry[] {
  const carried = parseHolidayNames(record.submittedValues?.[HOLIDAY_LIST_KEYS.names])
  const known = holidayNamesForCountry(holidayListCountry(record))
  return parseHolidayDates(typedString(record.submittedValues, HOLIDAY_LIST_KEYS.dates))
    .sort()
    .map((date) => ({ date, name: carried.get(date) ?? known(date) ?? "" }))
}

/** The years the list holds a holiday in, latest first. */
export function holidayListYears(entries: readonly HolidayEntry[]): number[] {
  return [...new Set(entries.map((entry) => Number(entry.date.slice(0, 4))))].filter(Number.isInteger).sort((a, b) => b - a)
}
