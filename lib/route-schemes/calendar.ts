// Collection Calendar model. Pure data logic — no UI or store dependencies —
// so generation and validation share one definition of "is this planned date
// operationally valid on this calendar".
//
// Semantics:
//   the calendar decides whether a normal planned date is valid — holidays and
//   non-working days are skipped, never moved. A date the calendar
//   does not cover (outside validFrom/validTo, or no structured data at all)
//   is "uncovered": generation proceeds and the preview warns — uncovered is
//   never treated as non-working. Timezone is display-only (Q9): all date
//   math is day-granular ISO.

import type { BusinessRecord } from "../data/business-modules"
import { isIsoDate, parseServiceDays, serviceDayOf, type ServiceDay } from "./recurrence"
import { stringValue } from "./validation"

export type CollectionCalendar = {
  id: string
  name: string
  /** Record lifecycle status (Draft, Active, Superseded, Archived). */
  status: string
  /** Weekdays service may operate on; empty = unknown, no constraint. */
  workingDays: ServiceDay[]
  /** ISO dates that are non-working holidays. */
  holidayDates: string[]
  /** ISO; empty = open-ended. */
  validFrom: string
  validTo: string
  /** Display-only in this prototype — generation is day-granular. */
  timezone?: string
}

export type CalendarDayStatus = "working" | "holiday" | "non-working" | "uncovered"

/**
 * Whether generation skips a date with this status (Q2/Q7): holidays and
 * non-working days get no route.
 * One predicate shared by the engine and the wizard's next-dates preview so
 * the preview never promises what generation won't do.
 */
export function dayStatusSkipsGeneration(status: CalendarDayStatus): boolean {
  return status === "holiday" || status === "non-working"
}

// Pre-rename user-created records carry the drifted calendar name that the
// issue #13 fixture alignment retired; read sides fold it onto the real
// calendar record's name so facets and derived cells stay one value and
// filters match. Lives here (not in the filter popover) so pure lib readers
// share the fold too.
const legacyCalendarNames: Record<string, string> = {
  "Copenhagen 2026": "Copenhagen Central 2026",
}

export function canonicalCalendarName(value: string | undefined) {
  return value ? legacyCalendarNames[value] ?? value : value
}

/** "2026-12-25, 2026-12-26" or newline-separated → valid ISO dates only. */
export function parseHolidayDates(value: string | undefined): string[] {
  if (!value) return []
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((token) => token.trim())
        .filter((token) => isIsoDate(token)),
    ),
  ].sort()
}

/**
 * Reads a calendar's structured operational data from its record (the
 * `plan.calendars` form field ids, kept on records as `submittedValues`).
 * Returns null for a missing record or one without any structured fields —
 * such a calendar constrains nothing (legacy display-only records).
 */
export function calendarFromRecord(
  record: BusinessRecord | undefined | null,
): CollectionCalendar | null {
  if (!record) return null
  const values = record.submittedValues ?? {}
  const workingDays = parseServiceDays(
    typeof values.workingDays === "string" ? values.workingDays : "",
  )
  const holidayDates = parseHolidayDates(
    typeof values.holidayDates === "string" ? values.holidayDates : undefined,
  )
  const validFromRaw = stringValue(values, "validFrom") ?? ""
  const validToRaw = stringValue(values, "validTo") ?? ""
  const validFrom = isIsoDate(validFromRaw) ? validFromRaw : ""
  const validTo = isIsoDate(validToRaw) ? validToRaw : ""
  if (
    workingDays.length === 0 &&
    holidayDates.length === 0 &&
    !validFrom &&
    !validTo
  ) {
    return null
  }
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    workingDays,
    holidayDates,
    validFrom,
    validTo,
    ...(stringValue(values, "timezone")
      ? { timezone: stringValue(values, "timezone") }
      : {}),
  }
}

/** Whether the calendar's validity period covers the date (blank = open side). */
export function calendarCoversDate(
  calendar: CollectionCalendar,
  iso: string,
): boolean {
  if (calendar.validFrom && iso < calendar.validFrom) return false
  if (calendar.validTo && iso > calendar.validTo) return false
  return true
}

/**
 * The calendar's verdict on one date. Constraints apply only where the
 * calendar covers the date (Q6) — an uncovered date is a warning, not a skip.
 * Holidays outrank the working-day check: a holiday on a working weekday is
 * still a holiday.
 */
export function calendarDayStatus(
  calendar: CollectionCalendar | null | undefined,
  iso: string,
): CalendarDayStatus {
  if (!calendar) return "uncovered"
  if (!calendarCoversDate(calendar, iso)) return "uncovered"
  if (calendar.holidayDates.includes(iso)) return "holiday"
  if (
    calendar.workingDays.length > 0 &&
    !calendar.workingDays.includes(serviceDayOf(iso))
  ) {
    return "non-working"
  }
  return "working"
}
