// The project's calendar (round 3, 2026-09-16): its weekend and its holiday
// list, resolved by ONE function — resolveProjectCalendar — for the guided
// setup, the scheme detail, and the list. Both are explicit project
// attributes:
//   weekend      the weekdays the project rests on (Egypt Friday–Saturday,
//                Denmark Saturday–Sunday), never derived from the weekday
//                number; planning's DEFAULT_WEEKEND only when nothing is set;
//   holidayList  the name of the company's Holiday List the project rests
//                on, or absent = no list. Since 2026-11-05 the list is a
//                record of its own (holiday-list-records.ts), riding among
//                the calendar records, and its dates are the list's; a name
//                no list record carries is a list with no days (a calendar
//                carries no holidays). The Settings screen edits both; the
//                wizard only reads them.
// Pure data logic (type-only import of BusinessRecord).

import type { BusinessRecord } from "../prototype-record"
import { typedString } from "../record-values"
import { formatWorkingDays } from "./calendar-list"
import { holidayListEntries, holidayListNamed } from "./holiday-list-records"
import { holidayListFromDates, holidayNamesFor, withCarriedNames } from "@waste/domain/planning/holiday-names"
import type { SchemeCalendar } from "@waste/domain/planning/occurrences"
import { type HolidayList, NO_HOLIDAYS, type ServiceDay } from "@waste/domain/days"
import { DEFAULT_WEEKEND } from "@waste/domain/planning/vocabulary"
import { parseServiceDays } from "./recurrence-values"

/** The list name shown when the project has no holiday list. */
export const NO_HOLIDAY_LIST_LABEL = "None on this project"

export type ProjectHolidayList = {
  /** "Danish public holidays". */
  name: string
  dates: HolidayList
  /** The company's Holiday List record the dates are read from; absent where no record carries the name. */
  listRecord?: BusinessRecord
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

/** The project's weekend: its typed `weekend` days, else the default. */
export function projectWeekend(project: BusinessRecord | undefined): ServiceDay[] {
  const days = parseServiceDays(typedString(project?.submittedValues, "weekend") ?? "")
  return days.length > 0 ? days : [...DEFAULT_WEEKEND]
}

/** The name of the project's holiday list, or null when it has none. */
export function projectHolidayListName(project: BusinessRecord | undefined): string | null {
  return typedString(project?.submittedValues, "holidayList") ?? null
}

/** The calendar the wizard, generation, detail, and list all read for a project. */
export function resolveProjectCalendar(
  projectId: string | undefined,
  records: ProjectCalendarRecords,
): ProjectCalendar {
  const project = projectId
    ? records.projects.find((record) => record.id === projectId)
    : undefined
  const name = projectHolidayListName(project)
  if (!name) return { list: null, weekend: projectWeekend(project) }
  const listRecord = holidayListNamed(name, records.calendars)
  const entries = listRecord ? holidayListEntries(listRecord) : []
  return {
    list: {
      name,
      dates: holidayListFromDates(
        entries.map((entry) => entry.date),
        withCarriedNames(new Map(entries.flatMap((entry) => (entry.name ? [[entry.date, entry.name] as const] : []))), holidayNamesFor(name)),
      ),
      ...(listRecord ? { listRecord } : {}),
    },
    weekend: projectWeekend(project),
  }
}

/** The generator's input for a project calendar: dates (none without a list) plus the weekend. */
export function schemeCalendarOf(calendar: ProjectCalendar): SchemeCalendar {
  return { holidays: calendar.list?.dates ?? NO_HOLIDAYS, weekend: calendar.weekend }
}

/** "Sat–Sun" / "Fri–Sat". */
export function weekendLabel(weekend: readonly ServiceDay[]): string {
  return formatWorkingDays([...weekend])
}

/** "Danish public holidays · Sat–Sun weekend" — the step 2 field and the review row; the no-list name when there is none. */
export function projectCalendarLabel(calendar: ProjectCalendar): string {
  return `${calendar.list?.name ?? NO_HOLIDAY_LIST_LABEL} · ${weekendLabel(calendar.weekend)} weekend`
}
