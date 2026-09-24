// Occurrence generation for route schemes — the ONE implementation of "on
// which dates does this scheme collect, and what happens when a date is a
// holiday". The guided setup's next-dates preview (step 2) and route
// generation (generation.ts) both call generateOccurrences, so a preview row
// and a generated route for the same scheme and window agree by construction.
// Pure date math — no UI, store, or fixture dependencies.
//
// Holiday policies:
//   shift-next / shift-prev  move the collection to the nearest working day in
//                            that direction — a working day is one that is
//                            neither on the project's weekend nor on its
//                            holiday list, and the search keeps going past
//                            further holidays and weekend days;
//   skip                     drop the collection;
//   collect                  keep it on the holiday.
// The weekend comes from the project (project-calendar.ts) — Egypt rests
// Friday–Saturday, so a Thursday holiday shifts to Sunday there. Nothing here
// knows which weekdays a weekend holds. Weekend days only matter as shift
// targets: a scheme whose service days include Saturday collects on Saturdays.

import { HOLIDAY_POLICIES, OCCURRENCE_STATUSES } from "../planning/vocabulary"
import {
  addDays,
  isIsoDate,
  isoWeek,
  matchesRecurrence,
  serviceDayOf,
  SERVICE_DAY_SHORT_LABELS,
  type SchemeRecurrence,
  type ServiceDay,
} from "./recurrence"

// The list lives in ../planning/vocabulary since Issue #97, where the database
// and the contracts read it too; re-exported so its importers did not move.
export { HOLIDAY_POLICIES }
export type HolidayPolicy = (typeof HOLIDAY_POLICIES)[number]

export const HOLIDAY_POLICY_LABELS: Record<HolidayPolicy, string> = {
  "shift-next": "Shift to the next working day",
  "shift-prev": "Shift to the previous working day",
  skip: "Skip the collection",
  collect: "Collect as planned",
}

export const isHolidayPolicy = (value: unknown): value is HolidayPolicy =>
  typeof value === "string" && (HOLIDAY_POLICIES as readonly string[]).includes(value)

/** ISO date → holiday name. The list generation and the preview judge dates against. */
export type HolidayList = ReadonlyMap<string, string>

export const NO_HOLIDAYS: HolidayList = new Map()

/**
 * The calendar a scheme's dates are judged against — its project's holiday
 * list and weekend as ONE input, so the preview and generation cannot
 * disagree on what a working day is.
 */
export type SchemeCalendar = {
  holidays: HolidayList
  /** The weekdays the project rests on; never assumed. */
  weekend: readonly ServiceDay[]
}

// The list lives in ../planning/vocabulary since the #97 review round, where the contracts read it too.
export { OCCURRENCE_STATUSES }
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number]

export type Occurrence = {
  /** Running collection number; null for a skipped row. */
  n: number | null
  /** The date the collection happens (after any shift). */
  date: string
  /** The recurrence date the row stems from; differs from `date` when shifted. */
  plannedDate: string
  /** ISO week of `date`. */
  week: number
  status: OccurrenceStatus
  /** Holiday name for shifted, skipped, and holiday rows. */
  note?: string
}

export type OccurrenceWindow = { from: string; to: string }

export type GenerateOccurrencesInput = {
  recurrence: SchemeRecurrence
  window: OccurrenceWindow
  holidayPolicy: HolidayPolicy
  calendar: SchemeCalendar
}

export type OccurrencePreview = {
  rows: Occurrence[]
  /** No effective-to: the preview covers 12 months from effective-from. */
  ongoing: boolean
  /** Last date the preview covers; null when the window is unusable. */
  horizon: string | null
  /** Collections (skipped rows excluded). */
  count: number
}

export const PREVIEW_HORIZON_MONTHS = 12

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** ISO + n months, rolling over like Date#setMonth (31 Jan + 1 → 3 Mar). */
export function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1 + months, day)).toISOString().slice(0, 10)
}

/** "05 Oct 2026" — the preview table's date cell. */
export function formatOccurrenceDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number)
  return `${String(day).padStart(2, "0")} ${MONTHS[month - 1]} ${year}`
}

/** "Thu 24 Dec" — the shifted-from note. */
export function formatOccurrenceShortDate(iso: string): string {
  const [, month, day] = iso.split("-").map(Number)
  return `${SERVICE_DAY_SHORT_LABELS[serviceDayOf(iso)]} ${day} ${MONTHS[month - 1]}`
}

/** "06:30" — zero-padded clock time; empty input stays empty. */
export function formatClockTime(time: string | undefined): string {
  if (!time) return ""
  const [hours, minutes] = time.split(":").map(Number)
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return time
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

/** A day that is neither on the project's weekend nor on its holiday list. */
export function isWorkingDay(calendar: SchemeCalendar, iso: string): boolean {
  return !calendar.weekend.includes(serviceDayOf(iso)) && !calendar.holidays.has(iso)
}

/** The nearest working day from the date in the given direction (exclusive). */
export function shiftToWorkingDay(
  calendar: SchemeCalendar,
  iso: string,
  direction: 1 | -1,
): string {
  let cursor = iso
  // Holidays and weekend days cannot block more than a couple of weeks in a
  // row; the bound only guards against a degenerate list or a 7-day weekend.
  for (let step = 0; step < 60; step += 1) {
    cursor = addDays(cursor, direction)
    if (isWorkingDay(calendar, cursor)) return cursor
  }
  return cursor
}

const byDate = (a: Occurrence, b: Occurrence) =>
  a.date.localeCompare(b.date) || a.plannedDate.localeCompare(b.plannedDate)

/**
 * Every collection the scheme makes inside the window, in date order and
 * numbered: one row per recurrence date, with the holiday policy applied to
 * the dates on the holiday list. A shifted row keeps its recurrence date as
 * `plannedDate` — that is the route's identity — and moves `date`. The
 * window bounds the recurrence dates; a shift may land just outside it.
 */
export function generateOccurrences(input: GenerateOccurrencesInput): Occurrence[] {
  const { recurrence, window: occurrenceWindow, holidayPolicy, calendar } = input
  const rows: Occurrence[] = []
  if (!isIsoDate(occurrenceWindow.from) || !isIsoDate(occurrenceWindow.to) || occurrenceWindow.to < occurrenceWindow.from) return rows
  if (recurrence.serviceDays.length === 0) return rows

  for (let cursor = occurrenceWindow.from; cursor <= occurrenceWindow.to; cursor = addDays(cursor, 1)) {
    if (!matchesRecurrence(recurrence, cursor)) continue
    const note = calendar.holidays.get(cursor)
    if (note === undefined) {
      rows.push({ n: null, date: cursor, plannedDate: cursor, week: isoWeek(cursor), status: "planned" })
      continue
    }
    if (holidayPolicy === "collect") {
      rows.push({ n: null, date: cursor, plannedDate: cursor, week: isoWeek(cursor), status: "holiday", note })
    } else if (holidayPolicy === "skip") {
      rows.push({ n: null, date: cursor, plannedDate: cursor, week: isoWeek(cursor), status: "skipped", note })
    } else {
      const shifted = shiftToWorkingDay(calendar, cursor, holidayPolicy === "shift-next" ? 1 : -1)
      rows.push({ n: null, date: shifted, plannedDate: cursor, week: isoWeek(shifted), status: "shifted", note })
    }
  }

  rows.sort(byDate)
  let n = 0
  for (const row of rows) {
    if (row.status !== "skipped") {
      n += 1
      row.n = n
    }
  }
  return rows
}

export type OccurrencePreviewInput = {
  recurrence: SchemeRecurrence
  holidayPolicy: HolidayPolicy
  calendar: SchemeCalendar
}

const EMPTY = (ongoing: boolean, horizon: string | null): OccurrencePreview => ({
  rows: [],
  ongoing,
  horizon,
  count: 0,
})

/**
 * The guided setup's next-dates table: generateOccurrences over the scheme's
 * effective window, or over 12 months from effective-from when open-ended.
 */
export function occurrencePreview(input: OccurrencePreviewInput): OccurrencePreview {
  const { recurrence, holidayPolicy, calendar } = input
  const from = recurrence.effectiveFrom
  const ongoing = !recurrence.effectiveTo
  if (!isIsoDate(from) || recurrence.serviceDays.length === 0) return EMPTY(ongoing, null)
  const to = ongoing ? addMonths(from, PREVIEW_HORIZON_MONTHS) : recurrence.effectiveTo
  if (!isIsoDate(to) || to < from) return EMPTY(ongoing, isIsoDate(to) ? to : null)

  const rows = generateOccurrences({ recurrence, window: { from, to }, holidayPolicy, calendar })
  return {
    rows,
    ongoing,
    horizon: to,
    count: rows.filter((row) => row.status !== "skipped").length,
  }
}

/** "from Thu 24 Dec · Christmas Eve" — the badge text for a shifted row. */
export function shiftedNote(row: Occurrence): string {
  return `from ${formatOccurrenceShortDate(row.plannedDate)}${row.note ? ` · ${row.note}` : ""}`
}
