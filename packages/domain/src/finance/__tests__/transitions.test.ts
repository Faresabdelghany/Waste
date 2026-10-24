import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { closedSettlement, correctedUnload, notCalculated, periodNotBegun, periodNotEnded, priceEnded, priceEndedBy, SETTLEMENT_COMMANDS, settlementTransition, weightReviewTransition, type SettlementCommand, type Transition } from "../transitions"
import { SETTLEMENT_STATUSES, WEIGHT_REVIEW_DECISIONS, WEIGHT_REVIEW_STATUSES, type SettlementStatus, type WeightReviewDecision, type WeightReviewStatus } from "../vocabulary"

const LABEL = "NordRen · July 2026"
const NOT_CALCULATED = "Settlement NordRen · July 2026 has not been calculated; calculate it first"
const CLOSED = "Settlement NordRen · July 2026 is closed; reopen it first"
const NOT_BEGUN = "Settlement NordRen · July 2026 has not begun; calculate it from its first day"
const NOT_ENDED = "Settlement NordRen · July 2026 has not ended; close it after its last day"

/** July 2026, by its first and last day in. */
const JULY = { label: LABEL, firstDay: "2026-07-01", lastDay: "2026-07-31" }
/** The project's days the machine is asked on: before the period, its first day, its last day, and the day after it. */
const BEFORE = "2026-06-30"
const FIRST = "2026-07-01"
const LAST = "2026-07-31"
const AFTER = "2026-08-01"
const july = (status: SettlementStatus, command: SettlementCommand, today: string) => settlementTransition({ ...JULY, status }, command, today)

/** The settlement machine spelled out once the period has ended, status by status and command by command, so the function is pinned in words and not only in itself. */
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
  test("every status under every command once the period has ended, as the table spells it: nine pairs", () => {
    let pairs = 0
    for (const status of SETTLEMENT_STATUSES) {
      for (const command of SETTLEMENT_COMMANDS) {
        assert.deepEqual(july(status, command, AFTER), settlementTable[status][command], `${status} under ${command}`)
        pairs += 1
      }
    }
    assert.equal(pairs, 9)
    assert.deepEqual([...SETTLEMENT_COMMANDS], ["calculate", "close", "reopen"])
  })

  test("a recalculation is a move, since the lines change; a close needs a calculation; a closed settlement is reopened first, and reopening an open one is nothing to do", () => {
    assert.deepEqual(july("calculated", "calculate", AFTER), { kind: "move", to: "calculated" })
    assert.deepEqual(july("open", "close", AFTER), { kind: "refuse", sentence: notCalculated(LABEL) })
    assert.deepEqual(july("closed", "calculate", AFTER), { kind: "refuse", sentence: closedSettlement(LABEL) })
    assert.deepEqual(july("closed", "reopen", AFTER), { kind: "move", to: "open" })
    for (const status of ["open", "calculated"] as const) assert.deepEqual(july(status, "reopen", AFTER), { kind: "stay" }, status)
    assert.deepEqual(july("closed", "close", AFTER), { kind: "stay" })
    assert.equal(notCalculated("CityHaul · Q3 2026"), "Settlement CityHaul · Q3 2026 has not been calculated; calculate it first")
    assert.equal(closedSettlement("CityHaul · Q3 2026"), "Settlement CityHaul · Q3 2026 is closed; reopen it first")
  })

  test("a period not begun takes no calculation and one not ended no close, each naming the period: it is calculated from its first day and closed the day after its last (#260)", () => {
    for (const status of ["open", "calculated"] as const) {
      assert.deepEqual(july(status, "calculate", BEFORE), { kind: "refuse", sentence: NOT_BEGUN }, `${status}, the day before`)
      for (const today of [FIRST, LAST, AFTER]) assert.deepEqual(july(status, "calculate", today), { kind: "move", to: "calculated" }, `${status} on ${today}`)
    }
    for (const today of [BEFORE, FIRST, LAST]) assert.deepEqual(july("calculated", "close", today), { kind: "refuse", sentence: NOT_ENDED }, `closed on ${today}`)
    assert.deepEqual(july("calculated", "close", AFTER), { kind: "move", to: "closed" })
    assert.equal(periodNotBegun(LABEL), NOT_BEGUN)
    assert.equal(periodNotEnded(LABEL), NOT_ENDED)
  })

  test("the status is judged before the day: an open settlement is calculated first, a closed one reopened first; a closed one closed again stays, and reopen reads no day", () => {
    for (const today of [BEFORE, FIRST, LAST]) {
      assert.deepEqual(july("open", "close", today), { kind: "refuse", sentence: NOT_CALCULATED }, `open, closed on ${today}`)
      assert.deepEqual(july("closed", "calculate", today), { kind: "refuse", sentence: CLOSED }, `closed, calculated on ${today}`)
      assert.deepEqual(july("closed", "close", today), { kind: "stay" }, `closed again on ${today}`)
      assert.deepEqual(july("closed", "reopen", today), { kind: "move", to: "open" }, `reopened on ${today}`)
      for (const status of ["open", "calculated"] as const) assert.deepEqual(july(status, "reopen", today), { kind: "stay" }, `${status} reopened on ${today}`)
    }
  })

  test("a period of one day is begun and not ended on that day, and ended the day after", () => {
    const day = { label: LABEL, firstDay: FIRST, lastDay: FIRST }
    assert.deepEqual(settlementTransition({ ...day, status: "open" }, "calculate", FIRST), { kind: "move", to: "calculated" })
    assert.deepEqual(settlementTransition({ ...day, status: "calculated" }, "close", FIRST), { kind: "refuse", sentence: NOT_ENDED })
    assert.deepEqual(settlementTransition({ ...day, status: "calculated" }, "close", "2026-07-02"), { kind: "move", to: "closed" })
  })
})

describe("a provider price's indexation", () => {
  test("a price has ended by the day its validTo, the first day out, is on or before: an open one never, one ending in March from the first of March (#281)", () => {
    assert.equal(priceEndedBy(null, "2030-01-01"), false)
    assert.equal(priceEndedBy("2026-03-01", "2026-02-28"), false, "its last day in")
    assert.equal(priceEndedBy("2026-03-01", "2026-03-01"), true, "the first day out")
    assert.equal(priceEndedBy("2026-03-01", "2026-12-01"), true)
  })

  test("an ended price is named by its last day in, the day its details read as Valid to, never the wire's first day out (#281)", () => {
    assert.equal(priceEnded("2026-03-01"), "This price was valid to 2026-02-28; index the price in force")
    assert.equal(priceEnded("2027-01-01"), "This price was valid to 2026-12-31; index the price in force", "across a year")
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
