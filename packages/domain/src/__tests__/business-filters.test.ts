import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  businessFilterChips,
  emptyBusinessFilters,
  removeBusinessFilterValue,
  type BusinessFilters,
} from "../business-filters"

function filters(picks: Partial<BusinessFilters>): BusinessFilters {
  return { ...emptyBusinessFilters, ...picks }
}

const selected = filters({ wasteFractions: ["Paper", "Glass"], statuses: ["Available"] })

describe("businessFilterChips", () => {
  test("one chip per selected value, in category order, carrying the key it is removed by and the category's label", () => {
    assert.deepEqual(businessFilterChips(selected), [
      { key: "statuses", label: "Status", value: "Available" },
      { key: "wasteFractions", label: "Waste fraction", value: "Paper" },
      { key: "wasteFractions", label: "Waste fraction", value: "Glass" },
    ])
  })

  test("no selection, no chips", () => {
    assert.deepEqual(businessFilterChips(emptyBusinessFilters), [])
  })
})

describe("removeBusinessFilterValue", () => {
  test("removes one value from one category and leaves the rest; the input is not mutated", () => {
    const next = removeBusinessFilterValue(selected, "wasteFractions", "Paper")
    assert.deepEqual(next.wasteFractions, ["Glass"])
    assert.deepEqual(next.statuses, ["Available"])
    assert.deepEqual(selected.wasteFractions, ["Paper", "Glass"])
  })

  test("a value that is not selected leaves the filters as they are, by reference", () => {
    assert.equal(removeBusinessFilterValue(selected, "wasteFractions", "Metal"), selected)
    assert.equal(removeBusinessFilterValue(selected, "drivers", "Paper"), selected)
  })

  test("removing every chip by its own key empties the filters", () => {
    let current = selected
    for (const chip of businessFilterChips(selected)) {
      current = removeBusinessFilterValue(current, chip.key, chip.value)
    }
    assert.deepEqual(current, emptyBusinessFilters)
  })
})
