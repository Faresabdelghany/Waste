import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

const { OUTBOX_AGGREGATES, OUTBOX_EVENTS, OUTBOX_KINDS, aggregateOf, subjectOf } = vocabulary

defineVocabularyTests("Outbox", vocabulary, vocabulary.OUTBOX_VOCABULARIES)

describe("the outbox's kinds and what each is about", () => {
  test("the kinds and the aggregates are the database CHECKs' lists, in their order: a reordering is a migration", () => {
    assert.deepEqual(OUTBOX_KINDS, ["route-dispatched", "route-started", "route-completed", "route-cancelled", "route-reassigned", "route-problem-reported", "pickup-completed", "pickup-failed", "pickup-skipped", "pickup-problem-reported", "pickup-corrected", "unload-recorded", "command-rejected", "ticket-opened", "ticket-completed", "ticket-rejected", "invoice-issued", "settlement-closed", "application-decided", "site-visit-recorded", "site-visit-voided", "alert-raised", "ticket-assigned", "bulky-booking-booked", "bulky-booking-cancelled", "ticket-replied", "weight-reviewed", "scale-ticket-completed", "scale-ticket-voided"])
    assert.deepEqual(OUTBOX_AGGREGATES, ["route", "pickup", "unload", "command", "ticket", "invoice", "settlement", "application", "site-visit", "alert", "bulky-booking", "scale-ticket"])
  })

  test("every aggregate is what some kind is about, and a driver's problem is the stop's kind or the route's", () => {
    for (const aggregate of OUTBOX_AGGREGATES) assert.ok(OUTBOX_KINDS.some((kind) => OUTBOX_EVENTS[kind] === aggregate), `no kind is about a ${aggregate}`)
    assert.equal(aggregateOf("pickup-problem-reported"), "pickup")
    assert.equal(aggregateOf("route-problem-reported"), "route")
  })

  test("an event's subject is its kind, the kind's aggregate and the aggregate's id", () => {
    assert.equal(aggregateOf("scale-ticket-completed"), "scale-ticket")
    assert.equal(aggregateOf("weight-reviewed"), "unload")
    assert.deepEqual(subjectOf("route-problem-reported", "r"), { kind: "route-problem-reported", aggregate: "route", aggregateId: "r" })
  })
})
