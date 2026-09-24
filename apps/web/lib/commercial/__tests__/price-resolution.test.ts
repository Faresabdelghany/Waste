// resolvePrice is RESOLUTION_RULE run as code: the row matching the most
// conditions wins, a negotiated row for the customer always wins, and a tie
// goes to the newest effective-from date. Holding the resolver to the
// sentence is what keeps the sentence honest (issue #22).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { PriceRowModel } from "../price-model"
import { resolvePrice } from "../price-resolution"

const row = (id: string, overrides: Partial<PriceRowModel> = {}): PriceRowModel => ({
  id,
  productId: "product-x",
  amount: 10,
  unit: "pickup",
  conditions: {},
  effectiveFrom: "2026-01-01",
  ...overrides,
})

const input = { zone: "Harbor", customerType: "Commercial", date: "2026-08-20" }

describe("resolvePrice follows RESOLUTION_RULE", () => {
  test("the row matching the most conditions wins", () => {
    const rows = [
      row("everyone"),
      row("harbor", { conditions: { zone: "Harbor" }, amount: 12 }),
      row("harbor-commercial", { conditions: { zone: "Harbor", customerType: "Commercial" }, amount: 14 }),
    ]
    const resolution = resolvePrice(rows, 0.25, input)
    assert.equal(resolution.winner?.row.id, "harbor-commercial")
    assert.equal(resolution.base, 14)
  })

  test("a negotiated row for the customer wins over any conditions", () => {
    const rows = [
      row("harbor-commercial", { conditions: { zone: "Harbor", customerType: "Commercial" }, amount: 14 }),
      row("deal", { negotiatedCustomer: "Nørrebro CoWork ApS", amount: 9 }),
    ]
    assert.equal(
      resolvePrice(rows, 0.25, { ...input, customer: "Nørrebro CoWork ApS" }).winner?.row.id,
      "deal",
    )
    // For anyone else the deal is not eligible at all.
    const other = resolvePrice(rows, 0.25, input)
    assert.equal(other.winner?.row.id, "harbor-commercial")
    assert.equal(other.verdicts.find((verdict) => verdict.row.id === "deal")?.eligible, false)
  })

  test("a tie goes to the row with the newest effective-from date", () => {
    const rows = [
      row("older", { conditions: { zone: "Harbor" }, effectiveFrom: "2026-01-01", amount: 12 }),
      row("newer", { conditions: { zone: "Harbor" }, effectiveFrom: "2026-03-01", amount: 13 }),
    ]
    assert.equal(resolvePrice(rows, 0.25, input).winner?.row.id, "newer")
  })

  test("a row outside its effective period does not compete", () => {
    const rows = [
      row("everyone"),
      row("expired", { conditions: { zone: "Harbor" }, effectiveTo: "2026-06-30", amount: 12 }),
      row("scheduled", { conditions: { zone: "Harbor" }, effectiveFrom: "2027-01-01", amount: 13 }),
    ]
    assert.equal(resolvePrice(rows, 0.25, input).winner?.row.id, "everyone")
  })
})
