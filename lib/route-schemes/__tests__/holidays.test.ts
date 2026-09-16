import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import {
  NO_HOLIDAY_LIST_LABEL,
  holidayListName,
  holidaySourceLabel,
  projectHolidayList,
  projectHolidaySource,
  schemeHolidayListName,
  schemeProjectId,
} from "../holidays"
import { schemeGenerationCalendar } from "../project-calendar"

function stub(
  id: string,
  name: string,
  extra: Partial<BusinessRecord> = {},
): BusinessRecord {
  return {
    id,
    name,
    context: "",
    status: "Active",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {},
    related: [],
    source: "",
    freshness: "",
    allowedTransitions: [],
    ...extra,
  }
}

const copenhagen = stub("project-copenhagen", "Copenhagen Central", {
  facts: { Timezone: "Europe/Copenhagen" },
})
const harbor = stub("project-harbor", "Harbor Commercial", { facts: { Timezone: "Europe/Copenhagen" } })
const cairo = stub("project-cairo", "Cairo", { submittedValues: { timezone: "Africa/Cairo" } })

const calendars: BusinessRecord[] = [
  stub("cal-2027", "Copenhagen Central 2027", {
    projectIds: ["project-copenhagen"],
    submittedValues: {
      holidayDates: "2027-01-01, 2027-12-25",
      validFrom: "2027-01-01",
      validTo: "2027-12-31",
    },
  }),
  stub("cal-2026", "Copenhagen Central 2026", {
    projectIds: ["project-copenhagen"],
    submittedValues: {
      holidayDates: "2026-12-25, 2026-12-26",
      validFrom: "2026-01-01",
      validTo: "2026-12-31",
    },
  }),
  // A form-created calendar scoped through its typed project field.
  stub("cal-user", "User list", {
    submittedValues: { projectId: "project-copenhagen", holidayDates: "2026-06-05" },
  }),
  // Harbor's calendar carries no holiday dates — no holiday list.
  stub("cal-harbor", "Harbor Offices service calendar", {
    projectIds: ["project-harbor"],
    submittedValues: { holidayDates: "", validFrom: "2026-09-01" },
  }),
]

describe("project holiday source", () => {
  test("unions the project's per-year lists, earliest validity first, with names", () => {
    const source = projectHolidaySource(copenhagen, calendars)
    assert.ok(source)
    assert.equal(source.name, "Danish public holidays")
    assert.equal(source.projectName, "Copenhagen Central")
    assert.deepEqual(
      source.records.map((record) => record.id),
      ["cal-user", "cal-2026", "cal-2027"],
    )
    assert.deepEqual(
      [...source.list.entries()],
      [
        ["2026-06-05", "Constitution Day"],
        ["2026-12-25", "Christmas Day"],
        ["2026-12-26", "2nd Christmas Day"],
        ["2027-01-01", "New Year's Day"],
        ["2027-12-25", "Christmas Day"],
      ],
    )
    assert.equal(holidaySourceLabel(source), "Danish public holidays · from project Copenhagen Central")
  })

  test("a project whose calendars hold no dates has no list", () => {
    assert.equal(projectHolidaySource(harbor, calendars), null)
    assert.equal(projectHolidayList("project-harbor", calendars).size, 0)
    assert.equal(holidaySourceLabel(null), NO_HOLIDAY_LIST_LABEL)
    assert.equal(projectHolidaySource(undefined, calendars), null)
  })

  test("the list name follows the project's time zone, generic otherwise", () => {
    assert.equal(holidayListName(copenhagen), "Danish public holidays")
    assert.equal(holidayListName(cairo), "Egyptian public holidays")
    assert.equal(holidayListName(stub("p", "Anywhere")), "Public holidays")
    assert.equal(holidayListName(undefined), "Public holidays")
  })
})

describe("scheme holiday list", () => {
  test("resolves through the scheme's project — typed field first, record scope second", () => {
    const typed = stub("s1", "Typed", {
      projectIds: ["project-harbor"],
      submittedValues: { projectId: "project-copenhagen" },
    })
    const scoped = stub("s2", "Scoped", { projectIds: ["project-copenhagen"] })
    const none = stub("s3", "None")
    assert.equal(schemeProjectId(typed), "project-copenhagen")
    assert.equal(schemeProjectId(scoped), "project-copenhagen")
    assert.equal(schemeProjectId(none), undefined)
    const projects = [copenhagen, harbor]
    const holidaysOf = (scheme: BusinessRecord) =>
      schemeGenerationCalendar(scheme, { projects, calendars }).holidays.size
    assert.equal(holidaysOf(typed), 5)
    assert.equal(holidaysOf(scoped), 5)
    assert.equal(holidaysOf(none), 0)
    assert.equal(schemeHolidayListName(typed, calendars, projects), "Danish public holidays")
    assert.equal(schemeHolidayListName(stub("s4", "Harbor", { projectIds: ["project-harbor"] }), calendars, projects), "—")
  })
})
