import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import {
  parseHolidayNames,
  schemeHolidayPolicy,
  schemeProjectId,
  serializeHolidayNames,
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

describe("a holiday list's dates and names as a record spells them", () => {
  test("parseHolidayNames reads the JSON object a record carries and nothing else", () => {
    assert.deepEqual(
      [...parseHolidayNames(JSON.stringify({ "2027-01-01": "New Year's Day", "2027-03-08": "" })).entries()],
      [["2027-01-01", "New Year's Day"]],
    )
    assert.equal(parseHolidayNames(JSON.stringify({ "not-a-date": "Name", "2027-01-01": 3 })).size, 0)
    assert.equal(parseHolidayNames("not json").size, 0)
    assert.equal(parseHolidayNames(JSON.stringify(["2027-01-01"])).size, 0)
    assert.equal(parseHolidayNames(undefined).size, 0)
    assert.equal(parseHolidayNames(true).size, 0)
  })

  test("serializeHolidayNames writes the keys in date order, and nothing for no names", () => {
    assert.equal(
      serializeHolidayNames(new Map([["2027-12-25", "Christmas Day"], ["2027-01-01", "New Year's Day"]])),
      JSON.stringify({ "2027-01-01": "New Year's Day", "2027-12-25": "Christmas Day" }),
    )
    assert.equal(serializeHolidayNames(new Map()), "")
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
