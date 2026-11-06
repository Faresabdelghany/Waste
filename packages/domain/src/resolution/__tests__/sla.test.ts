// A ticket's SLA (O4 of #290): the target a project gives a kind, or a
// ticket type (#548 of #544), and a priority, the due date opening sets from it, and what a ticket's due date
// reads as at an instant — overdue, due, met, breached or none.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { duplicateSlaTarget, dueBySla, slaStateOf, slaTargetFor, slaTargetKey, SLA_STATES, TICKET_SLA_HOURS_MAX, type SlaTarget } from "../sla"

const BULKY = "01a0d3a5-e5e0-7000-8000-000000000b01"
const targets: SlaTarget[] = [
  { kind: null, ticketTypeId: null, priority: "high", hours: 24 },
  { kind: "overflow", ticketTypeId: null, priority: "high", hours: 4 },
  { kind: null, ticketTypeId: null, priority: "low", hours: 168 },
  { kind: null, ticketTypeId: BULKY, priority: "high", hours: 72 },
]
const overflow = { kind: "overflow" as const, ticketTypeId: null }
const complaint = { kind: "complaint" as const, ticketTypeId: null }

describe("the target a ticket is due by", () => {
  test("the kind's own target at the priority beats the one for every kind", () => {
    assert.equal(slaTargetFor(targets, overflow, "high")?.hours, 4)
  })

  test("a type's own target at the priority beats its kind's and every kind's; where it has none, its kind's applies (#548 of #544)", () => {
    assert.equal(slaTargetFor(targets, { kind: "overflow", ticketTypeId: BULKY }, "high")?.hours, 72)
    assert.equal(slaTargetFor(targets, { kind: "overflow", ticketTypeId: BULKY }, "low")?.hours, 168)
    assert.equal(slaTargetFor(targets, { kind: "overflow", ticketTypeId: "01a0d3a5-e5e0-7000-8000-000000000b02" }, "high")?.hours, 4)
  })

  test("a kind with no target of its own takes the one for every kind at the priority", () => {
    assert.equal(slaTargetFor(targets, complaint, "high")?.hours, 24)
    assert.equal(slaTargetFor(targets, overflow, "low")?.hours, 168)
  })

  test("a priority the project sets no target for has none", () => {
    assert.equal(slaTargetFor(targets, overflow, "critical"), undefined)
    assert.equal(slaTargetFor([], complaint, "none"), undefined)
  })

  test("the due date is when the issue or request happened plus the hours, on the wall clock", () => {
    assert.equal(dueBySla(new Date("2026-10-24T22:30:00.000Z"), 4).toISOString(), "2026-10-25T02:30:00.000Z")
    assert.equal(dueBySla(new Date("2026-03-28T12:00:00.000Z"), 24).toISOString(), "2026-03-29T12:00:00.000Z")
  })

  test("a year is the longest target", () => {
    assert.equal(TICKET_SLA_HOURS_MAX, 365 * 24)
  })
})

describe("a set of targets names a kind and a priority once", () => {
  test("the first entry repeating one before it, by its index", () => {
    assert.equal(duplicateSlaTarget(targets), undefined)
    assert.equal(duplicateSlaTarget([...targets, { kind: "overflow", ticketTypeId: null, priority: "high", hours: 8 }]), 4)
    assert.equal(duplicateSlaTarget([...targets, { kind: null, ticketTypeId: BULKY, priority: "high", hours: 8 }]), 4)
    assert.equal(duplicateSlaTarget([{ kind: null, priority: "low", hours: 1 }, { kind: null, priority: "low", hours: 2 }]), 1)
  })

  test("a target is named by its kind or its type, every kind as the empty kind, and its priority", () => {
    assert.equal(slaTargetKey({ kind: null, priority: "high" }), "::high")
    assert.equal(slaTargetKey({ kind: "overflow", ticketTypeId: null, priority: "high" }), "overflow::high")
    assert.equal(slaTargetKey({ kind: null, ticketTypeId: BULKY, priority: "high" }), `:${BULKY}:high`)
  })

  test("every kind and one kind at the same priority are two targets", () => {
    assert.equal(duplicateSlaTarget([{ kind: null, priority: "high", hours: 24 }, { kind: "complaint", priority: "high", hours: 24 }]), undefined)
  })
})

describe("what a ticket's due date reads as", () => {
  const now = new Date("2026-10-24T12:00:00.000Z")
  const open = { status: "open" as const, closedAt: null }

  test("an open ticket past its due date is overdue, and one before it is due", () => {
    assert.equal(slaStateOf({ ...open, dueAt: "2026-10-24T11:59:59.000Z" }, now), "overdue")
    assert.equal(slaStateOf({ ...open, status: "on-hold", dueAt: "2026-10-23T00:00:00.000Z" }, now), "overdue")
    assert.equal(slaStateOf({ ...open, dueAt: "2026-10-24T12:00:00.000Z" }, now), "due")
    assert.equal(slaStateOf({ ...open, status: "in-progress", dueAt: "2026-10-25T00:00:00.000Z" }, now), "due")
  })

  test("a closed ticket met its due date when it closed by it, and breached it after", () => {
    assert.equal(slaStateOf({ status: "completed", dueAt: "2026-10-24T10:00:00.000Z", closedAt: "2026-10-24T10:00:00.000Z" }, now), "met")
    assert.equal(slaStateOf({ status: "rejected", dueAt: "2026-10-24T10:00:00.000Z", closedAt: "2026-10-24T10:00:01.000Z" }, now), "breached")
  })

  test("a ticket without a due date has none, open or closed", () => {
    assert.equal(slaStateOf({ ...open, dueAt: null }, now), "none")
    assert.equal(slaStateOf({ status: "completed", dueAt: null, closedAt: "2026-10-24T10:00:00.000Z" }, now), "none")
  })

  test("the readings, in the order a list offers them", () => {
    assert.deepEqual(SLA_STATES, ["overdue", "due", "met", "breached", "none"])
  })
})
