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
import { HOLIDAY_LIST_KEYS, HOLIDAY_LIST_KIND, holidayListCountry, holidayListEntries } from "@waste/domain/route-schemes/holiday-list-records"
import {
  carryHolidaysToYear,
  holidayEntryIssue,
  holidayEntryValues,
  type HolidayEntry,
  type YearProposal,
} from "@waste/domain/route-schemes/holiday-lists"
import { holidayNamesForCountry } from "@waste/domain/route-schemes/holiday-names"
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

/* --------------------------- the company's lists --------------------------- */
// Since 2026-11-05 a holiday list is the company's own record, one per
// country (@waste/domain/route-schemes/holiday-list-records), which the pane
// lists in a table and opens into a table of its holidays. These are the
// record writes it makes; on the Pilot the store hands them to the adapter
// (lib/api/records/holiday-lists.ts), in fixture mode to the browser's bucket.

export type HolidayListDraft = {
  /** ISO 3166-1 alpha-2. */
  country: string
  name: string
}

/** The facts a list shows beside its typed values. */
function holidayListFacts(record: BusinessRecord, country: string, entries: readonly HolidayEntry[]): Record<string, string> {
  return { ...record.facts, Country: country, Holidays: String(entries.length) }
}

/**
 * A new list as a record, with the holidays it starts with: the clock read
 * here, the one impure step, kept out of the pane. Its id is the module's
 * minted one until the API answers with its own.
 */
export function createHolidayListRecord(
  draft: HolidayListDraft,
  entries: readonly HolidayEntry[],
  context: { actorName: string; companyId?: string; now?: number },
): BusinessRecord {
  const now = context.now ?? Date.now()
  const { holidayDates, holidayNames } = holidayEntryValues(entries)
  const name = draft.name.trim()
  return {
    id: `calendars-holiday-list-${now}`,
    name,
    context: `${draft.country} · 0 projects`,
    status: "Active",
    owner: context.actorName,
    value: "—",
    updated: "Now",
    description: `The company's holiday list for ${draft.country}.`,
    facts: { Country: draft.country, Holidays: String(entries.length), Projects: "0" },
    related: [],
    source: "Settings",
    freshness: "Now",
    companyId: context.companyId,
    projectIds: [],
    recordKind: HOLIDAY_LIST_KIND,
    submittedValues: {
      [HOLIDAY_LIST_KEYS.name]: name,
      [HOLIDAY_LIST_KEYS.country]: draft.country,
      [HOLIDAY_LIST_KEYS.dates]: holidayDates,
      ...(holidayNames === "" ? {} : { [HOLIDAY_LIST_KEYS.names]: holidayNames }),
    },
  }
}

/** The list renamed or moved to another country, its holidays kept. */
export function withHolidayListDraft(record: BusinessRecord, draft: HolidayListDraft): BusinessRecord {
  const name = draft.name.trim()
  return {
    ...record,
    name,
    updated: "Now",
    freshness: "Now",
    facts: holidayListFacts(record, draft.country, holidayListEntries(record)),
    submittedValues: { ...record.submittedValues, [HOLIDAY_LIST_KEYS.name]: name, [HOLIDAY_LIST_KEYS.country]: draft.country },
  }
}

/** The list with its holidays replaced by the entries, everything else kept. */
export function withHolidayListEntries(record: BusinessRecord, entries: readonly HolidayEntry[]): BusinessRecord {
  const { holidayDates, holidayNames } = holidayEntryValues(entries)
  const submittedValues: SubmittedValues = { ...record.submittedValues, [HOLIDAY_LIST_KEYS.dates]: holidayDates }
  if (holidayNames === "") delete submittedValues[HOLIDAY_LIST_KEYS.names]
  else submittedValues[HOLIDAY_LIST_KEYS.names] = holidayNames
  return {
    ...record,
    updated: "Now",
    freshness: "Now",
    facts: holidayListFacts(record, holidayListCountry(record) ?? "", entries),
    submittedValues,
  }
}

/**
 * Why a date cannot be one of the list's holidays, in a sentence, or null
 * when it can: not a calendar day, or already on the list (the entry being
 * edited excepted). A list spans every year, so no period bounds it.
 */
export function holidayListEntryIssue(entries: readonly HolidayEntry[], date: string, editingDate?: string): string | null {
  return holidayEntryIssue(entries, date, null, editingDate)
}

/**
 * Next year's holidays from this year's, for "Copy to <year>": a fixed
 * holiday keeps its day, a moveable feast the country's known list names
 * lands on its day that year, and anything else keeps its month and day for
 * the person to correct. Dates the list already holds that year are left out.
 */
export function nextYearEntries(record: BusinessRecord, fromYear: number): HolidayEntry[] {
  const entries = holidayListEntries(record)
  const year = fromYear + 1
  const held = new Set(entries.map((entry) => entry.date))
  const thisYear = entries.filter((entry) => entry.date.startsWith(`${fromYear}-`))
  return carryHolidaysToYear(thisYear, year, holidayNamesForCountry(holidayListCountry(record))).filter((entry) => !held.has(entry.date))
}
