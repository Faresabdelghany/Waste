import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { closedSettlement, correctedUnload, notCalculated, SETTLEMENT_COMMANDS, settlementTransition, weightReviewTransition, type SettlementCommand, type Transition } from "../transitions"
import { SETTLEMENT_STATUSES, WEIGHT_REVIEW_DECISIONS, WEIGHT_REVIEW_STATUSES, type SettlementStatus, type WeightReviewDecision, type WeightReviewStatus } from "../vocabulary"

const LABEL = "NordRen · July 2026"
const NOT_CALCULATED = "Settlement NordRen · July 2026 has not been calculated; calculate it first"
const CLOSED = "Settlement NordRen · July 2026 is closed; reopen it first"

/** The settlement machine spelled out, status by status and command by command, so the function is pinned in words and not only in itself. */
const settlementTable: Record<SettlementStatus, Record<SettlementCommand, Transition<SettlementStatus>>> = {
  open: {
    calculate: { kind: "move", to: "calculated" },
    close: { kind: "refuse", sentence: NOT_CALCULATED },
    reopen: { kind: "stay" },
  },
  calculated: {
    calculate: { kind: "move", to: "calculated" },
    close: { kind: "move", to: "closed" },
    reopen: { kind: "stay" },
  },
  closed: {
    calculate: { kind: "refuse", sentence: CLOSED },
    close: { kind: "stay" },
    reopen: { kind: "move", to: "open" },
  },
}

describe("settlementTransition", () => {
  test("every status under every command, as the table spells it: nine pairs", () => {
    let pairs = 0
    for (const status of SETTLEMENT_STATUSES) {
      for (const command of SETTLEMENT_COMMANDS) {
        assert.deepEqual(settlementTransition(status, command, LABEL), settlementTable[status][command], `${status} under ${command}`)
        pairs += 1
      }
    }
    assert.equal(pairs, 9)
    assert.deepEqual([...SETTLEMENT_COMMANDS], ["calculate", "close", "reopen"])
  })

  test("a recalculation is a move, since the lines change; a close needs a calculation; a closed settlement is reopened first, and reopening an open one is nothing to do", () => {
    assert.deepEqual(settlementTransition("calculated", "calculate", LABEL), { kind: "move", to: "calculated" })
    assert.deepEqual(settlementTransition("open", "close", LABEL), { kind: "refuse", sentence: notCalculated(LABEL) })
    assert.deepEqual(settlementTransition("closed", "calculate", LABEL), { kind: "refuse", sentence: closedSettlement(LABEL) })
    assert.deepEqual(settlementTransition("closed", "reopen", LABEL), { kind: "move", to: "open" })
    for (const status of ["open", "calculated"] as const) assert.deepEqual(settlementTransition(status, "reopen", LABEL), { kind: "stay" }, status)
    assert.deepEqual(settlementTransition("closed", "close", LABEL), { kind: "stay" })
    assert.equal(notCalculated("CityHaul · Q3 2026"), "Settlement CityHaul · Q3 2026 has not been calculated; calculate it first")
    assert.equal(closedSettlement("CityHaul · Q3 2026"), "Settlement CityHaul · Q3 2026 is closed; reopen it first")
  })
})

const CORRECTION = "018f7c34-a000-7000-8000-0000000000c1"
const CORRECTED = "This unload was corrected by unload 018f7c34-a000-7000-8000-0000000000c1; review that one"

/** The review machine spelled out. */
const reviewTable: Record<WeightReviewStatus, Record<WeightReviewDecision, Transition<WeightReviewStatus>>> = {
  captured: {
    approved: { kind: "move", to: "approved" },
    rejected: { kind: "move", to: "rejected" },
    corrected: { kind: "move", to: "corrected" },
  },
  approved: {
    approved: { kind: "stay" },
    rejected: { kind: "move", to: "rejected" },
    corrected: { kind: "move", to: "corrected" },
  },
  rejected: {
    approved: { kind: "move", to: "approved" },
    rejected: { kind: "stay" },
    corrected: { kind: "move", to: "corrected" },
  },
  corrected: {
    approved: { kind: "refuse", sentence: CORRECTED },
    rejected: { kind: "refuse", sentence: CORRECTED },
    corrected: { kind: "refuse", sentence: CORRECTED },
  },
}

describe("weightReviewTransition", () => {
  test("every status under every decision, as the table spells it: twelve pairs", () => {
    let pairs = 0
    for (const status of WEIGHT_REVIEW_STATUSES) {
      for (const decision of WEIGHT_REVIEW_DECISIONS) {
        assert.deepEqual(weightReviewTransition(status, decision, status === "corrected" ? CORRECTION : null), reviewTable[status][decision], `${status} under ${decision}`)
        pairs += 1
      }
    }
    assert.equal(pairs, 12)
  })

  test("the same decision again is nothing to do, a corrected unload takes no decision and names the row to review, and a correction is a decision like the other two", () => {
    assert.deepEqual(weightReviewTransition("approved", "approved", null), { kind: "stay" })
    assert.deepEqual(weightReviewTransition("rejected", "approved", null), { kind: "move", to: "approved" }, "a rejection reconsidered")
    assert.deepEqual(weightReviewTransition("approved", "corrected", null), { kind: "move", to: "corrected" }, "an approved weight corrected after all")
    assert.deepEqual(weightReviewTransition("corrected", "approved", CORRECTION), { kind: "refuse", sentence: correctedUnload(CORRECTION) })
    assert.equal(correctedUnload("x"), "This unload was corrected by unload x; review that one")
    assert.equal(weightReviewTransition("corrected", "corrected", CORRECTION).kind, "refuse", "a second correction goes on the new row, not this one")
  })
})
