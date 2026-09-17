import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { schemeRowSummary, schemeWasteFractionLabel } from "../scheme-list"

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
