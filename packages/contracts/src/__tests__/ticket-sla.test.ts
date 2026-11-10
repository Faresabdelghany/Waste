import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SLA_KIND_OR_TYPE, TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_TYPE_SETTINGS_MAX } from "@waste/domain/resolution/ticket-types"
import { TICKET_KINDS, TICKET_PRIORITIES } from "@waste/domain/resolution/vocabulary"

import { TicketSla, TicketSlaSet } from "../ticket-sla"
import { TicketListQuery } from "../tickets"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"

const sla = {
  projectId: ID,
  targets: [
    { id: ID, kind: null, ticketTypeId: null, priority: "high", hours: 24 },
    { id: ID, kind: "overflow", ticketTypeId: null, priority: "high", hours: 4 },
  ],
}

describe("TicketSla", () => {
  test("is a project's targets on the wire: every kind or one kind, a priority and the hours", () => {
    assert.deepEqual(TicketSla.parse(sla), sla)
    assert.deepEqual(TicketSla.parse({ projectId: ID, targets: [] }).targets, [])
    assert.deepEqual(refusal(TicketSla.safeParse({ ...sla, targets: [{ id: ID, kind: "deviation", ticketTypeId: null, priority: "high", hours: 4 }] })).map((issue) => issue.path), ["targets.0.kind"])
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
    assert.deepEqual(refusal(TicketSlaSet.safeParse(twice)), [{ path: "targets.2", message: "Name each kind or ticket type and priority once: a ticket is due by one target" }])
    const everyKindTwice = { targets: [{ kind: null, priority: "low", hours: 1 }, { kind: null, priority: "low", hours: 2 }] }
    assert.deepEqual(refusal(TicketSlaSet.safeParse(everyKindTwice)).map((issue) => issue.path), ["targets.1"])
  })

  test("a target may be one ticket type's (#548 of #544), never a kind's and a type's at once; a type and a priority are named once", () => {
    const typed = { kind: null, ticketTypeId: ID, priority: "high", hours: 72 }
    assert.deepEqual(TicketSlaSet.parse({ targets: [...body.targets, typed] }).targets[2], typed)
    assert.deepEqual(TicketSlaSet.parse({ targets: [{ kind: "overflow", priority: "low", hours: 8 }] }).targets[0].ticketTypeId, null, "absent, a kind's or every kind's")
    assert.deepEqual(refusal(TicketSlaSet.safeParse({ targets: [{ ...typed, kind: "overflow" }] })), [{ path: "targets.0", message: SLA_KIND_OR_TYPE }])
    assert.deepEqual(refusal(TicketSlaSet.safeParse({ targets: [typed, { ...typed, hours: 4 }] })).map((issue) => issue.path), ["targets.1"])
  })

  test("holds at most every kind, each kind and the types a set may name, at each priority", () => {
    const types = Array.from({ length: TICKET_TYPE_SETTINGS_MAX + 1 }, (_, n) => `01a0d3a5-e5e0-7000-8000-${String(n + 2).padStart(12, "0")}`)
    const fullest = TICKET_PRIORITIES.flatMap((priority) => [
      ...[null, ...TICKET_KINDS].map((kind) => ({ kind, priority, hours: 24 })),
      ...types.slice(0, TICKET_TYPE_SETTINGS_MAX).map((ticketTypeId) => ({ kind: null, ticketTypeId, priority, hours: 24 })),
    ])
    assert.equal(TicketSlaSet.safeParse({ targets: fullest }).success, true, "every kind, each kind and as many types as a setting may name, at each priority")
    assert.deepEqual(refusal(TicketSlaSet.safeParse({ targets: [...fullest, { kind: null, ticketTypeId: types[TICKET_TYPE_SETTINGS_MAX], priority: "low", hours: 24 }] })).map((issue) => issue.path), ["targets"], "one target more")
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
