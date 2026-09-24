// The holiday DATES a project's calendar records carry (2026-09-16 holiday
// model): ONE list per project, maintained per year as Collection Calendar
// records scoped to the project (configure.calendars, managed in Settings),
// union of their holiday dates. Which list a project has — and whether it has
// one at all — is the project's explicit `holidayList` attribute, resolved in
// project-calendar.ts
// together with the weekend; this module only reads the dated records and
// names their dates. Pure data logic (type-only import of BusinessRecord).

import type { BusinessRecord } from "../prototype-record"
import { calendarFromRecord } from "./calendar"
import { holidayLabel, type HolidayNameLookup } from "./holiday-names"
import { isHolidayPolicy, type HolidayList, type HolidayPolicy } from "./occurrences"
import { isIsoDate } from "./recurrence"
import { stringValue } from "./validation"

type StoredValues = Record<string, string | boolean | undefined>
type RecordLike = Pick<BusinessRecord, "facts" | "submittedValues" | "projectIds">

/** Valid ISO dates → a sorted holiday list named through the list's lookup. */
export function holidayListFromDates(
  dates: Iterable<string>,
  names: HolidayNameLookup,
): HolidayList {
  const list = new Map<string, string>()
  for (const iso of [...new Set(dates)].filter(isIsoDate).sort()) {
    list.set(iso, holidayLabel(iso, names))
  }
  return list
}

/** The stored holiday policy; records that predate the field skip holidays, as they always did. */
export function schemeHolidayPolicy(values: StoredValues | undefined): HolidayPolicy {
  const policy = values?.holidayPolicy
  return isHolidayPolicy(policy) ? policy : "skip"
}

const recordProjectIds = (record: RecordLike): string[] =>
  [...(record.projectIds ?? []), stringValue(record.submittedValues ?? {}, "projectId") ?? ""].filter(
    Boolean,
  )

/** Every calendar record scoped to the project, earliest validity first — with or without holiday dates. */
export function projectCalendarRecords(
  projectId: string | undefined,
  calendarRecords: readonly BusinessRecord[] | undefined,
): BusinessRecord[] {
  if (!projectId || !calendarRecords) return []
  const validFromOf = (record: BusinessRecord) => calendarFromRecord(record)?.validFrom ?? ""
  return calendarRecords
    .filter((record) => recordProjectIds(record).includes(projectId))
    .sort((a, b) => validFromOf(a).localeCompare(validFromOf(b)) || a.name.localeCompare(b.name))
}

/** The project's calendar records that carry holiday dates — one per year, earliest validity first. */
export function projectHolidayCalendars(
  projectId: string | undefined,
  calendarRecords: readonly BusinessRecord[] | undefined,
): BusinessRecord[] {
  return projectCalendarRecords(projectId, calendarRecords).filter(
    (record) => (calendarFromRecord(record)?.holidayDates.length ?? 0) > 0,
  )
}

/**
 * The calendar record's `submittedValues` key for the names of its holidays:
 * a JSON object of ISO date to name, written by the Holiday lists pane
 * (holiday-lists.ts) beside `holidayDates`. A record that carries none is
 * named through the list's lookup (holiday-names.ts), as every record was
 * before 2026-09-24.
 */
export const HOLIDAY_NAMES_KEY = "holidayNames"

/** The names a record carries, by date; anything that is not that object is no names. */
export function parseHolidayNames(raw: string | boolean | undefined): Map<string, string> {
  const names = new Map<string, string>()
  if (typeof raw !== "string" || raw.trim() === "") return names
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return names
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return names
  for (const [date, name] of Object.entries(parsed)) {
    if (isIsoDate(date) && typeof name === "string" && name.trim() !== "") {
      names.set(date, name.trim())
    }
  }
  return names
}

/** The names as the record stores them, keys in date order; blank for none. */
export function serializeHolidayNames(names: ReadonlyMap<string, string>): string {
  if (names.size === 0) return ""
  return JSON.stringify(Object.fromEntries([...names.entries()].sort(([a], [b]) => a.localeCompare(b))))
}

/** Every holiday name the project's per-year records carry, by date. */
export function projectHolidayNames(
  projectId: string | undefined,
  calendarRecords: readonly BusinessRecord[] | undefined,
): Map<string, string> {
  const names = new Map<string, string>()
  for (const record of projectHolidayCalendars(projectId, calendarRecords)) {
    for (const [date, name] of parseHolidayNames(record.submittedValues?.[HOLIDAY_NAMES_KEY])) {
      names.set(date, name)
    }
  }
  return names
}

/** Every holiday date the project's per-year records carry, deduplicated and sorted. */
export function projectHolidayDates(
  projectId: string | undefined,
  calendarRecords: readonly BusinessRecord[] | undefined,
): string[] {
  return [
    ...new Set(
      projectHolidayCalendars(projectId, calendarRecords).flatMap(
        (record) => calendarFromRecord(record)?.holidayDates ?? [],
      ),
    ),
  ].sort()
}

/** The project a stored scheme plans for: its typed projectId, else its record scope. */
export function schemeProjectId(
  scheme: Pick<BusinessRecord, "submittedValues" | "projectIds">,
): string | undefined {
  return stringValue(scheme.submittedValues ?? {}, "projectId") ?? scheme.projectIds?.[0]
}
