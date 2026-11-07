import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

const { OUTBOX_AGGREGATES, OUTBOX_EVENTS, OUTBOX_KINDS, aggregateOf } = vocabulary

defineVocabularyTests("Outbox", vocabulary, vocabulary.OUTBOX_VOCABULARIES, 2)

describe("the outbox's kinds and what each is about", () => {
  test("the kinds and the aggregates are the database CHECKs' lists, in their order: a reordering is a migration", () => {
    assert.deepEqual(OUTBOX_KINDS, ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "pickup-completed", "pickup-failed", "pickup-skipped", "pickup-problem-reported", "pickup-corrected", "unload-recorded", "command-rejected", "ticket-opened", "ticket-completed", "ticket-rejected", "invoice-issued", "settlement-closed", "application-decided", "site-visit-recorded", "site-visit-voided", "alert-raised", "ticket-assigned", "bulky-booking-booked", "bulky-booking-cancelled", "ticket-replied", "weight-reviewed", "scale-ticket-completed", "scale-ticket-voided"])
    assert.deepEqual(OUTBOX_AGGREGATES, ["route", "pickup", "unload", "command", "ticket", "invoice", "settlement", "application", "site-visit", "alert", "bulky-booking", "scale-ticket"])
  })

  test("every kind is about exactly one aggregate, but a reported problem, about its stop or the route alone", () => {
    const several = OUTBOX_KINDS.filter((kind) => OUTBOX_EVENTS[kind].length !== 1)
    assert.deepEqual(several, ["pickup-problem-reported"])
    assert.deepEqual(OUTBOX_EVENTS["pickup-problem-reported"], ["pickup", "route"])
    for (const aggregate of OUTBOX_AGGREGATES) assert.ok(OUTBOX_KINDS.some((kind) => (OUTBOX_EVENTS[kind] as readonly string[]).includes(aggregate)), `no kind is about a ${aggregate}`)
  })

  test("an event's aggregate is its kind's, and a reported problem names its own among the two", () => {
    assert.equal(aggregateOf("scale-ticket-completed"), "scale-ticket")
    assert.equal(aggregateOf("weight-reviewed"), "unload")
    assert.equal(aggregateOf("pickup-problem-reported", "route"), "route")
    assert.equal(aggregateOf("pickup-problem-reported", "pickup"), "pickup")
    assert.throws(() => aggregateOf("pickup-problem-reported"), /names what it is about: one of pickup, route/)
    assert.throws(() => aggregateOf("route-started", "pickup"), /about route, never a pickup/)
  })
})
