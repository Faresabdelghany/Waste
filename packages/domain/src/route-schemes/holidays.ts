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

/** The project's calendar records that carry holiday dates — one per year, earliest validity first. */
export function projectHolidayCalendars(
  projectId: string | undefined,
  calendarRecords: readonly BusinessRecord[] | undefined,
): BusinessRecord[] {
  if (!projectId || !calendarRecords) return []
  const validFromOf = (record: BusinessRecord) => calendarFromRecord(record)?.validFrom ?? ""
  return calendarRecords
    .filter((record) => recordProjectIds(record).includes(projectId))
    .filter((record) => (calendarFromRecord(record)?.holidayDates.length ?? 0) > 0)
    .sort((a, b) => validFromOf(a).localeCompare(validFromOf(b)) || a.name.localeCompare(b.name))
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
