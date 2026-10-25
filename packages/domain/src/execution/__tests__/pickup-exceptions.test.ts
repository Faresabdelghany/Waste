import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { chargesMovedByCorrection, isChargeable, isPickupException, judgeException, ruleFor, type PickupExceptionRuleFacts, type PickupExceptionStop } from "../pickup-exceptions"

const PARKVEJ = "property-parkvej"
const stop = (id: string, values: Partial<PickupExceptionStop> = {}): PickupExceptionStop => ({
  id,
  status: "failed",
  reason: "contamination",
  contaminantCodeId: "plastic-in-organic",
  origin: "generation",
  service: "empty",
  serviceDate: "2026-10-05",
  place: PARKVEJ,
  ...values,
})
const rule = (id: string, values: Partial<PickupExceptionRuleFacts> = {}): PickupExceptionRuleFacts => ({
  id,
  validFrom: "2026-01-01",
  validTo: null,
  outcome: "failed",
  reason: "contamination",
  contaminantCodeId: null,
  freeCount: 1,
  windowDays: 365,
  ladder: ["warning-fee", "contamination-fee", "contamination-fee-high"],
  ...values,
})

describe("isPickupException", () => {
  test("a stop failed or skipped for a reason the customer caused, or collected but tagged with a contaminant code", () => {
    for (const reason of ["contamination", "not-presented", "inaccessible", "other"] as const) {
      assert.equal(isPickupException(stop("a", { reason, contaminantCodeId: null })), true, reason)
      assert.equal(isPickupException(stop("a", { status: "skipped", reason, contaminantCodeId: null })), true, `skipped ${reason}`)
    }
    assert.equal(isPickupException(stop("a", { status: "completed", reason: null })), true, "collected, but the bin held the wrong waste")
  })

  test("never the operator's own miss, the system's closing of a stop, a plain collection or a stop not yet served", () => {
    for (const reason of ["capacity", "safety", "route-ended", "route-cancelled", "removed-by-dispatcher", "regeneration"] as const) {
      assert.equal(isPickupException(stop("a", { reason, contaminantCodeId: null })), false, reason)
    }
    assert.equal(isPickupException(stop("a", { status: "completed", reason: null, contaminantCodeId: null })), false)
    assert.equal(isPickupException(stop("a", { status: "planned", reason: null, contaminantCodeId: null })), false)
  })

  test("is chargeable only at an emptying generation planned: an office's stop is no exception charge, as it is no pickup charge, and a work order is never one", () => {
    assert.equal(isChargeable(stop("a")), true)
    assert.equal(isChargeable(stop("a", { origin: "office" })), false)
    assert.equal(isChargeable(stop("a", { service: "wash" })), false)
    assert.equal(isChargeable(stop("a", { status: "completed", reason: null, contaminantCodeId: null })), false, "no exception, no charge")
  })
})

describe("ruleFor", () => {
  test("the most specific rule in force on the service date: a code beats any code, a reason beats no reason", () => {
    const anyFailure = rule("any-failure", { reason: null })
    const contamination = rule("contamination")
    const plastic = rule("plastic", { contaminantCodeId: "plastic-in-organic" })
    assert.equal(ruleFor([anyFailure, contamination, plastic], stop("a"))?.id, "plastic")
    assert.equal(ruleFor([anyFailure, contamination], stop("a"))?.id, "contamination")
    assert.equal(ruleFor([anyFailure], stop("a", { reason: "not-presented", contaminantCodeId: null }))?.id, "any-failure")
    assert.equal(ruleFor([plastic], stop("a", { contaminantCodeId: "food-in-paper" })), undefined, "another code's rule is not this stop's")
    assert.equal(ruleFor([contamination], stop("a", { status: "skipped" })), undefined, "a failed stop's rule is not a skipped one's")
  })

  test("holds the rule's period half-open, and a tagged collection only to a completed rule", () => {
    const ended = rule("ended", { validTo: "2026-10-05" })
    assert.equal(ruleFor([ended], stop("a")), undefined, "validTo is the first day out of force")
    assert.equal(ruleFor([ended], stop("a", { serviceDate: "2026-10-04" }))?.id, "ended")
    assert.equal(ruleFor([rule("later", { validFrom: "2026-10-06" })], stop("a")), undefined)
    const tagged = rule("tagged", { outcome: "completed", reason: null })
    assert.equal(ruleFor([tagged], stop("a", { status: "completed", reason: null }))?.id, "tagged")
    assert.equal(ruleFor([tagged], stop("a", { status: "completed", reason: null, contaminantCodeId: null })), undefined, "a plain collection is no exception")
  })
})

describe("judgeException", () => {
  test("counts the earlier matching exceptions at the stop's place in the window, frees the first freeCount, then steps the ladder, its last step repeating", () => {
    const rules = [rule("contamination")]
    const history = [stop("s1", { serviceDate: "2026-03-02" }), stop("s2", { serviceDate: "2026-05-04" }), stop("s3", { serviceDate: "2026-07-06" }), stop("s4", { serviceDate: "2026-09-07" })]
    const judged = (id: string, serviceDate: string) => judgeException(stop(id, { serviceDate }), rules, history)
    assert.deepEqual(judgeException(history[0], rules, history), { ruleId: "contamination", index: 0, free: true, productId: null })
    assert.deepEqual(judgeException(history[1], rules, history), { ruleId: "contamination", index: 1, free: false, productId: "warning-fee" })
    assert.deepEqual(judgeException(history[2], rules, history), { ruleId: "contamination", index: 2, free: false, productId: "contamination-fee" })
    assert.deepEqual(judgeException(history[3], rules, history), { ruleId: "contamination", index: 3, free: false, productId: "contamination-fee-high" })
    assert.deepEqual(judged("s5", "2026-10-05"), { ruleId: "contamination", index: 4, free: false, productId: "contamination-fee-high" }, "the last step repeats")
  })

  test("counts only the stop's own place, inside the window, matching the rule, before it by service date and then by id — never the stop itself or one corrected away", () => {
    const rules = [rule("contamination", { windowDays: 90, freeCount: 0 })]
    const target = stop("s9", { serviceDate: "2026-10-05" })
    const history = [
      target,
      stop("elsewhere", { place: "property-havnegade", serviceDate: "2026-10-01" }),
      stop("too-old", { serviceDate: "2026-07-06" }),
      stop("edge", { serviceDate: "2026-07-07" }),
      stop("other-reason", { reason: "inaccessible", contaminantCodeId: null, serviceDate: "2026-09-01" }),
      stop("corrected-away", { status: "completed", reason: null, contaminantCodeId: null, serviceDate: "2026-09-02" }),
      stop("a-same-day-before", { serviceDate: "2026-10-05" }),
      stop("t-same-day-after", { serviceDate: "2026-10-05" }),
      stop("later", { serviceDate: "2026-10-12" }),
    ]
    // The window is the windowDays before the service date: 2026-07-07 is 90 days before 2026-10-05, 2026-07-06 is 91.
    assert.deepEqual(judgeException(target, rules, history), { ruleId: "contamination", index: 2, free: false, productId: "contamination-fee-high" }, "edge and a-same-day-before")
  })

  test("a stop no rule matches, or that is no chargeable exception, is judged nothing", () => {
    assert.equal(judgeException(stop("a"), [], []), null)
    assert.equal(judgeException(stop("a", { origin: "office" }), [rule("contamination")], []), null)
    assert.equal(judgeException(stop("a", { reason: "capacity", contaminantCodeId: null }), [rule("any", { reason: null })], []), null, "the operator's own miss is never charged")
  })

  test("an office's stop or a work order never steps the ladder, as it is never charged: the free count is spent on what could be", () => {
    const rules = [rule("not-out", { reason: "not-presented", freeCount: 1 })]
    const notOut = (id: string, serviceDate: string, values: Partial<PickupExceptionStop> = {}) => stop(id, { reason: "not-presented", contaminantCodeId: null, serviceDate, ...values })
    const history = [notOut("a-wash", "2026-09-01", { service: "wash", origin: "office" }), notOut("b-office", "2026-09-02", { origin: "office" })]
    assert.deepEqual(judgeException(notOut("c", "2026-10-05"), rules, history), { ruleId: "not-out", index: 0, free: true, productId: null })
  })

  test("a shared collection point is its own place: its stops count against each other, never against a property's", () => {
    const rules = [rule("contamination", { freeCount: 0 })]
    const point = (id: string, serviceDate: string) => stop(id, { place: "point-rosenvej", serviceDate })
    const history = [point("p1", "2026-09-01"), stop("parkvej", { serviceDate: "2026-09-02" })]
    assert.deepEqual(judgeException(point("p2", "2026-10-05"), rules, history)?.index, 1)
  })
})

describe("chargesMovedByCorrection", () => {
  test("a correction moves the corrected stop's own charge and never re-steps a later one: the ladder is judged once, at each stop's event", () => {
    // s1 was charged free, s2 the warning fee and s3 the contamination fee. Correcting s1 away mends s1's own row
    // (a cancel, or a credit once invoiced); s3 keeps the step it was judged at, and a wrong step is mended the same way, by hand.
    const charges = [{ pickupId: "s1", eventId: "e1" }, { pickupId: "s2", eventId: "e2" }, { pickupId: "s3", eventId: "e3" }]
    assert.deepEqual(chargesMovedByCorrection("s1", charges), [{ pickupId: "s1", eventId: "e1" }])
    assert.deepEqual(chargesMovedByCorrection("s9", charges), [], "a stop with no charge moves none")
  })
})
