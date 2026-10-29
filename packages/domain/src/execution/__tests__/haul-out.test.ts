// A transfer station's haul-out (M17 of #293): where an Outbound Load stands
// under each command, the receiving site's net read against our out-weighing,
// and what a station holds.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { isReceived, LOAD_NOT_RECEIVED, LOAD_RECEIVED_NOT_CANCELLED, loadDoesNotChange, materialOnHand, OUTBOUND_LOAD_COMMANDS, outboundLoadTransition, receiptReading } from "../haul-out"
import { OUTBOUND_LOAD_STATUSES, type OutboundLoadStatus } from "../vocabulary"

const after = (status: OutboundLoadStatus) => Object.fromEntries(OUTBOUND_LOAD_COMMANDS.map((command) => [command, outboundLoadTransition(status, command)]))

describe("an outbound load", () => {
  test("departs, is received, then reconciled or disputed; a disputed load is reconciled once settled", () => {
    assert.deepEqual([...OUTBOUND_LOAD_STATUSES], ["departed", "received", "reconciled", "disputed", "cancelled"])
    assert.deepEqual(after("departed"), {
      receive: { kind: "move", to: "received" },
      reconcile: { kind: "refuse", sentence: LOAD_NOT_RECEIVED },
      dispute: { kind: "refuse", sentence: LOAD_NOT_RECEIVED },
      cancel: { kind: "move", to: "cancelled" },
    })
    assert.deepEqual(after("received"), {
      receive: { kind: "move", to: "received" },
      reconcile: { kind: "move", to: "reconciled" },
      dispute: { kind: "move", to: "disputed" },
      cancel: { kind: "refuse", sentence: LOAD_RECEIVED_NOT_CANCELLED },
    })
    assert.deepEqual(after("disputed"), {
      receive: { kind: "move", to: "received" },
      reconcile: { kind: "move", to: "reconciled" },
      dispute: { kind: "stay" },
      cancel: { kind: "refuse", sentence: LOAD_RECEIVED_NOT_CANCELLED },
    })
  })

  test("does not change once reconciled or cancelled, and the command it already had is done", () => {
    assert.deepEqual(after("reconciled"), {
      receive: { kind: "refuse", sentence: loadDoesNotChange("reconciled") },
      reconcile: { kind: "stay" },
      dispute: { kind: "refuse", sentence: loadDoesNotChange("reconciled") },
      cancel: { kind: "refuse", sentence: loadDoesNotChange("reconciled") },
    })
    assert.deepEqual(after("cancelled"), {
      receive: { kind: "refuse", sentence: loadDoesNotChange("cancelled") },
      reconcile: { kind: "refuse", sentence: loadDoesNotChange("cancelled") },
      dispute: { kind: "refuse", sentence: loadDoesNotChange("cancelled") },
      cancel: { kind: "stay" },
    })
    assert.equal(loadDoesNotChange("reconciled"), "The load is reconciled and does not change")
  })

  test("carries the receiving site's ticket from its receipt on", () => {
    assert.deepEqual(
      OUTBOUND_LOAD_STATUSES.filter((status) => isReceived(status)),
      ["received", "reconciled", "disputed"],
    )
  })
})

describe("a receipt", () => {
  test("reads the receiving site's net against ours, in percent of ours, within the tolerance or beyond it", () => {
    assert.deepEqual(receiptReading({ netKg: 20_000, receivedNetKg: 19_200 }, 5), { differenceKg: -800, deviationPercent: -4, withinTolerance: true })
    assert.deepEqual(receiptReading({ netKg: 20_000, receivedNetKg: 21_000 }, 5), { differenceKg: 1000, deviationPercent: 5, withinTolerance: true }, "the bound itself is within")
    assert.deepEqual(receiptReading({ netKg: 20_000, receivedNetKg: 21_001 }, 5), { differenceKg: 1001, deviationPercent: 5, withinTolerance: false }, "judged on the kilograms, not the rounded percent")
    assert.deepEqual(receiptReading({ netKg: 12_345, receivedNetKg: 12_345 }, 0), { differenceKg: 0, deviationPercent: 0, withinTolerance: true })
  })
})

describe("what a transfer station holds", () => {
  test("is what was tipped in, less what was sent on, plus the counts' adjustments, and may read below zero", () => {
    assert.equal(materialOnHand({ inKg: 48_000, outKg: 40_000, adjustedKg: -1_500 }), 6_500)
    assert.equal(materialOnHand({ inKg: 10_000, outKg: 12_000, adjustedKg: 0 }), -2_000)
  })
})
