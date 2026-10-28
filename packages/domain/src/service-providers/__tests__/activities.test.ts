import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  activityLabel,
  activityOverdue,
  activityReading,
  closesWith,
  commandRefusal,
  createRefusal,
  initialStatus,
  isProposal,
  OFFICE_DECIDES,
  routeDayChangeRefusal,
  SAME_CREW,
  SAME_STOPS,
  stopSetChangeRefusal,
  serviceDaysAfter,
  SAME_DAYS,
  vehicleChangeRefusal,
  type ActivityCommand,
} from "../activities"
import { SERVICE_PROVIDER_ACTIVITY_KINDS } from "../vocabulary"

describe("a Service Provider Activity", () => {
  test("is labelled by the company's running number", () => {
    assert.equal(activityLabel(12), "ACT-12")
  })

  test("a proposal starts pending approval, every other kind open", () => {
    assert.equal(initialStatus("route-day-change"), "pending-approval")
    assert.equal(initialStatus("compliance-follow-up"), "open")
    assert.equal(initialStatus("coordination-note"), "open")
    assert.deepEqual(
      SERVICE_PROVIDER_ACTIVITY_KINDS.filter((kind) => isProposal(kind)),
      ["route-day-change", "vehicle-change", "stop-set-change"],
    )
  })

  test("the office opens every kind, a provider a proposal and a note but never a compliance follow-up", () => {
    for (const kind of SERVICE_PROVIDER_ACTIVITY_KINDS) assert.equal(createRefusal(kind, "office"), null)
    assert.equal(createRefusal("route-day-change", "provider"), null)
    assert.equal(createRefusal("coordination-note", "provider"), null)
    assert.match(createRefusal("compliance-follow-up", "provider") ?? "", /office/)
  })
})

describe("the moves", () => {
  const moves: [ActivityCommand, string][] = [
    ["approve", "approved"],
    ["reject", "rejected"],
    ["withdraw", "withdrawn"],
  ]
  for (const [command, to] of moves)
    test(`${command} moves a pending proposal to ${to}`, () => {
      assert.deepEqual(closesWith({ number: 3, kind: "route-day-change", status: "pending-approval" }, command, "office"), { ok: true, to })
    })

  test("approve and reject are the office's alone, and say so to a provider", () => {
    for (const command of ["approve", "reject"] as const) {
      const refused = closesWith({ number: 3, kind: "route-day-change", status: "pending-approval" }, command, "provider")
      assert.deepEqual(refused, { ok: false, status: 403, detail: OFFICE_DECIDES })
    }
  })

  test("a provider withdraws its own proposal", () => {
    assert.deepEqual(closesWith({ number: 3, kind: "route-day-change", status: "pending-approval" }, "withdraw", "provider"), { ok: true, to: "withdrawn" })
  })

  test("a decided proposal moves no further", () => {
    const refused = closesWith({ number: 3, kind: "route-day-change", status: "approved" }, "reject", "office")
    assert.deepEqual(refused, { ok: false, status: 409, detail: "ACT-3 is approved; reject takes one pending approval" })
  })

  test("a follow-up is completed or cancelled by the office alone", () => {
    assert.deepEqual(closesWith({ number: 4, kind: "compliance-follow-up", status: "open" }, "complete", "office"), { ok: true, to: "completed" })
    assert.deepEqual(closesWith({ number: 4, kind: "compliance-follow-up", status: "open" }, "cancel", "office"), { ok: true, to: "cancelled" })
    const refused = closesWith({ number: 4, kind: "compliance-follow-up", status: "open" }, "complete", "provider")
    assert.equal(refused.ok, false)
    assert.equal(refused.ok === false && refused.status, 403)
  })

  test("a note is completed by either side, and is never approved", () => {
    assert.deepEqual(closesWith({ number: 5, kind: "coordination-note", status: "open" }, "complete", "provider"), { ok: true, to: "completed" })
    assert.deepEqual(closesWith({ number: 5, kind: "coordination-note", status: "open" }, "approve", "office"), {
      ok: false,
      status: 409,
      detail: "ACT-5 is a coordination note; approve takes a proposal",
    })
  })

  test("a refusal names the statuses a command takes", () => {
    assert.equal(commandRefusal("ACT-9", "completed", "cancel"), "ACT-9 is completed; cancel takes one open")
  })
})

describe("the readings", () => {
  test("an open follow-up is overdue once its due day has passed, never on the day itself", () => {
    const followUp = { kind: "compliance-follow-up" as const, status: "open" as const, dueOn: "2026-08-12" }
    assert.equal(activityOverdue(followUp, "2026-08-12"), false)
    assert.equal(activityOverdue(followUp, "2026-08-13"), true)
    assert.equal(activityOverdue({ ...followUp, status: "completed" }, "2026-09-01"), false)
    assert.equal(activityOverdue({ ...followUp, dueOn: null }, "2026-09-01"), false)
  })

  test("the reading is the status in words, with overdue said", () => {
    assert.equal(activityReading({ kind: "route-day-change", status: "pending-approval", dueOn: null }, "2026-08-13"), "Pending approval")
    assert.equal(activityReading({ kind: "compliance-follow-up", status: "open", dueOn: "2026-08-12" }, "2026-08-13"), "Open · overdue")
  })
})

describe("a route-day change", () => {
  test("must move the group's days", () => {
    assert.equal(routeDayChangeRefusal(["tuesday"], ["tuesday"]), SAME_DAYS)
    assert.equal(routeDayChangeRefusal(["tuesday", "friday"], ["friday", "tuesday"]), SAME_DAYS)
    assert.equal(routeDayChangeRefusal(["tuesday"], ["wednesday"]), null)
  })

  test("leaves a scheme the days its groups run on, Monday first", () => {
    const groups = [{ days: ["wednesday" as const] }, { days: ["monday" as const, "wednesday" as const] }, { days: [] }]
    assert.deepEqual(serviceDaysAfter("weekly", ["monday", "tuesday"], groups), ["monday", "wednesday"])
  })

  test("leaves a daily scheme every day, which it serves already", () => {
    const all = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const
    assert.deepEqual(serviceDaysAfter("daily", all, [{ days: ["wednesday"] }]), all)
  })
})

describe("a vehicle change", () => {
  test("is a proposal, opened by either side and decided by the office", () => {
    assert.equal(initialStatus("vehicle-change"), "pending-approval")
    assert.equal(createRefusal("vehicle-change", "provider"), null)
    assert.deepEqual(closesWith({ number: 7, kind: "vehicle-change", status: "pending-approval" }, "approve", "provider"), { ok: false, status: 403, detail: OFFICE_DECIDES })
    assert.deepEqual(closesWith({ number: 7, kind: "vehicle-change", status: "pending-approval" }, "withdraw", "provider"), { ok: true, to: "withdrawn" })
  })

  test("must move the vehicle or the driver; a driver left unsaid keeps the group's", () => {
    const crew = { vehicleId: "nr-08", driverId: "lars" }
    assert.equal(vehicleChangeRefusal(crew, { vehicleId: "nr-08", driverId: null }), SAME_CREW)
    assert.equal(vehicleChangeRefusal(crew, { vehicleId: "nr-08", driverId: "lars" }), SAME_CREW)
    assert.equal(vehicleChangeRefusal(crew, { vehicleId: "nr-08", driverId: "mads" }), null)
    assert.equal(vehicleChangeRefusal(crew, { vehicleId: "nr-12", driverId: null }), null)
    assert.equal(vehicleChangeRefusal({ vehicleId: null, driverId: null }, { vehicleId: "nr-12", driverId: null }), null)
  })
})

describe("a stop-set change", () => {
  test("is a proposal, decided by the office", () => {
    assert.equal(initialStatus("stop-set-change"), "pending-approval")
    assert.deepEqual(closesWith({ number: 8, kind: "stop-set-change", status: "pending-approval" }, "approve", "office"), { ok: true, to: "approved" })
    assert.deepEqual(closesWith({ number: 8, kind: "stop-set-change", status: "pending-approval" }, "approve", "provider"), { ok: false, status: 403, detail: OFFICE_DECIDES })
  })

  test("must move a stop or their order, the list being stop order", () => {
    assert.equal(stopSetChangeRefusal(["a", "b"], ["a", "b"]), SAME_STOPS)
    assert.equal(stopSetChangeRefusal(["a", "b"], ["b", "a"]), null)
    assert.equal(stopSetChangeRefusal(["a", "b"], ["a", "b", "c"]), null)
    assert.equal(stopSetChangeRefusal(["a", "b"], ["a"]), null)
  })
})
