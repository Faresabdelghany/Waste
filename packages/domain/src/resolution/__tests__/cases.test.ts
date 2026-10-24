// The case an event's ticket belongs to (#258): one case per stop and one per
// driver's device, whatever order a stop's events arrive in — a rejection
// folds into the driver's open rejected command, a problem on a stop into the
// stop's open case, a missed collection into the stop's open missed
// collection, and a missed collection that opens supersedes the stop's open
// reported problem: completed as a duplicate while nobody has touched it,
// named from both sides when the office works it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { caseRuleOf, superseding, supersededNote, supersedingNote, STOP_CASE_KINDS } from "../cases"
import { ticketFor, type CommandRejectedFacts, type EventFacts, type PickupEventFacts, type PickupEventKind } from "../from-event"
import { OPEN_TICKET_STATUSES } from "../vocabulary"

const pickupEvent = (kind: PickupEventKind, values: Partial<PickupEventFacts> = {}): PickupEventFacts => ({
  kind,
  routeId: "route",
  pickupId: "pickup",
  containerId: "container",
  propertyId: "property",
  sharedCollectionPointId: null,
  reason: null,
  note: null,
  containerLabel: "BIN-82014",
  address: "Parkvej 18",
  actualDriverId: "mads",
  plannedDriverId: "karen",
  agreementId: "agreement",
  customerId: "customer",
  ...values,
})
const rejection: CommandRejectedFacts = { kind: "command-rejected", routeId: "route", pickupId: "pickup", driverId: "mads", detail: "Pickup 12 is already completed" }

/** The rule for an event the consumer makes a ticket of. */
const ruleOf = (facts: EventFacts) => {
  const draft = ticketFor(facts)
  assert.ok(draft !== undefined, `${facts.kind} is a case`)
  return caseRuleOf(facts, draft)
}

describe("caseRuleOf", () => {
  test("a rejection is the driver's: serialised by the driver, folding into the driver's open rejected command, superseding nothing — even where it names the stop", () => {
    assert.deepEqual(ruleOf(rejection), { by: "driver", id: "mads", foldsInto: ["rejected-command"], supersedes: [] })
  })

  test("a problem on a stop is the stop's: folding into its open missed collection or earlier problem, superseding nothing", () => {
    assert.deepEqual(ruleOf(pickupEvent("pickup-problem-reported", { reason: "inaccessible" })), { by: "pickup", id: "pickup", foldsInto: ["missed-collection", "reported-problem"], supersedes: [] })
    assert.deepEqual(STOP_CASE_KINDS, ["missed-collection", "reported-problem"])
  })

  test("a missed collection — a failure, or a stop the route's end or a cancellation closed — folds into the stop's open missed collection and otherwise opens, superseding the stop's open reported problem", () => {
    for (const facts of [pickupEvent("pickup-failed", { reason: "not-presented" }), pickupEvent("pickup-skipped", { reason: "route-ended" }), pickupEvent("pickup-skipped", { reason: "route-cancelled" })]) {
      assert.deepEqual(ruleOf(facts), { by: "pickup", id: "pickup", foldsInto: ["missed-collection"], supersedes: ["reported-problem"] }, `${facts.kind} ${facts.reason}`)
    }
  })

  test("a problem on the route alone names no stop and belongs to no case but its own", () => {
    assert.equal(ruleOf(pickupEvent("pickup-problem-reported", { pickupId: null, containerId: null, propertyId: null, reason: "safety" })), undefined)
  })
})

describe("superseding", () => {
  test("a stop's open reported problem is completed as a duplicate only while nobody has touched it: still open, nobody assigned", () => {
    assert.equal(superseding({ status: "open", assigneeUserAccountId: null }), "duplicate")
  })

  test("one the office works — assigned, or moved to another open status — stays as the office left it, and each case names the other", () => {
    assert.equal(superseding({ status: "open", assigneeUserAccountId: "lars" }), "named")
    for (const status of OPEN_TICKET_STATUSES.filter((candidate) => candidate !== "open")) {
      assert.equal(superseding({ status, assigneeUserAccountId: null }), "named", status)
      assert.equal(superseding({ status, assigneeUserAccountId: "lars" }), "named", `${status}, assigned`)
    }
  })

  test("says on each side what became of the other: the duplicate's note and the problem's words on the missed collection, or the two labels", () => {
    assert.equal(supersededNote("duplicate", "T-1002"), "The stop was not collected: this problem is part of T-1002, its missed collection.")
    assert.equal(supersededNote("named", "T-1002"), "The stop was not collected: T-1002 is its missed collection.")
    const problem = { label: "T-1001", description: "The driver reported a problem. Reason: inaccessible. Note: Gate locked" }
    assert.equal(supersedingNote("duplicate", problem), "From T-1001, completed as a duplicate of this case: The driver reported a problem. Reason: inaccessible. Note: Gate locked")
    assert.equal(supersedingNote("named", problem), "T-1001 is a problem reported on this stop, which the office is working.")
    const long = supersedingNote("duplicate", { label: "T-1001", description: "word ".repeat(500).trim() })
    assert.ok(long.length <= 2000, "the copied words are cut to the comment's bound")
  })
})
