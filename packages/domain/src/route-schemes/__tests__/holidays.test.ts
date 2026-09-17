import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { danishHolidayName } from "../holiday-names"
import {
  holidayListFromDates,
  projectHolidayCalendars,
  projectHolidayDates,
  schemeHolidayPolicy,
  schemeProjectId,
} from "../holidays"

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
  // Harbor's calendar carries no holiday dates.
  stub("cal-harbor", "Harbor Offices service calendar", {
    projectIds: ["project-harbor"],
    submittedValues: { holidayDates: "", validFrom: "2026-09-01" },
  }),
]

describe("project holiday dates", () => {
  test("the per-year records with dates, earliest validity first", () => {
    assert.deepEqual(
      projectHolidayCalendars("project-copenhagen", calendars).map((record) => record.id),
      ["cal-user", "cal-2026", "cal-2027"],
    )
    assert.deepEqual(projectHolidayCalendars("project-harbor", calendars), [])
    assert.deepEqual(projectHolidayCalendars(undefined, calendars), [])
  })

  test("the union of the project's dates, sorted and deduplicated", () => {
    assert.deepEqual(projectHolidayDates("project-copenhagen", calendars), [
      "2026-06-05",
      "2026-12-25",
      "2026-12-26",
      "2027-01-01",
      "2027-12-25",
    ])
    assert.deepEqual(projectHolidayDates("project-harbor", calendars), [])
  })

  test("holidayListFromDates names each date through the given lookup", () => {
    assert.deepEqual(
      [...holidayListFromDates(["2026-12-26", "2026-12-25", "not-a-date"], danishHolidayName).entries()],
      [
        ["2026-12-25", "Christmas Day"],
        ["2026-12-26", "2nd Christmas Day"],
      ],
    )
  })
})

describe("scheme readers", () => {
  test("the scheme's project — typed field first, record scope second", () => {
    const typed = stub("s1", "Typed", {
      projectIds: ["project-harbor"],
      submittedValues: { projectId: "project-copenhagen" },
    })
    assert.equal(schemeProjectId(typed), "project-copenhagen")
    assert.equal(schemeProjectId(stub("s2", "Scoped", { projectIds: ["project-copenhagen"] })), "project-copenhagen")
    assert.equal(schemeProjectId(stub("s3", "None")), undefined)
  })

  test("a record without a stored policy skips holidays", () => {
    assert.equal(schemeHolidayPolicy({ holidayPolicy: "shift-next" }), "shift-next")
    assert.equal(schemeHolidayPolicy({}), "skip")
    assert.equal(schemeHolidayPolicy(undefined), "skip")
  })
})
