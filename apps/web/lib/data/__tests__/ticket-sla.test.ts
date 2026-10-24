// Settings › Ticket SLA's form (O4 of #290): a project's targets as rows a
// person edits — every kind or one kind, a priority, the hours — and the
// `PUT /projects/:id/ticket-sla` body they become, refused where the API
// would refuse them, at the row.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SLA_TARGET_ONCE, TicketSlaSet, type TicketSla } from "@waste/contracts/ticket-sla"
import { TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_KINDS, TICKET_PRIORITIES } from "@waste/domain/resolution/vocabulary"

import { EVERY_KIND, HOURS_SENTENCE, newSlaRow, ONCE_SENTENCE, SLA_KIND_OPTIONS, SLA_PRIORITY_OPTIONS, slaAccessOf, slaBodyOf, slaRowsOf, type SlaRow } from "../ticket-sla"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"

const sla: TicketSla = {
  projectId: ID,
  targets: [
    { id: ID, kind: null, priority: "high", hours: 24 },
    { id: OTHER, kind: "overflow", priority: "high", hours: 4 },
  ],
}

const row = (kind: string, priority: string, hours: string, key = `${kind}-${priority}`): SlaRow => ({ key, kind, priority, hours })

describe("the rows", () => {
  test("are the project's targets as the API answered them, every kind by its own value", () => {
    assert.deepEqual(slaRowsOf(sla), [row(EVERY_KIND, "high", "24", ID), row("overflow", "high", "4", OTHER)])
  })

  test("offer every kind first, then each kind, and each priority, in the vocabulary's order and words", () => {
    assert.deepEqual(SLA_KIND_OPTIONS[0], { value: EVERY_KIND, label: "Every kind" })
    assert.deepEqual(SLA_KIND_OPTIONS.slice(1).map((option) => option.value), [...TICKET_KINDS])
    assert.equal(SLA_KIND_OPTIONS.find((option) => option.value === "missed-collection")?.label, "Missed collection")
    assert.deepEqual(SLA_PRIORITY_OPTIONS.map((option) => option.value), [...TICKET_PRIORITIES])
  })

  test("a new row takes the first priority without an every-kind target, at a day", () => {
    assert.deepEqual(newSlaRow([], "a"), row(EVERY_KIND, "critical", "24", "a"))
    assert.deepEqual(newSlaRow([row(EVERY_KIND, "critical", "4")], "b"), row(EVERY_KIND, "high", "24", "b"))
  })

  test("once every priority has one, a new row takes the first kind free at the first priority", () => {
    const everyKind = TICKET_PRIORITIES.map((priority) => row(EVERY_KIND, priority, "24"))
    assert.deepEqual(newSlaRow(everyKind, "c"), row(TICKET_KINDS[0], "critical", "24", "c"))
  })
})

describe("the body", () => {
  test("is the rows as the API takes them: every kind as null, the hours as a number, the row's key the client's alone", () => {
    const body = slaBodyOf([row(EVERY_KIND, "high", "24"), row("overflow", "high", " 4 ")])
    assert.deepEqual(body, { targets: [{ kind: null, priority: "high", hours: 24 }, { kind: "overflow", priority: "high", hours: 4 }] })
    assert.ok(TicketSlaSet.safeParse(body).success, "the contracts take it")
    assert.deepEqual(slaBodyOf([]), { targets: [] }, "no rows: the project without an SLA")
  })

  test("hours that are no whole number from one to a year are refused at the row", () => {
    for (const hours of ["", "0", "1.5", "-2", "two", String(TICKET_SLA_HOURS_MAX + 1)]) {
      assert.deepEqual(slaBodyOf([row(EVERY_KIND, "low", "8"), row(EVERY_KIND, "high", hours)]), { index: 1, field: "hours", message: HOURS_SENTENCE }, hours)
    }
    assert.equal(HOURS_SENTENCE, `Give the hours as a whole number from 1 to ${TICKET_SLA_HOURS_MAX}`)
  })

  test("a kind and a priority twice are refused at the second, in the contracts' own sentence", () => {
    assert.deepEqual(slaBodyOf([row("overflow", "high", "4"), row(EVERY_KIND, "high", "24"), row("overflow", "high", "8")]), { index: 2, field: "kind", message: ONCE_SENTENCE })
    assert.equal(ONCE_SENTENCE, SLA_TARGET_ONCE)
  })
})

describe("who may read and set it", () => {
  test("view on the templates' module reads it, edit sets it, and another module's grant does neither", () => {
    assert.deepEqual(slaAccessOf([{ moduleKey: "configure.templates", actions: ["view", "edit"] }]), { view: true, edit: true })
    assert.deepEqual(slaAccessOf([{ moduleKey: "configure.templates", actions: ["view"] }]), { view: true, edit: false })
    assert.deepEqual(slaAccessOf([{ moduleKey: "operate.tickets", actions: ["view", "edit"] }]), { view: false, edit: false })
    assert.deepEqual(slaAccessOf(undefined), { view: false, edit: false })
  })
})
