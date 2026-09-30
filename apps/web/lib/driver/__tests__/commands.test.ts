// The Driver App's commands (Issue #145): the nine kinds the pilot sends, which
// of them carry a position, and the ids the browser mints for them — UUIDv7
// through @waste/domain/ids over the browser's clock and randomness, each
// after the last so the queue's key order is the order of the taps.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BATCH_MAX } from "@waste/contracts/driver-commands"
import { DRIVER_COMMAND_KINDS } from "@waste/domain/execution/vocabulary"

import { BATCH_LIMIT, createCommandIds, PILOT_COMMAND_KINDS, pickupIdOf, takesLocation } from "../commands"

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("the pilot's commands", () => {
  test("are nine of the door's fourteen, never arrive or the evidence kinds", () => {
    assert.deepEqual([...PILOT_COMMAND_KINDS].sort(), ["complete-pickup", "end-route", "fail-pickup", "pause", "record-unload", "report-problem", "resume", "skip-pickup", "start-route"])
    for (const kind of PILOT_COMMAND_KINDS) assert.ok((DRIVER_COMMAND_KINDS as readonly string[]).includes(kind), kind)
  })

  test("go at most as many to a batch as the door takes, spelled again here so no zod reaches the browser", () => {
    assert.equal(BATCH_LIMIT, BATCH_MAX)
  })

  test("every one carries a position but pause and resume, whose bodies take nothing", () => {
    assert.deepEqual(
      PILOT_COMMAND_KINDS.filter((kind) => !takesLocation(kind)),
      ["pause", "resume"],
    )
  })

  test("a command names its stop by the body's pickup id, and a route-level one names none", () => {
    assert.equal(pickupIdOf({ kind: "complete-pickup", body: { pickupId: "p-1" } }), "p-1")
    assert.equal(pickupIdOf({ kind: "report-problem", body: { pickupId: "p-2", reason: "other", note: "Gate locked" } }), "p-2")
    assert.equal(pickupIdOf({ kind: "report-problem", body: { reason: "safety", note: "Road closed" } }), null)
    assert.equal(pickupIdOf({ kind: "pause", body: {} }), null)
  })
})

describe("command ids", () => {
  const zeros = (bytes: Uint8Array) => bytes.fill(0)

  test("are UUIDv7 over the clock given, strictly increasing within one millisecond", () => {
    const next = createCommandIds({ now: () => 1_800_000_000_000, fill: zeros })
    const first = next()
    const second = next()
    assert.match(first, UUID_V7)
    assert.match(second, UUID_V7)
    assert.ok(second > first)
    // The clock is the id's first 48 bits.
    assert.equal(parseInt(first.replaceAll("-", "").slice(0, 12), 16), 1_800_000_000_000)
  })

  test("follow the last id the queue holds, even on a clock that ran backwards across a reload", () => {
    const before = createCommandIds({ now: () => 1_800_000_000_000, fill: zeros })()
    const next = createCommandIds({ now: () => 1_799_999_999_000, fill: zeros, after: before })
    assert.ok(next() > before)
  })
})
