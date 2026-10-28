// The Driver App's commands (Issue #145, O1, O2 and O8 of #290): the door's fifteen kinds, which
// of them carry a position or name an object, and the ids the browser mints for them — UUIDv7
// through @waste/domain/ids over the browser's clock and randomness, each
// after the last so the queue's key order is the order of the taps.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BATCH_MAX, COMMAND_BODIES } from "@waste/contracts/driver-commands"
import { NO_PROOF_STORAGE } from "@waste/contracts/problem"
import { PARAGRAPH_MAX } from "@waste/contracts/text"
import { DRIVER_COMMAND_KINDS } from "@waste/domain/execution/vocabulary"

import { BATCH_LIMIT, createCommandIds, NOTE_MAX, OBJECT_KINDS, PILOT_COMMAND_KINDS, pickupIdOf, takesLocation, wholeKilograms } from "../commands"
import { NO_PROOF_STORAGE_TYPE } from "../reads"

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("the pilot's commands", () => {
  test("are the door's fifteen", () => {
    assert.deepEqual([...PILOT_COMMAND_KINDS].sort(), [...DRIVER_COMMAND_KINDS].sort())
  })

  test("name an object in Storage exactly where the body requires a key: the photo and the signature, whose bytes go first", () => {
    assert.deepEqual(
      PILOT_COMMAND_KINDS.filter((kind) => "objectKey" in COMMAND_BODIES[kind].shape && !COMMAND_BODIES[kind].shape.objectKey.safeParse(undefined).success),
      [...OBJECT_KINDS],
    )
  })

  test("tell a deployment without Storage by the problem's type, spelled again here the same way", () => {
    assert.equal(NO_PROOF_STORAGE_TYPE, NO_PROOF_STORAGE.type)
  })

  test("go at most as many to a batch as the door takes, spelled again here so no zod reaches the browser", () => {
    assert.equal(BATCH_LIMIT, BATCH_MAX)
  })

  test("carry a note no longer than the door takes, spelled again the same way", () => {
    assert.equal(NOTE_MAX, PARAGRAPH_MAX)
  })

  test("carry a weight in whole kilograms as typed: an exponent is its number, a fraction or a blank no weight", () => {
    assert.equal(wholeKilograms("212"), 212)
    assert.equal(wholeKilograms("1e3"), 1000, "a number input lets an exponent through; parseInt would read 1")
    assert.equal(wholeKilograms("12.5"), undefined)
    assert.equal(wholeKilograms(""), undefined)
    assert.equal(wholeKilograms("  "), undefined)
  })

  test("a command carries a position exactly where its body takes one: never pause, resume, a note, a weight or the positions, whose strict bodies would refuse it", () => {
    assert.deepEqual(
      PILOT_COMMAND_KINDS.filter((kind) => !takesLocation(kind)),
      ["pause", "resume", "add-weight", "add-note", "record-positions"],
    )
    for (const kind of PILOT_COMMAND_KINDS) assert.equal(takesLocation(kind), "location" in COMMAND_BODIES[kind].shape, kind)
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
