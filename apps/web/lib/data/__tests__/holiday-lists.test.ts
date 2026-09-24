import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { danishHolidayName } from "@waste/domain/route-schemes/holiday-names"
import { calendarHolidayEntries, nextYearProposal } from "@waste/domain/route-schemes/holiday-lists"
import { resolveProjectCalendar } from "@waste/domain/route-schemes/project-calendar"

import {
  HOLIDAY_LISTS_SETTINGS_PANE_ID,
  HOLIDAY_SETTINGS_HREF,
  holidaySettingsHref,
} from "../business-links"
import {
  FIXTURE_PROJECT_IDS,
  businessWorkspaces,
  type BusinessRecord,
} from "../business-modules"
import type { CollectionCalendarLookups } from "../collection-calendars"
import {
  createYearRecord,
  proposalHolidayNames,
  withHolidayEntries,
  withProjectCalendar,
  yearProposalFormValues,
} from "../holiday-lists"

const organisation = businessWorkspaces.configure.modules.find(
  (module) => module.id === "organization",
)?.records
const calendars = businessWorkspaces.configure.modules.find(
  (module) => module.id === "calendars",
)?.records
if (!organisation || !calendars) throw new Error("the configure fixtures are missing")

const fixture = (records: readonly BusinessRecord[], id: string): BusinessRecord => {
  const record = records.find((candidate) => candidate.id === id)
  if (!record) throw new Error(`no fixture ${id}`)
  return record
}

const lookups: CollectionCalendarLookups = {
  projectName: (projectId) => organisation.find((record) => record.id === projectId)?.name,
  recordName: (relation, recordId) =>
    relation.moduleId === "organization"
      ? organisation.find((record) => record.id === recordId)?.name
      : undefined,
}

describe("the pane's address", () => {
  test("the wizard and the scheme detail link to the pane, on the scheme's project when known", () => {
    assert.equal(holidaySettingsHref(), `/settings?pane=${HOLIDAY_LISTS_SETTINGS_PANE_ID}`)
    assert.equal(
      holidaySettingsHref(FIXTURE_PROJECT_IDS.cairo),
      `/settings?pane=${HOLIDAY_LISTS_SETTINGS_PANE_ID}&project=project-cairo`,
    )
    assert.equal(HOLIDAY_SETTINGS_HREF, holidaySettingsHref())
  })
})

describe("withProjectCalendar — the project record's list name and weekend", () => {
  const harbor = fixture(organisation, FIXTURE_PROJECT_IDS.harbor)

  test("writes the typed values resolveProjectCalendar reads and the facts beside them", () => {
    const written = withProjectCalendar(harbor, {
      holidayList: " Danish public holidays ",
      weekend: ["sunday", "saturday"],
    })
    assert.equal(written.submittedValues?.holidayList, "Danish public holidays")
    assert.equal(written.submittedValues?.weekend, "saturday, sunday")
    assert.equal(written.facts["Holiday list"], "Danish public holidays")
    assert.equal(written.facts.Weekend, "Sat–Sun")
    assert.equal(written.facts.Language, "Danish")
    assert.equal(written.updated, "Now")
    const calendar = resolveProjectCalendar(harbor.id, { projects: [written], calendars: [] })
    assert.equal(calendar.list?.name, "Danish public holidays")
    assert.deepEqual(calendar.weekend, ["saturday", "sunday"])
  })

  test("a blank name means no list: the value and the fact go, the weekend stays", () => {
    const copenhagen = fixture(organisation, FIXTURE_PROJECT_IDS.copenhagen)
    const written = withProjectCalendar(copenhagen, { holidayList: "  ", weekend: ["friday", "saturday"] })
    assert.equal("holidayList" in (written.submittedValues ?? {}), false)
    assert.equal("Holiday list" in written.facts, false)
    assert.equal(written.submittedValues?.weekend, "friday, saturday")
    assert.equal(written.facts.Weekend, "Fri–Sat")
    assert.equal(resolveProjectCalendar(copenhagen.id, { projects: [written], calendars: [] }).list, null)
    // The input is left as it was.
    assert.equal(copenhagen.submittedValues?.holidayList, "Danish public holidays")
  })
})

describe("withHolidayEntries — a year's holidays written onto its record", () => {
  const central = fixture(calendars, "calendar-central")

  test("the dates and names land where the readers look; name, validity and scope are kept", () => {
    const entries = [
      ...calendarHolidayEntries(central, danishHolidayName).filter((entry) => entry.date < "2026-12-01"),
      { date: "2026-12-24", name: "Juleaften" },
    ]
    const written = withHolidayEntries(central, entries, lookups)
    assert.equal(written.id, central.id)
    assert.equal(written.name, "Copenhagen Central 2026")
    assert.equal(written.status, central.status)
    assert.deepEqual(written.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(written.submittedValues?.validFrom, "2026-01-01")
    assert.equal(written.submittedValues?.validTo, "2026-12-31")
    assert.equal(written.submittedValues?.weekStart, "monday")
    assert.equal(
      written.submittedValues?.holidayDates,
      "2026-01-01, 2026-04-02, 2026-04-03, 2026-04-05, 2026-04-06, 2026-05-14, 2026-05-24, 2026-05-25, 2026-06-05, 2026-12-24",
    )
    assert.deepEqual(calendarHolidayEntries(written, () => undefined), [
      ...entries.slice(0, -1),
      { date: "2026-12-24", name: "Juleaften" },
    ])
    // The fixture's display alias for the dates goes once the field carries them.
    assert.equal("Holidays" in written.facts, false)
    assert.equal(written.facts["Holiday dates"], written.submittedValues?.holidayDates)
    const list = resolveProjectCalendar(FIXTURE_PROJECT_IDS.copenhagen, {
      projects: organisation,
      calendars: [written],
    }).list
    assert.equal(list?.dates.get("2026-12-24"), "Juleaften")
    assert.equal(list?.dates.has("2026-12-25"), false)
  })

  test("an emptied year keeps its record and carries no dates", () => {
    const written = withHolidayEntries(central, [], lookups)
    assert.equal(written.submittedValues?.holidayDates, "")
    assert.equal(written.submittedValues?.holidayNames, "")
    assert.equal(written.name, central.name)
    assert.equal(written.submittedValues?.validFrom, "2026-01-01")
  })
})

describe("a proposed year through the Collection calendar form", () => {
  const central2027 = fixture(calendars, "calendar-central-2027")
  const proposal = nextYearProposal(central2027, danishHolidayName)
  if (!proposal) throw new Error("the 2027 fixture proposes no next year")

  test("the form values name the year, cover it, list its dates and follow the previous record's settings", () => {
    const values = yearProposalFormValues(proposal, FIXTURE_PROJECT_IDS.copenhagen, central2027)
    assert.equal(values.calendarName, "Copenhagen Central 2028")
    assert.equal(values.projectId, FIXTURE_PROJECT_IDS.copenhagen)
    assert.equal(values.validFrom, "2028-01-01")
    assert.equal(values.validTo, "2028-12-31")
    assert.equal(values.weekStart, "monday")
    assert.equal(values.timezone, "Europe/Copenhagen")
    assert.equal(
      values.holidayDates,
      "2028-01-01, 2028-04-13, 2028-04-14, 2028-04-16, 2028-04-17, 2028-05-25, 2028-06-04, 2028-06-05, 2028-12-25, 2028-12-26",
    )
  })

  test("a first year leaves week start and time zone to the form's defaults", () => {
    const values = yearProposalFormValues(proposal, FIXTURE_PROJECT_IDS.copenhagen)
    assert.equal("weekStart" in values, false)
    assert.equal("timezone" in values, false)
  })

  test("the submitted year becomes a calendar record of the project, named, dated and stamped", () => {
    const values = yearProposalFormValues(proposal, FIXTURE_PROJECT_IDS.copenhagen, central2027)
    const record = createYearRecord(proposal, values, {
      actorName: "Olivia Larsen",
      lookups,
      now: 1_790_000_000_000,
    })
    assert.equal(record.id, "calendars-collection-calendar-1790000000000")
    assert.equal(record.name, "Copenhagen Central 2028")
    assert.equal(record.status, "Draft")
    assert.equal(record.owner, "Olivia Larsen")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.submittedValues?.validFrom, "2028-01-01")
    assert.equal(record.submittedValues?.holidayDates, values.holidayDates)
    assert.deepEqual(
      calendarHolidayEntries(record, () => undefined).slice(0, 2),
      [
        { date: "2028-01-01", name: "New Year's Day" },
        { date: "2028-04-13", name: "Maundy Thursday" },
      ],
    )
    assert.equal(record.facts.Project, "Copenhagen Central")
    // The clock is the module's when a caller does not hand one in.
    assert.match(createYearRecord(proposal, values, { actorName: "x", lookups }).id, /^calendars-collection-calendar-\d{13}$/)
  })

  test("the names written are the proposal's for the dates the form kept", () => {
    const names = JSON.parse(
      proposalHolidayNames(proposal, { holidayDates: "2028-12-25, 2028-04-13, 2028-08-15" }),
    ) as Record<string, string>
    assert.deepEqual(names, { "2028-04-13": "Maundy Thursday", "2028-12-25": "Christmas Day" })
    assert.equal(proposalHolidayNames(proposal, { holidayDates: "" }), "")
  })
})
