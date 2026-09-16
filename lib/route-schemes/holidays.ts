// The holiday list a scheme's dates are judged against (2026-09-16 holiday
// model): ONE list per project, maintained per year, so selecting the project
// selects the holidays — nothing in the wizard picks a calendar. Until a
// Settings holiday screen exists the list is read from the table that holds
// the dates today: the Collection Calendar records scoped to the project
// (plan.calendars, one record per year), union of their holiday dates. Names
// come from the Danish public-holiday lookup with "Holiday" as the fallback
// (holiday-names.ts), because the records store dates only.
// Pure data logic (type-only import of BusinessRecord).

import type { BusinessRecord } from "../data/business-modules"
import { calendarFromRecord } from "./calendar"
import { holidayLabel } from "./holiday-names"
import {
  isHolidayPolicy,
  NO_HOLIDAYS,
  type HolidayList,
  type HolidayPolicy,
} from "./occurrences"
import { isIsoDate } from "./recurrence"
import { stringValue } from "./validation"

type StoredValues = Record<string, string | boolean | undefined>
type RecordLike = Pick<BusinessRecord, "facts" | "submittedValues" | "projectIds">

/** Where the holiday lists are managed: Settings › Operations setup › Calendars. */
export const HOLIDAY_SETTINGS_HREF = "/settings?pane=operations-setup"

export const NO_HOLIDAY_LIST_LABEL = "No holiday list on this project"
export const GENERIC_HOLIDAY_LIST_NAME = "Public holidays"

/** A project implies a country; the record carries its time zone, not a country. */
const HOLIDAY_LIST_NAMES_BY_TIMEZONE: Readonly<Record<string, string>> = {
  "Europe/Copenhagen": "Danish public holidays",
  "Africa/Cairo": "Egyptian public holidays",
}

/** Valid ISO dates → a sorted, named holiday list. */
export function holidayListFromDates(dates: Iterable<string>): HolidayList {
  const list = new Map<string, string>()
  for (const iso of [...new Set(dates)].filter(isIsoDate).sort()) {
    list.set(iso, holidayLabel(iso))
  }
  return list
}

/** The stored holiday policy; records that predate the field skip holidays, as they always did. */
export function schemeHolidayPolicy(values: StoredValues | undefined): HolidayPolicy {
  const policy = values?.holidayPolicy
  return isHolidayPolicy(policy) ? policy : "skip"
}

/** "Danish public holidays" for a Copenhagen project; the generic name when the time zone is unknown. */
export function holidayListName(project: Pick<RecordLike, "facts" | "submittedValues"> | undefined): string {
  const timezone =
    project?.facts?.Timezone?.trim() || stringValue(project?.submittedValues ?? {}, "timezone")
  return (timezone && HOLIDAY_LIST_NAMES_BY_TIMEZONE[timezone]) || GENERIC_HOLIDAY_LIST_NAME
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

/** The project's holiday list: the union of its per-year lists; empty when it has none. */
export function projectHolidayList(
  projectId: string | undefined,
  calendarRecords: readonly BusinessRecord[] | undefined,
): HolidayList {
  const records = projectHolidayCalendars(projectId, calendarRecords)
  if (records.length === 0) return NO_HOLIDAYS
  return holidayListFromDates(
    records.flatMap((record) => calendarFromRecord(record)?.holidayDates ?? []),
  )
}

export type HolidaySource = {
  /** "Danish public holidays". */
  name: string
  projectName: string
  /** The per-year calendar records the list is read from. */
  records: BusinessRecord[]
  list: HolidayList
}

/** What the wizard and the scheme detail name as the holiday source; null when the project has no list. */
export function projectHolidaySource(
  project: BusinessRecord | undefined,
  calendarRecords: readonly BusinessRecord[] | undefined,
): HolidaySource | null {
  if (!project) return null
  const records = projectHolidayCalendars(project.id, calendarRecords)
  if (records.length === 0) return null
  return {
    name: holidayListName(project),
    projectName: project.name,
    records,
    list: holidayListFromDates(
      records.flatMap((record) => calendarFromRecord(record)?.holidayDates ?? []),
    ),
  }
}

/** "Danish public holidays · from project Copenhagen Central", or the no-list label. */
export function holidaySourceLabel(source: HolidaySource | null): string {
  return source ? `${source.name} · from project ${source.projectName}` : NO_HOLIDAY_LIST_LABEL
}

/** The project a stored scheme plans for: its typed projectId, else its record scope. */
export function schemeProjectId(
  scheme: Pick<BusinessRecord, "submittedValues" | "projectIds">,
): string | undefined {
  return stringValue(scheme.submittedValues ?? {}, "projectId") ?? scheme.projectIds?.[0]
}

/** The holiday list a stored scheme generates against — its project's. */
export function schemeHolidayList(
  scheme: Pick<BusinessRecord, "submittedValues" | "projectIds">,
  calendarRecords: readonly BusinessRecord[] | undefined,
): HolidayList {
  return projectHolidayList(schemeProjectId(scheme), calendarRecords)
}

/** The scheme's holiday list name for list cells: the project's, or "—" when it has none. */
export function schemeHolidayListName(
  scheme: Pick<BusinessRecord, "submittedValues" | "projectIds">,
  calendarRecords: readonly BusinessRecord[],
  projects: readonly BusinessRecord[],
): string {
  const projectId = schemeProjectId(scheme)
  const project = projects.find((record) => record.id === projectId)
  return projectHolidaySource(project, calendarRecords)?.name ?? "—"
}
