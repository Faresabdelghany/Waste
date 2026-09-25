// The Execution vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to four things of its own: the route and
// pickup statuses are #97 §2's, verbatim, since generation writes what these
// rows read; the driver's reasons and the closing reasons are values of the
// reason list and together with the two the system writes otherwise make the
// whole of it; the ten proof kinds are five events, four kinds of evidence and
// the correction; and every command kind is a kebab token the prototype's
// action list can be mapped onto, less the two that are not commands.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Execution", vocabulary, vocabulary.EXECUTION_VOCABULARIES, 9, ["DRIVER_PICKUP_REASONS", "CLOSING_REASONS"])

describe("the Execution vocabulary's own rules", () => {
  test("the route and pickup statuses are #97 B's, verbatim", () => {
    assert.deepEqual([...vocabulary.ROUTE_STATUSES], ["planned", "ready", "active", "completed", "cancelled"])
    assert.deepEqual([...vocabulary.PICKUP_STATUSES], ["planned", "completed", "skipped", "failed"])
  })

  test("the driver's six reasons and the system's four make the reason list; the closing reasons are two of the system's", () => {
    const system = vocabulary.PICKUP_REASONS.filter((reason) => !(vocabulary.DRIVER_PICKUP_REASONS as readonly string[]).includes(reason))
    assert.deepEqual([...vocabulary.DRIVER_PICKUP_REASONS], ["inaccessible", "contamination", "not-presented", "capacity", "safety", "other"])
    assert.deepEqual(system, ["route-ended", "route-cancelled", "removed-by-dispatcher", "regeneration"])
    for (const reason of vocabulary.CLOSING_REASONS) assert.ok(system.includes(reason), reason)
    assert.deepEqual([...vocabulary.CLOSING_REASONS], ["route-ended", "route-cancelled"])
  })

  test("the proof kinds are five driver events, four kinds of evidence and the correction", () => {
    assert.deepEqual([...vocabulary.PROOF_KINDS], ["arrival", "completion", "skip", "failure", "problem", "photo", "weight", "signature", "note", "correction"])
  })

  test("the fourteen command kinds leave out the device's retry and the Ticket's reschedule, and the receipt stores two outcomes", () => {
    assert.equal(vocabulary.DRIVER_COMMAND_KINDS.length, 14)
    for (const notACommand of ["retry-sync", "reschedule-stop", "start-break", "end-break"]) {
      assert.equal((vocabulary.DRIVER_COMMAND_KINDS as readonly string[]).includes(notACommand), false, notACommand)
    }
    assert.deepEqual([...vocabulary.COMMAND_OUTCOMES], ["applied", "rejected"], "replayed is the wire's word and is never stored")
    assert.deepEqual([...vocabulary.OUTBOX_AGGREGATES], ["route", "pickup", "unload", "command"])
  })
})
