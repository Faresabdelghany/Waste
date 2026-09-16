// Next-dates preview for the guided setup (2026-09-16 redesign). Pure date
// math — no UI, store, or fixture dependencies. Walks the effective window
// (or 12 months from effective-from when open-ended) through the shared
// recurrence predicate, then applies the scheme's holiday policy against the
// selected Collection Calendar.
//
// Gap adapter: generation (lib/route-schemes/generation.ts) skips calendar
// holidays and non-working days and never moves a collection, so only the
// "skip" policy is honoured end to end. The other three policies are
// previewed here and persisted on the record (submittedValues.holidayPolicy)
// for the engine to pick up later.

import { calendarDayStatus, type CollectionCalendar } from "./calendar"
import { holidayLabel } from "./holiday-names"
import {
  addDays,
  isIsoDate,
  isoWeek,
  matchesRecurrence,
  serviceDayOf,
  SERVICE_DAY_SHORT_LABELS,
  type SchemeRecurrence,
} from "./recurrence"

export const HOLIDAY_POLICIES = ["shift-next", "shift-prev", "skip", "collect"] as const
export type HolidayPolicy = (typeof HOLIDAY_POLICIES)[number]

export const HOLIDAY_POLICY_LABELS: Record<HolidayPolicy, string> = {
  "shift-next": "Shift to the next working day",
  "shift-prev": "Shift to the previous working day",
  skip: "Skip the collection",
  collect: "Collect as planned",
}

export const isHolidayPolicy = (value: unknown): value is HolidayPolicy =>
  typeof value === "string" && (HOLIDAY_POLICIES as readonly string[]).includes(value)

export type OccurrenceStatus = "planned" | "shifted" | "skipped" | "holiday"

export type Occurrence = {
  /** Running collection number; null for a skipped row. */
  n: number | null
  /** The date the collection happens (after any shift). */
  date: string
  /** The recurrence date the row stems from; differs from `date` when shifted. */
  plannedDate: string
  week: number
  status: OccurrenceStatus
  /** Holiday (or non-working day) label for shifted, skipped, and holiday rows. */
  note?: string
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

const isWeekend = (iso: string) => {
  const day = serviceDayOf(iso)
  return day === "saturday" || day === "sunday"
}

/**
 * Whether a collection can land on the date when shifting away from a
 * holiday: never a calendar holiday or non-working day; and when the
 * calendar declares no working days at all, never a weekend either.
 */
export function isShiftTarget(calendar: CollectionCalendar | null | undefined, iso: string): boolean {
  const status = calendarDayStatus(calendar, iso)
  if (status === "holiday" || status === "non-working") return false
  if (calendar && calendar.workingDays.length > 0 && status === "working") return true
  return !isWeekend(iso)
}

/** The nearest shift target from the date in the given direction (exclusive). */
export function shiftToWorkingDay(
  calendar: CollectionCalendar | null | undefined,
  iso: string,
  direction: 1 | -1,
): string {
  let cursor = iso
  // A calendar cannot block more than a few weeks in a row; the bound only
  // guards against a degenerate calendar with no working days.
  for (let step = 0; step < 60; step += 1) {
    cursor = addDays(cursor, direction)
    if (isShiftTarget(calendar, cursor)) return cursor
  }
  return cursor
}

export type OccurrencePreviewInput = {
  recurrence: SchemeRecurrence
  holidayPolicy: HolidayPolicy
  calendar: CollectionCalendar | null | undefined
}

const EMPTY = (ongoing: boolean, horizon: string | null): OccurrencePreview => ({
  rows: [],
  ongoing,
  horizon,
  count: 0,
})

/**
 * Every collection the scheme would make in its effective window (12 months
 * when open-ended), in date order and numbered. Holidays follow the policy;
 * a calendar non-working day is always skipped, as generation skips it.
 */
export function occurrencePreview(input: OccurrencePreviewInput): OccurrencePreview {
  const { recurrence, holidayPolicy, calendar } = input
  const from = recurrence.effectiveFrom
  const ongoing = !recurrence.effectiveTo
  if (!isIsoDate(from) || recurrence.serviceDays.length === 0) return EMPTY(ongoing, null)
  const to = ongoing ? addMonths(from, PREVIEW_HORIZON_MONTHS) : recurrence.effectiveTo
  if (!isIsoDate(to) || to < from) return EMPTY(ongoing, isIsoDate(to) ? to : null)

  const rows: Occurrence[] = []
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) {
    if (!matchesRecurrence(recurrence, cursor)) continue
    const week = isoWeek(cursor)
    const dayStatus = calendarDayStatus(calendar, cursor)
    if (dayStatus === "working" || dayStatus === "uncovered") {
      rows.push({ n: null, date: cursor, plannedDate: cursor, week, status: "planned" })
      continue
    }
    if (dayStatus === "non-working") {
      rows.push({
        n: null,
        date: cursor,
        plannedDate: cursor,
        week,
        status: "skipped",
        note: "Non-working day",
      })
      continue
    }
    const note = holidayLabel(cursor)
    if (holidayPolicy === "collect") {
      rows.push({ n: null, date: cursor, plannedDate: cursor, week, status: "holiday", note })
    } else if (holidayPolicy === "skip") {
      rows.push({ n: null, date: cursor, plannedDate: cursor, week, status: "skipped", note })
    } else {
      const shifted = shiftToWorkingDay(calendar, cursor, holidayPolicy === "shift-next" ? 1 : -1)
      rows.push({
        n: null,
        date: shifted,
        plannedDate: cursor,
        week: isoWeek(shifted),
        status: "shifted",
        note,
      })
    }
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  let n = 0
  for (const row of rows) {
    if (row.status !== "skipped") {
      n += 1
      row.n = n
    }
  }
  return { rows, ongoing, horizon: to, count: n }
}

/** "Shifted from Thu 24 Dec · Christmas Eve" — the badge text for a shifted row. */
export function shiftedNote(row: Occurrence): string {
  return `from ${formatOccurrenceShortDate(row.plannedDate)}${row.note ? ` · ${row.note}` : ""}`
}
