// The project's calendar (round 3, 2026-09-16): its weekend and its holiday
// list, resolved by ONE function — resolveProjectCalendar — for the guided
// setup, generation (creation, edit, Plan Ahead, manual runs), the scheme
// detail, and the list. The weekend is a project attribute (Egypt rests
// Friday–Saturday, Denmark Saturday–Sunday); it is never derived from the
// weekday number. Pure data logic (type-only import of BusinessRecord).

import type { BusinessRecord } from "../data/business-modules"
import { formatWorkingDays } from "./calendar-list"
import { projectHolidaySource, schemeProjectId } from "./holidays"
import { NO_HOLIDAYS, type HolidayList, type SchemeCalendar } from "./occurrences"
import { parseServiceDays, type ServiceDay } from "./recurrence"

/** The weekend a project takes when it has none set. */
export const DEFAULT_WEEKEND: readonly ServiceDay[] = ["saturday", "sunday"]

export type ProjectHolidayList = {
  /** "Danish public holidays". */
  name: string
  dates: HolidayList
  /** The per-year Collection Calendar records the dates are read from. */
  records: BusinessRecord[]
}

export type ProjectCalendar = {
  /** null when the project has no holiday list. */
  list: ProjectHolidayList | null
  weekend: ServiceDay[]
}

export type ProjectCalendarRecords = {
  projects: readonly BusinessRecord[]
  calendars: readonly BusinessRecord[]
}

const stringOf = (record: BusinessRecord | undefined, key: string): string => {
  const value = record?.submittedValues?.[key]
  return typeof value === "string" ? value.trim() : ""
}

/** The project's weekend: its typed `weekend` days, else the default. */
export function projectWeekend(project: BusinessRecord | undefined): ServiceDay[] {
  const days = parseServiceDays(stringOf(project, "weekend"))
  return days.length > 0 ? days : [...DEFAULT_WEEKEND]
}

/** The calendar the wizard, generation, detail, and list all read for a project. */
export function resolveProjectCalendar(
  projectId: string | undefined,
  records: ProjectCalendarRecords,
): ProjectCalendar {
  const project = projectId
    ? records.projects.find((record) => record.id === projectId)
    : undefined
  const source = projectHolidaySource(project, records.calendars)
  return {
    list: source ? { name: source.name, dates: source.list, records: source.records } : null,
    weekend: projectWeekend(project),
  }
}

/** The generator's input for a project calendar: dates (none without a list) plus the weekend. */
export function schemeCalendarOf(calendar: ProjectCalendar): SchemeCalendar {
  return { holidays: calendar.list?.dates ?? NO_HOLIDAYS, weekend: calendar.weekend }
}

/** The calendar a stored scheme generates against — its project's. */
export function schemeGenerationCalendar(
  scheme: Pick<BusinessRecord, "submittedValues" | "projectIds">,
  records: { projects?: readonly BusinessRecord[]; calendars?: readonly BusinessRecord[] },
): SchemeCalendar {
  return schemeCalendarOf(
    resolveProjectCalendar(schemeProjectId(scheme), {
      projects: records.projects ?? [],
      calendars: records.calendars ?? [],
    }),
  )
}

/** "Sat–Sun" / "Fri–Sat". */
export function weekendLabel(weekend: readonly ServiceDay[]): string {
  return formatWorkingDays([...weekend])
}
