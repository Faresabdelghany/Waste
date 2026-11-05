// Collection Calendar model. Pure data logic — no UI or store dependencies.
// A calendar record carries a validity period and no holidays: since
// 2026-11-05 a project's holidays are the days of the company's Holiday List
// it names (holiday-list-records.ts, project-calendar.ts), whose dates are
// spelled as `parseHolidayDates` reads them. The working week is a PROJECT
// attribute (project-calendar.ts, round 3). Validity is display data for the
// Collection Calendars list. Timezone is display-only (Q9): all date math is
// day-granular ISO.

import type { BusinessRecord } from "../prototype-record"
import { isIsoDate } from "./recurrence"
import { stringValue } from "./validation"

export type CollectionCalendar = {
  id: string
  name: string
  /** Record lifecycle status (Draft, Active, Superseded, Archived). */
  status: string
  /** ISO; empty = open-ended. */
  validFrom: string
  validTo: string
  /** Display-only in this prototype — generation is day-granular. */
  timezone?: string
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
 * `configure.calendars` form field ids, kept on records as `submittedValues`).
 * Returns null for a missing record or one without any structured fields —
 * such a calendar constrains nothing (legacy display-only records).
 */
export function calendarFromRecord(
  record: BusinessRecord | undefined | null,
): CollectionCalendar | null {
  if (!record) return null
  const values = record.submittedValues ?? {}
  const validFromRaw = stringValue(values, "validFrom") ?? ""
  const validToRaw = stringValue(values, "validTo") ?? ""
  const validFrom = isIsoDate(validFromRaw) ? validFromRaw : ""
  const validTo = isIsoDate(validToRaw) ? validToRaw : ""
  if (!validFrom && !validTo) {
    return null
  }
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    validFrom,
    validTo,
    ...(stringValue(values, "timezone")
      ? { timezone: stringValue(values, "timezone") }
      : {}),
  }
}
