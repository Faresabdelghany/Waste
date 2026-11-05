// Derived presentation for the Collection Calendars list (issue #27).
//
// Pure data logic, following the lifecycle.ts seam: records in, row
// summaries out. Everything here derives from the structured
// `submittedValues` a calendar record carries (via calendarFromRecord) — never
// from display facts, stored value strings, or the module's static metrics.

import type { BusinessRecord } from "../prototype-record"
import { EMPTY_FACT } from "../record-values"
import { calendarFromRecord } from "./calendar"
import { SERVICE_DAYS, SERVICE_DAY_SHORT_LABELS, type ServiceDay } from "./recurrence"

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

/** "Mon–Fri" for a contiguous Monday-first run, "Tue/Fri" otherwise — any weekday set (service days, a weekend). */
export function formatWorkingDays(days: ServiceDay[]): string {
  if (days.length === 0) return EMPTY_FACT
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
  if (!validFrom && !validTo) return EMPTY_FACT
  if (!validTo) return `From ${dayMonthYear(validFrom)}`
  if (!validFrom) return `Until ${dayMonthYear(validTo)}`
  const start =
    validFrom.slice(0, 4) === validTo.slice(0, 4)
      ? dayMonth(validFrom)
      : dayMonthYear(validFrom)
  return `${start} – ${dayMonthYear(validTo)}`
}

export type CalendarRowSummary = {
  validity: string
}

const EMPTY_ROW: CalendarRowSummary = { validity: EMPTY_FACT }

/** The derived table cells for one calendar record (D28iii); a calendar carries no holidays since 2026-11-05. */
export function calendarRowSummary(record: BusinessRecord | undefined | null): CalendarRowSummary {
  const calendar = calendarFromRecord(record)
  if (!calendar) return EMPTY_ROW
  return { validity: formatValidity(calendar.validFrom, calendar.validTo) }
}

/**
 * Display seam for a calendar's value, its validity: replaces the stored
 * value with the derived one so no surface renders a stale display copy.
 * Returns the input unchanged when nothing is derivable (legacy display-only
 * records) or the value already matches, so unchanged records stay
 * referentially stable across re-renders.
 */
export function withDerivedCalendarValue(record: BusinessRecord): BusinessRecord {
  const calendar = calendarFromRecord(record)
  if (!calendar) return record
  const derived = formatValidity(calendar.validFrom, calendar.validTo)
  if (record.value === derived) return record
  return { ...record, value: derived }
}
