// The wire of right-sizing proposals (M23 of #293): what a proposal carries,
// and the approve and dismiss bodies, strict.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RightSizingApprove, RightSizingDismiss, RightSizingProposal } from "../right-sizing"

const ID = "018f7c31-a000-7000-8000-000000000001"
const WHEN = "2026-10-29T08:00:00.000Z"

describe("a right-sizing proposal", () => {
  test("carries its direction, its suggestion, its evidence and its decision", () => {
    const open = { id: ID, createdAt: WHEN, updatedAt: WHEN, projectId: ID, subscriptionId: ID, productId: ID, direction: "smaller", suggestedProductId: ID, evidence: ["quarter", "half", "empty", "quarter"], evidenceThrough: WHEN, status: "open", decidedAt: null, decidedBy: null, dismissNote: null, changedOn: null, replacementSubscriptionId: null }
    assert.deepEqual(RightSizingProposal.parse(open), open)
    assert.equal(RightSizingProposal.safeParse({ ...open, direction: "sideways" }).success, false)
  })

  test("approve takes a day and a product, both optional; dismiss says why", () => {
    assert.deepEqual(RightSizingApprove.parse({}), {})
    assert.deepEqual(RightSizingApprove.parse({ on: "2026-11-01", productId: ID }), { on: "2026-11-01", productId: ID })
    assert.equal(RightSizingApprove.safeParse({ on: "2026-11-01", status: "approved" }).success, false, "the server owns the status")
    assert.equal(RightSizingDismiss.safeParse({}).success, false)
    assert.equal(RightSizingDismiss.safeParse({ note: "The customer is moving out" }).success, true)
  })
})
