// Derived presentation for the Collection Calendars list (issue #27).
//
// Pure data logic, following the lifecycle.ts seam: records plus an explicit
// `today` in, row summaries out. Everything here derives from the structured
// `submittedValues` a calendar record carries (via calendarFromRecord) — never
// from display facts, stored value strings, or the module's static metrics.

import type { BusinessRecord } from "../data/business-modules"
import { calendarFromRecord } from "./calendar"
import {
  addDays,
  SERVICE_DAYS,
  SERVICE_DAY_SHORT_LABELS,
  type ServiceDay,
} from "./recurrence"

const EMPTY = "—"

// Hand-rolled month labels (like SERVICE_DAY_SHORT_LABELS) rather than
// Intl "en-GB", whose ICU-dependent "Sept" would disagree with the "Sep"
// used across fixture copy and drift between runtimes.
const MONTH_SHORT_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const

function dayMonth(iso: string): string {
  const day = Number(iso.slice(8, 10))
  return `${day} ${MONTH_SHORT_LABELS[Number(iso.slice(5, 7)) - 1]}`
}

function dayMonthYear(iso: string): string {
  return `${dayMonth(iso)} ${iso.slice(0, 4)}`
}

/**
 * The next run of consecutive holiday dates starting at the first date on or
 * after `today` — "25–26 Dec" is one operational closure, not two holidays.
 */
export function nextHolidaySpan(holidayDates: string[], today: string): string[] {
  const upcoming = [...new Set(holidayDates)]
    .sort()
    .filter((date) => date >= today)
  if (upcoming.length === 0) return []
  const span = [upcoming[0]]
  for (const date of upcoming.slice(1)) {
    if (date !== addDays(span[span.length - 1], 1)) break
    span.push(date)
  }
  return span
}

/** "25 Dec", "25–26 Dec", or "31 Dec – 1 Jan" for a consecutive span. */
export function formatHolidaySpan(span: string[]): string {
  if (span.length === 0) return EMPTY
  const first = span[0]
  const last = span[span.length - 1]
  if (first === last) return dayMonth(first)
  if (first.slice(0, 7) === last.slice(0, 7)) {
    return `${first.slice(8).replace(/^0/, "")}–${dayMonth(last)}`
  }
  return `${dayMonth(first)} – ${dayMonth(last)}`
}

/** "Mon–Fri" for a contiguous Monday-first run, "Tue/Fri" otherwise. */
export function formatWorkingDays(days: ServiceDay[]): string {
  if (days.length === 0) return EMPTY
  const ordered = [...days].sort(
    (a, b) => SERVICE_DAYS.indexOf(a) - SERVICE_DAYS.indexOf(b),
  )
  if (ordered.length === 1) return SERVICE_DAY_SHORT_LABELS[ordered[0]]
  const contiguous = ordered.every(
    (day, index) =>
      index === 0 ||
      SERVICE_DAYS.indexOf(day) === SERVICE_DAYS.indexOf(ordered[index - 1]) + 1,
  )
  if (contiguous) {
    return `${SERVICE_DAY_SHORT_LABELS[ordered[0]]}–${SERVICE_DAY_SHORT_LABELS[ordered[ordered.length - 1]]}`
  }
  return ordered.map((day) => SERVICE_DAY_SHORT_LABELS[day]).join("/")
}

/** "1 Jan – 31 Dec 2026", "From 1 Jan 2026", "Until 31 Dec 2026", or "—". */
export function formatValidity(validFrom: string, validTo: string): string {
  if (!validFrom && !validTo) return EMPTY
  if (!validTo) return `From ${dayMonthYear(validFrom)}`
  if (!validFrom) return `Until ${dayMonthYear(validTo)}`
  const start =
    validFrom.slice(0, 4) === validTo.slice(0, 4)
      ? dayMonth(validFrom)
      : dayMonthYear(validFrom)
  return `${start} – ${dayMonthYear(validTo)}`
}

export type CalendarRowSummary = {
  workingDays: string
  holidays: string
  validity: string
  nextHoliday: string
}

const EMPTY_ROW: CalendarRowSummary = {
  workingDays: EMPTY,
  holidays: EMPTY,
  validity: EMPTY,
  nextHoliday: EMPTY,
}

/** The derived table cells for one calendar record (D28iii). */
export function calendarRowSummary(
  record: BusinessRecord | undefined | null,
  today: string,
): CalendarRowSummary {
  const calendar = calendarFromRecord(record)
  if (!calendar) return EMPTY_ROW
  return {
    workingDays: formatWorkingDays(calendar.workingDays),
    holidays: String(calendar.holidayDates.length),
    validity: formatValidity(calendar.validFrom, calendar.validTo),
    nextHoliday: formatHolidaySpan(nextHolidaySpan(calendar.holidayDates, today)),
  }
}

/**
 * Display seam for the "Next holiday" value: replaces the stored value with
 * the derived one so no surface renders a stale display copy. Returns the
 * input unchanged when nothing is derivable (legacy display-only records) or
 * the value already matches, so unchanged records stay referentially stable
 * across re-renders.
 */
export function withDerivedCalendarValue(
  record: BusinessRecord,
  today: string,
): BusinessRecord {
  const calendar = calendarFromRecord(record)
  if (!calendar) return record
  const derived = formatHolidaySpan(nextHolidaySpan(calendar.holidayDates, today))
  if (record.value === derived) return record
  return { ...record, value: derived }
}

/** "1 date", "11 dates" — the count phrasing shared by the list and the wizard's calendar context (issue #32). */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}
