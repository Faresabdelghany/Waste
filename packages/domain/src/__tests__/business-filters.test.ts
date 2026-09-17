import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  BUSINESS_FILTER_CHIP_LABELS,
  BUSINESS_FILTER_KEYS,
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

  test("every category yields a chip whose label is the category's label, in category order", () => {
    const one = Object.fromEntries(BUSINESS_FILTER_KEYS.map((key) => [key, ["v"]])) as BusinessFilters
    const chips = businessFilterChips(one)
    assert.deepEqual(
      chips.map((chip) => chip.key),
      [...BUSINESS_FILTER_KEYS],
    )
    for (const chip of chips) assert.equal(chip.label, BUSINESS_FILTER_CHIP_LABELS[chip.key])
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
