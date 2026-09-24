// The editable side of a project's holiday list (issue #36, 2026-09-24): the
// per-year Collection Calendar record read as dated, named entries, the two
// values the editor writes back, the year a record covers, and the proposals
// — next year's list carried from this year's, or a first year from what the
// list's lookup knows. The dates stay where every reader finds them
// (`holidayDates`, holidays.ts); the names go beside them under
// `holidayNames`, so a record that has been edited here names its own
// holidays and the lookup in holiday-names.ts is the fallback for one that
// never was. Pure data logic (type-only import of BusinessRecord).

import type { BusinessRecord } from "../prototype-record"
import { calendarFromRecord } from "./calendar"
import { formatValidity } from "./calendar-list"
import type { HolidayNameLookup } from "./holiday-names"
import { HOLIDAY_NAMES_KEY, parseHolidayNames, serializeHolidayNames } from "./holidays"
import { addDays, isIsoDate } from "./recurrence"

/** One holiday on a list: its ISO date and its name, "" while it has none. */
export type HolidayEntry = {
  date: string
  name: string
}

const byDate = (a: HolidayEntry, b: HolidayEntry) => a.date.localeCompare(b.date)

/**
 * The record's holidays as entries, in date order: a name the record carries
 * first, else what the list's lookup says, else unnamed. No structured
 * values, no entries.
 */
export function calendarHolidayEntries(
  record: BusinessRecord | undefined | null,
  names: HolidayNameLookup,
): HolidayEntry[] {
  const calendar = calendarFromRecord(record)
  if (!calendar) return []
  const carried = parseHolidayNames(record?.submittedValues?.[HOLIDAY_NAMES_KEY])
  return calendar.holidayDates.map((date) => ({
    date,
    name: carried.get(date) ?? names(date) ?? "",
  }))
}

/**
 * The values the editor writes: the dates in the spelling every reader
 * parses (sorted, one entry per date, the first name kept), and the names
 * that were given. Blank when there is nothing, which the readers treat as
 * absent.
 */
export function holidayEntryValues(entries: readonly HolidayEntry[]): {
  holidayDates: string
  holidayNames: string
} {
  const names = new Map<string, string>()
  const dates: string[] = []
  for (const entry of [...entries].sort(byDate)) {
    if (!isIsoDate(entry.date) || dates.includes(entry.date)) continue
    dates.push(entry.date)
    const name = entry.name.trim()
    if (name) names.set(entry.date, name)
  }
  return { holidayDates: dates.join(", "), holidayNames: serializeHolidayNames(names) }
}

/** Every date of the year the lookup names, in order. */
export function knownHolidaysOfYear(year: number, names: HolidayNameLookup): HolidayEntry[] {
  const entries: HolidayEntry[] = []
  const prefix = `${year}-`
  for (let date = `${year}-01-01`; date.startsWith(prefix); date = addDays(date, 1)) {
    const name = names(date)
    if (name !== undefined) entries.push({ date, name })
  }
  return entries
}

/**
 * This year's holidays placed in another year. A holiday keeps its month and
 * day when the lookup calls that day by the same name (a fixed holiday), else
 * it lands on the one day of the year the lookup gives its name to (a
 * moveable feast), else it keeps its month and day for the person to correct
 * — a lunar holiday, or one the list does not know. A day the year does not
 * have is dropped, and one date is one entry.
 */
export function carryHolidaysToYear(
  entries: readonly HolidayEntry[],
  year: number,
  names: HolidayNameLookup,
): HolidayEntry[] {
  const known = knownHolidaysOfYear(year, names)
  const carried = new Map<string, string>()
  for (const entry of entries) {
    const sameDay = `${year}-${entry.date.slice(5)}`
    const placed =
      entry.name && isIsoDate(sameDay) && names(sameDay) === entry.name
        ? sameDay
        : (onlyDateNamed(known, entry.name) ?? (isIsoDate(sameDay) ? sameDay : undefined))
    if (placed && !carried.has(placed)) carried.set(placed, entry.name)
  }
  return [...carried.entries()].map(([date, name]) => ({ date, name })).sort(byDate)
}

function onlyDateNamed(known: readonly HolidayEntry[], name: string): string | undefined {
  if (!name) return undefined
  const dates = known.filter((entry) => entry.name === name)
  return dates.length === 1 ? dates[0].date : undefined
}

/** The year a record covers: its validity start's, else its first holiday's. */
export function calendarYear(record: BusinessRecord | undefined | null): number | undefined {
  const calendar = calendarFromRecord(record)
  const iso = calendar?.validFrom || calendar?.holidayDates[0]
  return iso ? Number(iso.slice(0, 4)) : undefined
}

/** The record covering the latest year — the one "Create next year" continues from. */
export function latestHolidayCalendar(
  records: readonly BusinessRecord[],
): BusinessRecord | undefined {
  return [...records]
    .filter((record) => calendarYear(record) !== undefined)
    .sort(
      (a, b) =>
        (calendarYear(b) ?? 0) - (calendarYear(a) ?? 0) ||
        (calendarFromRecord(b)?.validFrom ?? "").localeCompare(calendarFromRecord(a)?.validFrom ?? ""),
    )[0]
}

export type YearProposal = {
  year: number
  /** The record's name — the previous one with its year moved on, or the project's with the year. */
  calendarName: string
  /** The whole year, whatever the previous record covered. */
  validFrom: string
  validTo: string
  entries: HolidayEntry[]
}

const proposal = (calendarName: string, year: number, entries: HolidayEntry[]): YearProposal => ({
  year,
  calendarName,
  validFrom: `${year}-01-01`,
  validTo: `${year}-12-31`,
  entries,
})

/** Next year's record from this year's, or null for a record with no year. */
export function nextYearProposal(
  record: BusinessRecord,
  names: HolidayNameLookup,
): YearProposal | null {
  const previous = calendarYear(record)
  if (previous === undefined) return null
  const year = previous + 1
  const calendarName = record.name.includes(String(previous))
    ? record.name.replace(String(previous), String(year))
    : `${record.name} ${year}`
  return proposal(
    calendarName,
    year,
    carryHolidaysToYear(calendarHolidayEntries(record, names), year, names),
  )
}

/** A project's first record: named after the project, seeded with what the list knows. */
export function firstYearProposal(
  projectName: string,
  year: number,
  names: HolidayNameLookup,
): YearProposal {
  return proposal(`${projectName} ${year}`, year, knownHolidaysOfYear(year, names))
}

export type ValidityPeriod = {
  validFrom: string
  validTo: string
}

/**
 * Why a date cannot go on the list, in a sentence, or null when it can: not
 * a calendar day, already listed (the entry being edited excepted), or
 * outside the period the record covers.
 */
export function holidayEntryIssue(
  entries: readonly HolidayEntry[],
  date: string,
  validity: ValidityPeriod | null,
  editingDate?: string,
): string | null {
  if (!isIsoDate(date)) return "Enter a date as yyyy-mm-dd."
  if (date !== editingDate && entries.some((entry) => entry.date === date)) {
    return "This date is already on the list."
  }
  if (validity) {
    const before = validity.validFrom !== "" && date < validity.validFrom
    const after = validity.validTo !== "" && date > validity.validTo
    if (before || after) {
      const period = formatValidity(validity.validFrom, validity.validTo)
      return validity.validFrom && validity.validTo
        ? `This list covers ${period}.`
        : `This list runs ${period.charAt(0).toLowerCase()}${period.slice(1)}.`
    }
  }
  return null
}
