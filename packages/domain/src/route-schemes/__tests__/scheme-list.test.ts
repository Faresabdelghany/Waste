import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { schemeListContext, schemeWasteFractionLabel } from "../scheme-list"

function stub(extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id: "s",
    name: "Scheme",
    context: "",
    status: "Validated",
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

describe("the row context (#254): the project, then the planning area where the scheme has one, then its service days", () => {
  const areas = [stub({ id: "area-indreby", name: "Indre By Operations" })]
  const weekdays = "monday, tuesday, wednesday, thursday, friday"

  test("a scheme in an area names its project and its area, so every row starts with the same kind", () => {
    const scheme = stub({ submittedValues: { planningAreaId: "area-indreby", serviceDays: weekdays } })
    assert.equal(schemeListContext(scheme, areas, "Copenhagen Central"), "Copenhagen Central · Indre By Operations · Mon–Fri")
  })

  test("a scheme without an area names its project alone", () => {
    assert.equal(schemeListContext(stub({ submittedValues: { serviceDays: "tuesday, thursday" } }), areas, "Copenhagen Central"), "Copenhagen Central · Tue/Thu")
  })

  test("a record without a stored project names its area and its days, never an invented project", () => {
    assert.equal(schemeListContext(stub({ submittedValues: { planningAreaId: "area-indreby", serviceDays: weekdays } }), areas, ""), "Indre By Operations · Mon–Fri")
  })

  test("a record without structured days still names its scope; with nothing, the empty fact", () => {
    assert.equal(schemeListContext(stub({ submittedValues: { planningAreaId: "area-indreby" } }), areas, "Copenhagen Central"), "Copenhagen Central · Indre By Operations")
    assert.equal(schemeListContext(stub(), areas, ""), "—")
  })
})

describe("Waste fraction column", () => {
  test("the typed scheme fraction first, then the display fact, then the stop rule's fractions", () => {
    assert.equal(schemeWasteFractionLabel(stub({ submittedValues: { wasteFraction: "Organic" } })), "Organic")
    assert.equal(schemeWasteFractionLabel(stub({ facts: { "Waste fraction": "Glass" } })), "Glass")
    assert.equal(
      schemeWasteFractionLabel(
        stub({ submittedValues: { stopSelection: "rule", matchFractions: "Paper, Cardboard" } }),
      ),
      "Paper, Cardboard",
    )
    assert.equal(schemeWasteFractionLabel(stub()), "—")
  })

})
