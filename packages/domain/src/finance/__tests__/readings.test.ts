// The three readings over every combination: a billable event's status over
// its two stamps and the two rows that may name it, an unload's review status
// over the latest decision or none, and a line's credit standing over what
// has been credited of it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { billableEventStatus, creditStanding, isReady, weightReviewStatus, type BillableEventReading } from "../readings"
import { BLOCK_REASONS, WEIGHT_REVIEW_DECISIONS } from "../vocabulary"

const STAMP = new Date("2026-10-05T12:00:00Z")

describe("billableEventStatus", () => {
  test("is ready with no block, no cancellation, no line and no reversal, and blocked with a reason alone", () => {
    assert.equal(billableEventStatus({ blockReason: null, cancelledAt: null, invoiced: false, reversed: false }), "ready")
    for (const blockReason of BLOCK_REASONS) assert.equal(billableEventStatus({ blockReason, cancelledAt: null, invoiced: false, reversed: false }), "blocked", blockReason)
    assert.equal(isReady({ blockReason: null, cancelledAt: null, invoiced: false, reversed: false }), true)
    assert.equal(isReady({ blockReason: "no-product", cancelledAt: null, invoiced: false, reversed: false }), false)
  })

  test("the later fact wins where two hold: a cancelled blocked event is cancelled, an invoiced event reversed is reversed, over every combination", () => {
    const readings: [BillableEventReading, string][] = []
    for (const blockReason of [null, "no-price-row"] as const) {
      for (const cancelledAt of [null, STAMP, "2026-10-05T12:00:00Z"]) {
        for (const invoiced of [false, true]) {
          for (const reversed of [false, true]) {
            const reading = { blockReason, cancelledAt, invoiced, reversed }
            const expected = reversed ? "reversed" : invoiced ? "invoiced" : cancelledAt !== null ? "cancelled" : blockReason !== null ? "blocked" : "ready"
            readings.push([reading, expected])
          }
        }
      }
    }
    assert.equal(readings.length, 24)
    for (const [reading, expected] of readings) assert.equal(billableEventStatus(reading), expected, JSON.stringify(reading))
    // A cancellation stamp of any kind counts: the fold reads null and nothing else as none.
    assert.equal(billableEventStatus({ blockReason: null, cancelledAt: STAMP, invoiced: false, reversed: false }), "cancelled")
    assert.equal(billableEventStatus({ blockReason: null, cancelledAt: undefined, invoiced: false, reversed: false }), "ready")
  })
})

describe("weightReviewStatus", () => {
  test("is the latest decision, or captured when nobody has looked", () => {
    assert.equal(weightReviewStatus(null), "captured")
    for (const decision of WEIGHT_REVIEW_DECISIONS) assert.equal(weightReviewStatus(decision), decision)
  })
})

describe("creditStanding", () => {
  test("is uncredited at nothing, partially credited below the quantity, credited at or past it", () => {
    assert.equal(creditStanding(5, 0), "uncredited")
    assert.equal(creditStanding(5, 1), "partially-credited")
    assert.equal(creditStanding(5, 4), "partially-credited")
    assert.equal(creditStanding(5, 5), "credited")
    assert.equal(creditStanding(1, 1), "credited")
    // The route holds a credit to what remains; a fold over rows that somehow passed it reads as credited rather than as an error.
    assert.equal(creditStanding(5, 6), "credited")
    assert.equal(creditStanding(5, -1), "uncredited")
  })
})
