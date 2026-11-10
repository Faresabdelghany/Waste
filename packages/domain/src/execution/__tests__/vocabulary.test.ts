// The Execution vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to the rules its values beside the lists
// state: the driver's reasons and the closing reasons are values of the
// reason list and together with the ones the system writes make the whole of
// it; the office's cancel codes are every code but a run's; and the command
// kinds leave out what is not a command.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Execution", vocabulary, vocabulary.EXECUTION_VOCABULARIES, { DRIVER_PICKUP_REASONS: "PICKUP_REASONS", CLOSING_REASONS: "PICKUP_REASONS", OFFICE_STOP_SERVICES: "PICKUP_SERVICES", WORK_ORDER_SERVICES: "PICKUP_SERVICES", OFFICE_CANCEL_REASON_CODES: "ROUTE_CANCEL_REASON_CODES", PICKUP_EXCEPTION_REASONS: "PICKUP_REASONS", CODED_PROOF_KINDS: "PROOF_KINDS", RECEIVED_LOAD_STATUSES: "OUTBOUND_LOAD_STATUSES", ACTIVE_CONTAMINANT_CODE_STATUSES: "CONTAMINANT_CODE_STATUSES", NOT_STARTED_ROUTE_STATUSES: "ROUTE_STATUSES", DISPATCHED_ROUTE_STATUSES: "ROUTE_STATUSES", OPEN_ROUTE_STATUSES: "ROUTE_STATUSES", RAN_ROUTE_STATUSES: "ROUTE_STATUSES", MISSED_PICKUP_STATUSES: "PICKUP_STATUSES", LIVE_STOP_STATUSES: "PICKUP_STATUSES" })

describe("the Execution vocabulary's own rules", () => {
  test("the driver's six reasons and the system's four make the reason list; the closing reasons are two of the system's", () => {
    const system = vocabulary.PICKUP_REASONS.filter((reason) => !(vocabulary.DRIVER_PICKUP_REASONS as readonly string[]).includes(reason))
    assert.deepEqual([...vocabulary.DRIVER_PICKUP_REASONS], ["inaccessible", "contamination", "not-presented", "capacity", "safety", "other"])
    assert.deepEqual(system, ["route-ended", "route-cancelled", "removed-by-dispatcher", "regeneration"])
    for (const reason of vocabulary.CLOSING_REASONS) assert.ok(system.includes(reason), reason)
    assert.deepEqual([...vocabulary.CLOSING_REASONS], ["route-ended", "route-cancelled"])
  })

  test("a bulky booking is booked, routed, collected or cancelled (O11 of #290), and a bulky collection is no work order", () => {
    assert.ok(!(vocabulary.WORK_ORDER_SERVICES as readonly string[]).includes("bulky"))
  })

  test("a route is cancelled for one of the office's eight reasons, or by a run that no longer plans it (O5 of #290): the office's codes are the list less the run's", () => {
    assert.deepEqual([...vocabulary.OFFICE_CANCEL_REASON_CODES], ["vehicle-breakdown", "crew-unavailable", "weather", "road-closure", "holiday", "duplicate", "merged", "other"])
    assert.deepEqual(
      vocabulary.ROUTE_CANCEL_REASON_CODES.filter((code) => !(vocabulary.OFFICE_CANCEL_REASON_CODES as readonly string[]).includes(code)),
      [vocabulary.REGENERATION_CANCEL],
    )
  })

  test("the command kinds leave out the device's retry and the Ticket's reschedule, and the receipt stores two outcomes", () => {
    for (const notACommand of ["retry-sync", "reschedule-stop", "start-break", "end-break"]) {
      assert.equal((vocabulary.DRIVER_COMMAND_KINDS as readonly string[]).includes(notACommand), false, notACommand)
    }
    assert.equal((vocabulary.COMMAND_OUTCOMES as readonly string[]).includes("replayed"), false, "replayed is the wire's word and is never stored")
  })
})

describe("a missed stop", () => {
  test("is one skipped or failed: planned and completed are not, and neither is a word outside the list", () => {
    assert.deepEqual(vocabulary.PICKUP_STATUSES.filter(vocabulary.pickupMissed), ["skipped", "failed"])
    assert.equal(vocabulary.pickupMissed("Skipped"), false)
  })

  test("leaves the stop live: planned or completed, every status but a miss", () => {
    assert.deepEqual([...vocabulary.LIVE_STOP_STATUSES], ["planned", "completed"])
  })
})
