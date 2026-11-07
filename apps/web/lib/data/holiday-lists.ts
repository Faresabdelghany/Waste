/**
 * Holiday lists — the Settings pane that maintains the company's holiday
 * lists (issue #36, 2026-09-24; a list the company's own record since
 * 2026-11-05): the list a project names and the project's weekend on the
 * project record (`configure.organization`, read by resolveProjectCalendar),
 * and each list's dated, named holidays on its own record among the
 * calendars (`configure.calendars`, @waste/domain/route-schemes/
 * holiday-list-records). This module is the one place that knows how a
 * project's calendar settings and a list's entries become record writes.
 */

import type { SubmittedValues } from "@waste/domain/prototype-record"
import { formatShortDay, type ServiceDay } from "@waste/domain/days"

import type { BusinessRecord } from "./business-modules"
import { countryName } from "./countries"
import { csvOf } from "./csv"
import { HOLIDAY_LIST_KEYS, HOLIDAY_LIST_KIND, holidayListCountry, holidayListEntries, holidayListName } from "@waste/domain/route-schemes/holiday-list-records"
import {
  carryHolidaysToYear,
  holidayEntryIssue,
  holidayEntryValues,
  type HolidayEntry,
} from "@waste/domain/route-schemes/holiday-lists"
import { holidayNamesForCountry } from "@waste/domain/route-schemes/holiday-names"
import { weekendLabel } from "@waste/domain/route-schemes/project-calendar"
import { sortServiceDays } from "@waste/domain/route-schemes/recurrence"

export type ProjectCalendarSettings = {
  /** The list's name; null when the project has no holiday list. */
  holidayList: string | null
  /** The weekdays the project rests on. */
  weekend: readonly ServiceDay[]
}

/** The display facts the project record carries beside the typed values. */
const HOLIDAY_LIST_FACT = "Holiday list"
const WEEKEND_FACT = "Weekend"

/**
 * The project record with its calendar settings written: the typed values
 * resolveProjectCalendar reads (`weekend`, `holidayList` — absent for no
 * list) and the display facts beside them, everything else kept.
 */
export function withProjectCalendar(
  project: BusinessRecord,
  settings: ProjectCalendarSettings,
): BusinessRecord {
  const listName = settings.holidayList?.trim() || null
  const weekend = sortServiceDays(settings.weekend)
  const submittedValues: SubmittedValues = {
    ...project.submittedValues,
    weekend: weekend.join(", "),
  }
  const facts: Record<string, string> = {
    ...project.facts,
    [WEEKEND_FACT]: weekendLabel(weekend),
  }
  if (listName) {
    submittedValues.holidayList = listName
    facts[HOLIDAY_LIST_FACT] = listName
  } else {
    delete submittedValues.holidayList
    delete facts[HOLIDAY_LIST_FACT]
  }
  return { ...project, updated: "Now", freshness: "Now", facts, submittedValues }
}

/* --------------------------- the company's lists --------------------------- */
// Since 2026-11-05 a holiday list is the company's own record, one per
// country (@waste/domain/route-schemes/holiday-list-records), which the pane
// lists in a table and opens into a table of its holidays. These are the
// record writes it makes; on the Pilot the store hands them to the adapter
// (lib/api/records/holiday-lists.ts), in fixture mode to the browser's bucket.

export type HolidayListDraft = {
  /** ISO 3166-1 alpha-2. */
  country: string
  name: string
}

/** The facts a list shows beside its typed values. */
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

/** The list renamed or moved to another country, its holidays kept. */
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

/** The list with its holidays replaced by the entries, everything else kept. */
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

/* ------------------------------ The lists' table ------------------------------ */

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

/** One list as its row reads. */
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

/** The name a holiday reads as: its own, else what its country's known list calls the day, else "Holiday". */
export function shownHolidayName(entry: HolidayEntry, country: string | undefined): string {
  return entry.name || holidayNamesForCountry(country)(entry.date) || "Holiday"
}

/** The lists as their rows read on `today`, a list's projects counted by `projectCount`. */
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

/** Whether the row holds the search, in any of its shown words; a blank search holds every row. */
export function holidayListRowMatches(row: HolidayListRow, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === "") return true
  return [row.name, row.countryLabel, row.country ?? "", row.nextHoliday, row.status, row.record.description].join(" ").toLowerCase().includes(needle)
}

/** The rows by the View's order: by list name, or the lists in use first and then by name. */
export function orderHolidayListRows(rows: readonly HolidayListRow[], ordering: "name" | "status" | "updated"): HolidayListRow[] {
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
