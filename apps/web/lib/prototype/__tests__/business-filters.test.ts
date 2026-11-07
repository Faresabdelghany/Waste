import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  BUSINESS_FILTER_CHIP_LABELS,
  BUSINESS_FILTER_KEYS,
  businessFilterChips,
  emptyBusinessFilters,
  matchesBusinessFilters,
  removeBusinessFilterValue,
  type BusinessFilters,
} from "../business-filters"
import type { BusinessRecord } from "../prototype-record"

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

describe("the Resolution lists' categories (#147)", () => {
  test("a ticket's openness, kind and assignee and an alert's severity are categories of their own, chipped under their own labels", () => {
    const resolution = filters({ openness: ["Open"], kinds: ["Missed collection"], severities: ["High"], assignees: ["Mine"] })
    assert.deepEqual(businessFilterChips(resolution), [
      { key: "openness", label: "Open or closed", value: "Open" },
      { key: "kinds", label: "Kind", value: "Missed collection" },
      { key: "severities", label: "Severity", value: "High" },
      { key: "assignees", label: "Assignee", value: "Mine" },
    ])
  })

  test("match through a surface's readers alone: a category the surface reads nothing for is ignored", () => {
    const record = { facts: { Kind: "Overflow" }, status: "Open" } as unknown as BusinessRecord
    const readers = { openness: () => ["Open"], kinds: (row: BusinessRecord) => [row.facts.Kind ?? ""] }
    assert.ok(matchesBusinessFilters(record, filters({ openness: ["Open"], kinds: ["Overflow"] }), readers))
    assert.ok(!matchesBusinessFilters(record, filters({ openness: ["Closed"] }), readers))
    assert.ok(matchesBusinessFilters(record, filters({ severities: ["High"] }), readers), "no severity reader on this surface")
  })

  test("a case's SLA is a category of its own, chipped after the assignee (O4 of #290)", () => {
    assert.deepEqual(businessFilterChips(filters({ assignees: ["Mine"], sla: ["Overdue"] })), [
      { key: "assignees", label: "Assignee", value: "Mine" },
      { key: "sla", label: "SLA", value: "Overdue" },
    ])
  })
})

describe("the Finance lists' categories (#185)", () => {
  test("a row's price list, product, customer, agreement, block reason and billing run are categories of their own, chipped under their own labels", () => {
    const finance = filters({ priceLists: ["PL-Copenhagen-2026"], products: ["Bulky waste pickup"], customers: ["Østerbro Housing"], agreements: ["AGR-2408"], blockReasons: ["No price row"], billingRuns: ["Run of 2026-09-01 to 2026-09-30"] })
    assert.deepEqual(businessFilterChips(finance), [
      { key: "priceLists", label: "Price list", value: "PL-Copenhagen-2026" },
      { key: "products", label: "Product", value: "Bulky waste pickup" },
      { key: "customers", label: "Customer", value: "Østerbro Housing" },
      { key: "agreements", label: "Agreement", value: "AGR-2408" },
      { key: "blockReasons", label: "Block reason", value: "No price row" },
      { key: "billingRuns", label: "Billing run", value: "Run of 2026-09-01 to 2026-09-30" },
    ])
  })
})
