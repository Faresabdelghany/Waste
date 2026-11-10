/**
 * Holiday lists — the Settings pane that maintains the company's holiday
 * lists (issue #36, 2026-09-24; a list the company's own record since
 * 2026-11-05): the list a project names and the project's weekend on the
 * project record (`configure.organization`, read by resolveProjectCalendar),
 * and each list's dated, named holidays on its own record among the
 * calendars (`configure.calendars`, lib/prototype/route-schemes/
 * holiday-list-records). This module is the one place that knows how a
 * list's entries become record writes.
 */

import type { SubmittedValues } from "@/lib/prototype/prototype-record"
import { formatShortDay } from "@waste/domain/days"

import type { BusinessRecord } from "./business-modules"
import { countryName } from "./countries"
import { csvOf } from "./csv"
import { HOLIDAY_LIST_KEYS, HOLIDAY_LIST_KIND, holidayListCountry, holidayListEntries, holidayListName } from "@/lib/prototype/route-schemes/holiday-list-records"
import {
  carryHolidaysToYear,
  holidayEntryIssue,
  holidayEntryValues,
  type HolidayEntry,
} from "@/lib/prototype/route-schemes/holiday-lists"
import { holidayNamesForCountry } from "@waste/domain/planning/holiday-names"
import { type RecordOrdering } from "@/lib/prototype/business-filters"

// Since 2026-11-05 a holiday list is the company's own record, one per
// country (lib/prototype/route-schemes/holiday-list-records), which the pane
// lists in a table and opens into a table of its holidays. These are the
// record writes it makes; on the Pilot the store hands them to the adapter
// (lib/api/records/holiday-lists.ts), in fixture mode to the browser's bucket.

export type HolidayListDraft = {
  /** ISO 3166-1 alpha-2. */
  country: string
  name: string
}

function holidayListFacts(record: BusinessRecord, country: string, entries: readonly HolidayEntry[]): Record<string, string> {
  return { ...record.facts, Country: country, Holidays: String(entries.length) }
}

/**
 * A new list as a record, with the holidays it starts with: the clock read
 * here, the one impure step, kept out of the pane. Its id is the module's
 * minted one until the API answers with its own.
 */
export function createHolidayListRecord(
  draft: HolidayListDraft,
  entries: readonly HolidayEntry[],
  context: { actorName: string; now?: number },
): BusinessRecord {
  const now = context.now ?? Date.now()
  const { holidayDates, holidayNames } = holidayEntryValues(entries)
  const name = draft.name.trim()
  return {
    id: `calendars-holiday-list-${now}`,
    name,
    context: `${draft.country} · 0 projects`,
    status: "Active",
    owner: context.actorName,
    value: "—",
    updated: "Now",
    description: `The company's holiday list for ${draft.country}.`,
    facts: { Country: draft.country, Holidays: String(entries.length), Projects: "0" },
    related: [],
    source: "Settings",
    freshness: "Now",
    projectIds: [],
    recordKind: HOLIDAY_LIST_KIND,
    submittedValues: {
      [HOLIDAY_LIST_KEYS.name]: name,
      [HOLIDAY_LIST_KEYS.country]: draft.country,
      [HOLIDAY_LIST_KEYS.dates]: holidayDates,
      ...(holidayNames === "" ? {} : { [HOLIDAY_LIST_KEYS.names]: holidayNames }),
    },
  }
}

export function withHolidayListDraft(record: BusinessRecord, draft: HolidayListDraft): BusinessRecord {
  const name = draft.name.trim()
  return {
    ...record,
    name,
    updated: "Now",
    freshness: "Now",
    facts: holidayListFacts(record, draft.country, holidayListEntries(record)),
    submittedValues: { ...record.submittedValues, [HOLIDAY_LIST_KEYS.name]: name, [HOLIDAY_LIST_KEYS.country]: draft.country },
  }
}

export function withHolidayListEntries(record: BusinessRecord, entries: readonly HolidayEntry[]): BusinessRecord {
  const { holidayDates, holidayNames } = holidayEntryValues(entries)
  const submittedValues: SubmittedValues = { ...record.submittedValues, [HOLIDAY_LIST_KEYS.dates]: holidayDates }
  if (holidayNames === "") delete submittedValues[HOLIDAY_LIST_KEYS.names]
  else submittedValues[HOLIDAY_LIST_KEYS.names] = holidayNames
  return {
    ...record,
    updated: "Now",
    freshness: "Now",
    facts: holidayListFacts(record, holidayListCountry(record) ?? "", entries),
    submittedValues,
  }
}

/**
 * Why a date cannot be one of the list's holidays, in a sentence, or null
 * when it can: not a calendar day, or already on the list (the entry being
 * edited excepted). A list spans every year, so no period bounds it.
 */
export function holidayListEntryIssue(entries: readonly HolidayEntry[], date: string, editingDate?: string): string | null {
  return holidayEntryIssue(entries, date, null, editingDate)
}

/**
 * Next year's holidays from this year's, for "Copy to <year>": a fixed
 * holiday keeps its day, a moveable feast the country's known list names
 * lands on its day that year, and anything else keeps its month and day for
 * the person to correct. Dates the list already holds that year are left out.
 */
export function nextYearEntries(record: BusinessRecord, fromYear: number): HolidayEntry[] {
  const entries = holidayListEntries(record)
  const year = fromYear + 1
  const held = new Set(entries.map((entry) => entry.date))
  const thisYear = entries.filter((entry) => entry.date.startsWith(`${fromYear}-`))
  return carryHolidaysToYear(thisYear, year, holidayNamesForCountry(holidayListCountry(record))).filter((entry) => !held.has(entry.date))
}

/**
 * A list's status in the table, laid out as the Routes table is (search,
 * Filter, View, and a status per row): in use while a project rests on it —
 * which is also what holds its removal back — else not in use.
 */
export const HOLIDAY_LIST_STATUSES = ["In use", "Not in use"] as const
export type HolidayListStatus = (typeof HOLIDAY_LIST_STATUSES)[number]

/** The columns the View popover turns on and off, beside the list's name and status, which always show. */
export const HOLIDAY_LIST_OPTIONAL_COLUMNS = ["Holidays", "Next holiday", "Projects"] as const
export type HolidayListColumn = (typeof HOLIDAY_LIST_OPTIONAL_COLUMNS)[number]

export type HolidayListRow = {
  record: BusinessRecord
  name: string
  country: string | undefined
  /** The country's name, or "—" for a list that names none. */
  countryLabel: string
  holidays: number
  /** The next holiday on or after today, its day and name; "—" when none is ahead. */
  nextHoliday: string
  projects: number
  status: HolidayListStatus
}

export function shownHolidayName(entry: HolidayEntry, country: string | undefined): string {
  return entry.name || holidayNamesForCountry(country)(entry.date) || "Holiday"
}

export function holidayListRows(lists: readonly BusinessRecord[], projectCount: (list: BusinessRecord) => number, today: string): HolidayListRow[] {
  return lists.map((record) => {
    const country = holidayListCountry(record)
    const entries = holidayListEntries(record)
    const next = entries.find((entry) => entry.date >= today)
    const projects = projectCount(record)
    return {
      record,
      name: holidayListName(record),
      country,
      countryLabel: country ? countryName(country) : "—",
      holidays: entries.length,
      nextHoliday: next ? `${formatShortDay(next.date)} · ${shownHolidayName(next, country)}` : "—",
      projects,
      status: projects > 0 ? "In use" : "Not in use",
    }
  })
}

export function holidayListRowMatches(row: HolidayListRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === "") return true
  return [row.name, row.countryLabel, row.country ?? "", row.nextHoliday, row.status, row.record.description].join(" ").toLowerCase().includes(needle)
}

export function orderHolidayListRows(rows: readonly HolidayListRow[], ordering: RecordOrdering): HolidayListRow[] {
  const byName = (a: HolidayListRow, b: HolidayListRow) => a.name.localeCompare(b.name)
  const rank = (row: HolidayListRow) => HOLIDAY_LIST_STATUSES.indexOf(row.status)
  return [...rows].sort(ordering === "status" ? (a, b) => rank(a) - rank(b) || byName(a, b) : byName)
}

/** The rows the table shows as a CSV, by the columns it draws: the name, the description and the country where shown, the status, then each optional column shown. */
export function holidayListsCsv(
  rows: readonly HolidayListRow[],
  shown: { description: boolean; country: boolean; columns: readonly HolidayListColumn[] },
): string {
  const optional = HOLIDAY_LIST_OPTIONAL_COLUMNS.filter((column) => shown.columns.includes(column))
  const header = ["Holiday list", ...(shown.description ? ["Description"] : []), ...(shown.country ? ["Country"] : []), "Status", ...optional]
  const cell = (row: HolidayListRow, column: HolidayListColumn) =>
    column === "Holidays" ? row.holidays : column === "Projects" ? row.projects : row.nextHoliday
  return csvOf(
    header,
    rows.map((row) => [
      row.name,
      ...(shown.description ? [row.record.description] : []),
      ...(shown.country ? [row.countryLabel] : []),
      row.status,
      ...optional.map((column) => cell(row, column)),
    ]),
  )
}
