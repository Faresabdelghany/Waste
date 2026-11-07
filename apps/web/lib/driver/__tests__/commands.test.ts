// The Driver App's commands (Issue #145, O1, O2 and O8 of #290, M11 and M23 of #293): the door's seventeen kinds, which
// of them carry a position or name an object, and the ids the browser mints for them — UUIDv7
// through @waste/domain/ids over the browser's clock and randomness, each
// after the last so the queue's key order is the order of the taps.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { COMMAND_BODIES } from "@waste/contracts/driver-commands"
import { DRIVER_COMMAND_KINDS } from "@waste/domain/execution/vocabulary"

import { createCommandIds, OBJECT_KINDS, pickupIdOf, wholeKilograms } from "../commands"

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("the pilot's commands", () => {
  test("name an object in Storage exactly where the body requires a key: the photo and the signature, whose bytes go first", () => {
    assert.deepEqual(
      DRIVER_COMMAND_KINDS.filter((kind) => "objectKey" in COMMAND_BODIES[kind].shape && !COMMAND_BODIES[kind].shape.objectKey.safeParse(undefined).success),
      [...OBJECT_KINDS],
    )
  })

  test("carry a weight in whole kilograms as typed: an exponent is its number, a fraction or a blank no weight", () => {
    assert.equal(wholeKilograms("212"), 212)
    assert.equal(wholeKilograms("1e3"), 1000, "a number input lets an exponent through; parseInt would read 1")
    assert.equal(wholeKilograms("12.5"), undefined)
    assert.equal(wholeKilograms(""), undefined)
    assert.equal(wholeKilograms("  "), undefined)
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
