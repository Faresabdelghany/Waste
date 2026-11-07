// The editable side of a company's Holiday List (issue #36, 2026-09-24; the
// list a record of its own since 2026-11-05, holiday-list-records.ts): its
// dated, named entries, the two values the editor writes back, what the
// list's lookup knows of a year, and a year's holidays carried to the next.
// The dates are spelled as every reader parses them (`holidayDates`); the
// names go beside them under `holidayNames`, so a list that has been edited
// names its own holidays and the lookup in
// @waste/domain/planning/holiday-names is the fallback for one that
// never was. Pure data logic.

import { formatValidity } from "./calendar-list"
import type { HolidayNameLookup } from "@waste/domain/planning/holiday-names"
import { serializeHolidayNames } from "./holidays"
import { addDays, isIsoDate } from "@waste/domain/days"

/** One holiday on a list: its ISO date and its name, "" while it has none. */
export type HolidayEntry = {
  date: string
  name: string
}

const byDate = (a: HolidayEntry, b: HolidayEntry) => a.date.localeCompare(b.date)

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
