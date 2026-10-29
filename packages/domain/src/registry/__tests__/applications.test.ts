// Applications and their Decisions (M7 of #293): the moves an Application's
// status allows, what a Decision's period may be by its outcome, and how a
// decision reads against a day — expired being a reading, never a status.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { APPEAL_TEXT_NEEDED, appealTextNeeded, APPLICATION_MOVES, applicationReading, decisionPeriodRefusal, decisionStanding, GRANT_STARTS, moveOf, moveRefusal, pauseOfGrant, REFUSAL_HAS_NO_PERIOD, type ApplicationCommand } from "../applications"
import { APPLICATION_STATUSES } from "../vocabulary"

describe("the moves", () => {
  test("review takes a received application, decide and withdraw one not yet decided, reopen a decided one back to review", () => {
    assert.equal(moveOf("received", "review"), "in-review")
    assert.equal(moveOf("received", "decide"), "decided")
    assert.equal(moveOf("in-review", "decide"), "decided")
    assert.equal(moveOf("in-review", "withdraw"), "withdrawn")
    assert.equal(moveOf("decided", "reopen"), "in-review")
  })

  test("withdrawing a reopened application withdraws the appeal: it goes back to its decision, never to withdrawn", () => {
    assert.equal(moveOf("in-review", "withdraw", true), "decided")
    assert.equal(moveOf("received", "withdraw", false), "withdrawn")
    assert.equal(moveOf("in-review", "withdraw", false), "withdrawn")
    assert.equal(moveOf("decided", "withdraw", true), null)
  })

  test("refuses every other move, a withdrawn application moving no more", () => {
    assert.equal(moveOf("in-review", "review"), null)
    assert.equal(moveOf("decided", "decide"), null)
    assert.equal(moveOf("decided", "withdraw"), null)
    assert.equal(moveOf("received", "reopen"), null)
    for (const command of Object.keys(APPLICATION_MOVES) as ApplicationCommand[]) assert.equal(moveOf("withdrawn", command), null, command)
  })

  test("every move leads from and to a status of the vocabulary", () => {
    for (const move of Object.values(APPLICATION_MOVES)) {
      assert.ok(APPLICATION_STATUSES.includes(move.to))
      for (const from of move.from) assert.ok(APPLICATION_STATUSES.includes(from))
    }
  })

  test("a refused move says where the application stands and what the command takes", () => {
    assert.equal(moveRefusal("Application 12", "decided", "decide"), "Application 12 is decided; decide takes one received or in review")
    assert.equal(moveRefusal("Application 12", "withdrawn", "reopen"), "Application 12 is withdrawn; reopen takes one decided")
    assert.equal(moveRefusal("Application 12", "in-review", "review"), "Application 12 is in review; review takes one received")
  })
})

describe("a decision's period", () => {
  test("a grant, whole or in part, names the first day it is in force, its end optional", () => {
    assert.equal(decisionPeriodRefusal({ outcome: "granted", validFrom: "2026-11-01", validTo: null }), null)
    assert.equal(decisionPeriodRefusal({ outcome: "partly-granted", validFrom: "2026-11-01", validTo: "2027-11-01" }), null)
    assert.deepEqual(decisionPeriodRefusal({ outcome: "granted", validFrom: null, validTo: null }), { path: "validFrom", message: GRANT_STARTS })
  })

  test("a refusal is in force for no period", () => {
    assert.equal(decisionPeriodRefusal({ outcome: "refused", validFrom: null, validTo: null }), null)
    assert.deepEqual(decisionPeriodRefusal({ outcome: "refused", validFrom: "2026-11-01", validTo: null }), { path: "validFrom", message: REFUSAL_HAS_NO_PERIOD })
    assert.deepEqual(decisionPeriodRefusal({ outcome: "refused", validFrom: null, validTo: "2027-01-01" }), { path: "validTo", message: REFUSAL_HAS_NO_PERIOD })
  })
})

describe("a decision's appeal text", () => {
  test("is needed for a refusal and a partial grant, never for a grant in full", () => {
    assert.equal(appealTextNeeded("granted"), false)
    assert.equal(appealTextNeeded("partly-granted"), true)
    assert.equal(appealTextNeeded("refused"), true)
    assert.match(APPEAL_TEXT_NEEDED, /how to appeal/)
  })
})

describe("a decision against a day", () => {
  const grant = { outcome: "granted" as const, validFrom: "2026-11-01", validTo: "2027-11-01" }

  test("is upcoming before its first day, in force over its half-open period, expired from its first day out", () => {
    assert.equal(decisionStanding(grant, "2026-10-31"), "upcoming")
    assert.equal(decisionStanding(grant, "2026-11-01"), "in-force")
    assert.equal(decisionStanding(grant, "2027-10-31"), "in-force")
    assert.equal(decisionStanding(grant, "2027-11-01"), "expired")
    assert.equal(decisionStanding({ ...grant, validTo: null }, "2099-01-01"), "in-force")
    assert.equal(decisionStanding({ outcome: "refused", validFrom: null, validTo: null }, "2026-11-01"), "refused")
  })

  test("reads the application as the office says it", () => {
    assert.equal(applicationReading("received", null, "2026-11-01"), "Received")
    assert.equal(applicationReading("in-review", null, "2026-11-01"), "In review")
    assert.equal(applicationReading("withdrawn", null, "2026-11-01"), "Withdrawn")
    assert.equal(applicationReading("decided", grant, "2026-11-02"), "Granted · in force")
    assert.equal(applicationReading("decided", { ...grant, outcome: "partly-granted" }, "2026-10-01"), "Partly granted · from 2026-11-01")
    assert.equal(applicationReading("decided", grant, "2027-11-01"), "Granted · expired 2027-10-31")
    assert.equal(applicationReading("decided", { outcome: "refused", validFrom: null, validTo: null }, "2026-11-01"), "Refused")
    // Reopened on appeal: in review again, whatever was decided before.
    assert.equal(applicationReading("in-review", grant, "2026-11-02"), "In review")
  })
})

describe("a granted pause's effect (M11 of #293)", () => {
  const subscription = { validFrom: "2026-01-01", validTo: null }
  const pause = (outcome: "granted" | "partly-granted" | "refused", validFrom: string | null, validTo: string | null) => ({ kind: "pause" as const, subscriptionId: "sub-1", decision: { outcome, validFrom, validTo } })

  test("a grant, whole or in part, of a pause naming a subscription pauses it over the granted period", () => {
    assert.deepEqual(pauseOfGrant(pause("granted", "2026-07-01", "2026-09-01"), subscription, "2026-06-15"), { subscriptionId: "sub-1", validFrom: "2026-07-01", validTo: "2026-09-01" })
    assert.deepEqual(pauseOfGrant(pause("partly-granted", "2026-07-01", null), subscription, "2026-06-15"), { subscriptionId: "sub-1", validFrom: "2026-07-01", validTo: null }, "open-ended until resumed")
  })

  test("a refusal, another kind, or a pause naming no subscription pauses nothing", () => {
    assert.equal(pauseOfGrant(pause("refused", null, null), subscription, "2026-06-15"), null)
    assert.equal(pauseOfGrant({ ...pause("granted", "2026-07-01", null), kind: "exemption" }, subscription, "2026-06-15"), null)
    assert.equal(pauseOfGrant({ ...pause("granted", "2026-07-01", null), subscriptionId: null }, subscription, "2026-06-15"), null)
  })

  test("the period is cut to today on, as an office pause begins, and to the subscription's own; nothing is left, nothing is paused", () => {
    assert.deepEqual(pauseOfGrant(pause("granted", "2026-05-01", "2026-09-01"), subscription, "2026-06-15"), { subscriptionId: "sub-1", validFrom: "2026-06-15", validTo: "2026-09-01" }, "a grant decided after its first day pauses from today, never the days gone")
    assert.deepEqual(pauseOfGrant(pause("granted", "2026-07-01", null), { validFrom: "2026-01-01", validTo: "2026-08-01" }, "2026-06-15"), { subscriptionId: "sub-1", validFrom: "2026-07-01", validTo: "2026-08-01" }, "inside the subscription's period")
    assert.equal(pauseOfGrant(pause("granted", "2026-05-01", "2026-06-01"), subscription, "2026-06-15"), null, "over before today")
    assert.equal(pauseOfGrant(pause("granted", "2026-09-01", null), { validFrom: "2026-01-01", validTo: "2026-08-01" }, "2026-06-15"), null, "after the subscription ends")
    assert.deepEqual(pauseOfGrant(pause("granted", "2026-07-01", null), { validFrom: "2026-08-01", validTo: null }, "2026-06-15"), { subscriptionId: "sub-1", validFrom: "2026-08-01", validTo: null }, "from the subscription's first day")
  })
})
