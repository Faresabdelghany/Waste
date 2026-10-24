import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_KINDS, TICKET_PRIORITIES } from "@waste/domain/resolution/vocabulary"

import { TICKET_SLA_TARGETS_MAX, TicketSla, TicketSlaSet } from "../ticket-sla"
import { TicketListQuery } from "../tickets"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"

const sla = {
  projectId: ID,
  targets: [
    { id: ID, kind: null, priority: "high", hours: 24 },
    { id: ID, kind: "overflow", priority: "high", hours: 4 },
  ],
}

describe("TicketSla", () => {
  test("is a project's targets on the wire: every kind or one kind, a priority and the hours", () => {
    assert.deepEqual(TicketSla.parse(sla), sla)
    assert.deepEqual(TicketSla.parse({ projectId: ID, targets: [] }).targets, [])
    assert.equal(TicketSla.safeParse({ ...sla, targets: [{ id: ID, kind: "deviation", priority: "high", hours: 4 }] }).success, false)
  })
})

describe("TicketSlaSet", () => {
  const body = { targets: sla.targets.map(({ id: _id, ...target }) => target) }

  test("is the whole set the project's targets become, the server owning each target's id", () => {
    assert.deepEqual(TicketSlaSet.parse(body), body)
    assert.deepEqual(TicketSlaSet.parse({ targets: [] }), { targets: [] }, "an empty set: no ticket of the project is due by an SLA")
    assert.deepEqual(refusal(TicketSlaSet.safeParse({ targets: [{ ...body.targets[0], id: ID }] })).map((issue) => issue.path), ["targets.0"])
    assert.deepEqual(refusal(TicketSlaSet.safeParse({})).map((issue) => issue.path), ["targets"])
  })

  test("the hours are whole, from one to a year", () => {
    for (const hours of [1, 4, TICKET_SLA_HOURS_MAX]) assert.equal(TicketSlaSet.safeParse({ targets: [{ kind: null, priority: "low", hours }] }).success, true, String(hours))
    for (const hours of [0, -4, 1.5, TICKET_SLA_HOURS_MAX + 1]) {
      assert.deepEqual(refusal(TicketSlaSet.safeParse({ targets: [{ kind: null, priority: "low", hours }] })).map((issue) => issue.path), ["targets.0.hours"], String(hours))
    }
  })

  test("a kind and a priority are named once, every kind counting as one; the second is refused where it stands", () => {
    const twice = { targets: [...body.targets, { kind: "overflow", priority: "high", hours: 8 }] }
    assert.deepEqual(refusal(TicketSlaSet.safeParse(twice)), [{ path: "targets.2", message: "Name each kind and priority once: a ticket is due by one target" }])
    const everyKindTwice = { targets: [{ kind: null, priority: "low", hours: 1 }, { kind: null, priority: "low", hours: 2 }] }
    assert.deepEqual(refusal(TicketSlaSet.safeParse(everyKindTwice)).map((issue) => issue.path), ["targets.1"])
  })

  test("holds at most every kind and each kind at each priority", () => {
    assert.equal(TICKET_SLA_TARGETS_MAX, (TICKET_KINDS.length + 1) * TICKET_PRIORITIES.length)
    const all = TICKET_PRIORITIES.flatMap((priority) => [null, ...TICKET_KINDS].map((kind) => ({ kind, priority, hours: 24 })))
    assert.equal(TicketSlaSet.safeParse({ targets: all }).success, true)
  })
})

describe("TicketListQuery's overdue", () => {
  test("spells a boolean as true or false, exactly", () => {
    assert.equal(TicketListQuery.parse({ overdue: "true" }).overdue, true)
    assert.equal(TicketListQuery.parse({ overdue: "false" }).overdue, false)
    for (const wrong of ["yes", "TRUE", "1", ""]) assert.deepEqual(refusal(TicketListQuery.safeParse({ overdue: wrong })).map((issue) => issue.path), ["overdue"], wrong)
  })
})
