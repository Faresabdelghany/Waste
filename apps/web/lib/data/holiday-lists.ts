/**
 * Holiday lists — the Settings pane that maintains each project's holiday
 * list (issue #36, 2026-09-24): the list's name and the project's weekend on
 * the project record (`configure.organization`, read by
 * resolveProjectCalendar), and the dated, named holidays per year on the
 * project's Collection Calendar records (`configure.calendars`, read by
 * projectHolidayCalendars). Nothing moved: the pane writes the records the
 * wizard, generation and the scheme detail already read, so this module is
 * the one place that knows how a project's calendar settings and a year's
 * entries become record writes. The pane's id and address live in
 * business-links.ts (`HOLIDAY_LISTS_SETTINGS_PANE_ID`, `holidaySettingsHref`)
 * beside every other Settings link, since that module cannot import this one
 * without a cycle through the fixture registry.
 */

import type { SubmittedValues } from "@waste/domain/prototype-record"

import type { BusinessFormValues } from "./business-form-types"
import type { BusinessRecord } from "./business-modules"
import {
  collectionCalendarFormValues,
  createCollectionCalendarRecord,
  updateCollectionCalendarRecord,
  type CollectionCalendarLookups,
} from "./collection-calendars"
import { parseHolidayDates } from "@waste/domain/route-schemes/calendar"
import {
  holidayEntryValues,
  type HolidayEntry,
  type YearProposal,
} from "@waste/domain/route-schemes/holiday-lists"
import { weekendLabel } from "@waste/domain/route-schemes/project-calendar"
import { sortServiceDays, type ServiceDay } from "@waste/domain/route-schemes/recurrence"

export type ProjectCalendarSettings = {
  /** The list's name; null when the project has no holiday list. */
  holidayList: string | null
  /** The weekdays the project rests on. */
  weekend: readonly ServiceDay[]
}

/** The display facts the project record carries beside the typed values. */
const HOLIDAY_LIST_FACT = "Holiday list"
const WEEKEND_FACT = "Weekend"

/**
 * The project record with its calendar settings written: the typed values
 * resolveProjectCalendar reads (`weekend`, `holidayList` — absent for no
 * list) and the display facts beside them, everything else kept.
 */
export function withProjectCalendar(
  project: BusinessRecord,
  settings: ProjectCalendarSettings,
): BusinessRecord {
  const listName = settings.holidayList?.trim() || null
  const weekend = sortServiceDays(settings.weekend)
  const submittedValues: SubmittedValues = {
    ...project.submittedValues,
    weekend: weekend.join(", "),
  }
  const facts: Record<string, string> = {
    ...project.facts,
    [WEEKEND_FACT]: weekendLabel(weekend),
  }
  if (listName) {
    submittedValues.holidayList = listName
    facts[HOLIDAY_LIST_FACT] = listName
  } else {
    delete submittedValues.holidayList
    delete facts[HOLIDAY_LIST_FACT]
  }
  return { ...project, updated: "Now", freshness: "Now", facts, submittedValues }
}

/**
 * The calendar record with its holidays replaced by the entries: written
 * through the Collection calendars edit path with the record's own form
 * values, so its name, validity, facts and scope come out as an edit there
 * would leave them.
 */
export function withHolidayEntries(
  record: BusinessRecord,
  entries: readonly HolidayEntry[],
  lookups: CollectionCalendarLookups,
): BusinessRecord {
  return updateCollectionCalendarRecord(
    record,
    { ...collectionCalendarFormValues(record), ...holidayEntryValues(entries) },
    lookups,
  )
}

/**
 * A year proposal as the Collection calendar create form's values, so the
 * person reviews the name, the validity and the dates before the record
 * exists. Week start and time zone follow the record the year continues
 * from; a first year takes the form's own defaults.
 */
export function yearProposalFormValues(
  proposal: YearProposal,
  projectId: string,
  previous?: BusinessRecord,
): BusinessFormValues {
  const values: BusinessFormValues = {
    calendarName: proposal.calendarName,
    projectId,
    validFrom: proposal.validFrom,
    validTo: proposal.validTo,
    holidayDates: proposal.entries.map((entry) => entry.date).join(", "),
  }
  for (const key of ["weekStart", "timezone"] as const) {
    const value = previous?.submittedValues?.[key]
    if (typeof value === "string" && value.trim() !== "") values[key] = value
  }
  return values
}

/**
 * The names to write with a submitted year: the proposal's, for the dates the
 * form kept — a date added in the form is unnamed until the pane names it.
 */
export function proposalHolidayNames(proposal: YearProposal, values: BusinessFormValues): string {
  const kept = new Set(
    parseHolidayDates(typeof values.holidayDates === "string" ? values.holidayDates : undefined),
  )
  return holidayEntryValues(proposal.entries.filter((entry) => kept.has(entry.date))).holidayNames
}

export type YearRecordContext = {
  /** Who is saving — stamped as the creator. */
  actorName: string
  lookups: CollectionCalendarLookups
  /** The clock, for a test that wants to know the id; the pane leaves it to the module. */
  now?: number
}

/**
 * The submitted year as a Collection Calendar record: the form's values, the
 * proposal's names for the dates the form kept, and the clock read here — the
 * one impure step, kept out of the pane so the component stays pure.
 */
export function createYearRecord(
  proposal: YearProposal,
  values: BusinessFormValues,
  context: YearRecordContext,
): BusinessRecord {
  return createCollectionCalendarRecord(
    { ...values, holidayNames: proposalHolidayNames(proposal, values) },
    { now: context.now ?? Date.now(), actorName: context.actorName, lookups: context.lookups },
  )
}
