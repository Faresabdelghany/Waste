import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AT_MOST_FIELDS, DEFAULT_TYPE_OFFERED, EACH_COMMAND_ONCE, EACH_ROLE_ONCE, TICKET_FIELD_KEY_SHAPE, TicketFieldValues, TicketFieldValuesPatch, TicketType, TicketTypeCreate, TicketTypeFieldsSet, TicketTypePatch, TicketTypePermissionsSet } from "../ticket-types"
import { Ticket, TicketCreate, TicketListQuery, TicketPatch, TYPE_OR_KIND } from "../tickets"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMP = "2026-11-05T09:00:00.000Z"

describe("TicketType", () => {
  test("is the company's, by a name, of one kind, active or retired, its kind's default or not, with its fields and permissions", () => {
    const type = {
      id: ID,
      name: "Bulky waste collection",
      kind: "container-request",
      description: null,
      status: "active",
      isDefault: false,
      fields: [{ key: "requested-date", label: "Requested date", helpText: null, input: "date", choices: [], requirement: "to-open" }],
      permissions: [{ command: "complete", roleIds: [OTHER] }],
      createdAt: STAMP,
      updatedAt: STAMP,
    }
    assert.deepEqual(TicketType.parse(type), type)
    assert.equal(TicketType.safeParse({ ...type, kind: "bulky" }).success, false)
    assert.equal(TicketType.safeParse({ ...type, permissions: [{ command: "assign", roleIds: [] }] }).success, false, "assign moves no status")
  })

  test("a create starts active, not the default, without a description unless it says, and refuses what the server owns", () => {
    assert.deepEqual(TicketTypeCreate.parse({ name: "Bulky waste collection", kind: "container-request" }), { name: "Bulky waste collection", kind: "container-request", description: null, status: "active", isDefault: false })
    assert.deepEqual(refusal(TicketTypeCreate.safeParse({ name: "Retired default", kind: "other", status: "inactive", isDefault: true })), [{ path: "status", message: DEFAULT_TYPE_OFFERED }])
    refusesWhatTheServerOwns(TicketTypeCreate, { name: "Bulky waste collection", kind: "container-request" })
  })

  test("a patch never moves the kind, makes a type the default and never unmakes it, and changes something", () => {
    assert.deepEqual(TicketTypePatch.parse({ isDefault: true }), { isDefault: true })
    assert.equal(TicketTypePatch.safeParse({ isDefault: false }).success, false)
    assert.equal(TicketTypePatch.safeParse({ kind: "other" }).success, false)
    assert.deepEqual(refusal(TicketTypePatch.safeParse({ isDefault: true, status: "inactive" })), [{ path: "status", message: DEFAULT_TYPE_OFFERED }])
    refusesAnEmptyPatch(TicketTypePatch)
  })
})

describe("TicketTypeFieldsSet", () => {
  test("a field takes no help text, no choices and no requirement unless it says", () => {
    assert.deepEqual(TicketTypeFieldsSet.parse({ fields: [{ key: "note", label: "Note", input: "text" }] }), { fields: [{ key: "note", label: "Note", helpText: null, input: "text", choices: [], requirement: "optional" }] })
  })

  test("names each key once, a key of its shape, and choices on a choice field alone, at the field at fault", () => {
    assert.deepEqual(refusal(TicketTypeFieldsSet.safeParse({ fields: [{ key: "note", label: "Note", input: "text" }, { key: "note", label: "Again", input: "text" }] })), [{ path: "fields.1.key", message: "Name each field's key once" }])
    assert.deepEqual(refusal(TicketTypeFieldsSet.safeParse({ fields: [{ key: "Note", label: "Note", input: "text" }] })), [{ path: "fields.0.key", message: TICKET_FIELD_KEY_SHAPE }])
    assert.deepEqual(refusal(TicketTypeFieldsSet.safeParse({ fields: [{ key: "decision", label: "Decision", input: "choice" }] })), [{ path: "fields.0.choices", message: "A choice field offers at least one choice" }])
    assert.equal(TicketTypeFieldsSet.safeParse({ fields: [] }).success, true, "a type with no fields")
  })
})

describe("TicketTypePermissionsSet", () => {
  test("names each command once and each of its roles once; a command may name none", () => {
    assert.deepEqual(TicketTypePermissionsSet.parse({ permissions: [{ command: "complete", roleIds: [ID] }, { command: "reject", roleIds: [] }] }).permissions.length, 2)
    assert.deepEqual(refusal(TicketTypePermissionsSet.safeParse({ permissions: [{ command: "complete", roleIds: [] }, { command: "complete", roleIds: [ID] }] })), [{ path: "permissions", message: EACH_COMMAND_ONCE }])
    assert.deepEqual(refusal(TicketTypePermissionsSet.safeParse({ permissions: [{ command: "complete", roleIds: [ID, ID] }] })), [{ path: "permissions.0.roleIds", message: EACH_ROLE_ONCE }])
  })
})

describe("a ticket's type and its values", () => {
  test("a value is text, a number or yes or no, under a key", () => {
    assert.deepEqual(TicketFieldValues.parse({ "requested-date": "2026-11-05", bags: 3, gate: true }), { "requested-date": "2026-11-05", bags: 3, gate: true })
    assert.equal(TicketFieldValues.safeParse({ Bags: 3 }).success, false)
    assert.equal(TicketFieldValues.safeParse({ bags: null }).success, false, "a ticket holds no null; a patch clears with it")
    assert.deepEqual(TicketFieldValuesPatch.parse({ bags: null }), { bags: null })
  })

  test("a ticket the outbox took before the types reads as no type and no values", () => {
    const before = {
      id: ID,
      projectId: OTHER,
      number: 8831,
      label: "T-8831",
      kind: "complaint",
      status: "open",
      priority: "none",
      source: "office",
      subject: "Bin not emptied",
      description: "Parkvej 18",
      occurredAt: STAMP,
      dueAt: null,
      assigneeUserAccountId: null,
      createdBy: OTHER,
      sourceEventId: null,
      links: { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null },
      resolution: null,
      recollectionRouteId: null,
      closedAt: null,
      createdAt: STAMP,
      updatedAt: STAMP,
    }
    const parsed = Ticket.parse(before)
    assert.equal(parsed.ticketTypeId, null)
    assert.deepEqual(parsed.fieldValues, {})
  })

  test("a create names its type, its kind or both, with the values it has; neither is refused", () => {
    const base = { projectId: OTHER, subject: "Sofa", description: "Collect a sofa" }
    assert.deepEqual(TicketCreate.parse({ ...base, ticketTypeId: ID, fieldValues: { bags: 2 } }).fieldValues, { bags: 2 })
    assert.equal(TicketCreate.parse({ ...base, kind: "other" }).kind, "other")
    assert.deepEqual(TicketCreate.parse({ ...base, kind: "other" }).fieldValues, {})
    assert.deepEqual(refusal(TicketCreate.safeParse(base)), [{ path: "ticketTypeId", message: TYPE_OR_KIND }])
  })

  test("a body names as many values as a type may have fields, so it is judged in bounded time", () => {
    const base = { projectId: OTHER, subject: "Sofa", description: "Collect a sofa", kind: "other" }
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`key-${index}`, "x"]))
    assert.deepEqual(refusal(TicketCreate.safeParse({ ...base, fieldValues: many })), [{ path: "fieldValues", message: AT_MOST_FIELDS }])
    assert.equal(TicketPatch.safeParse({ fieldValues: Object.fromEntries(Array.from({ length: 61 }, (_, index) => [`key-${index}`, null])) }).success, false)
  })

  test("a patch moves the type and merges values, null clearing one; the list filters by type", () => {
    assert.deepEqual(TicketPatch.parse({ ticketTypeId: ID, fieldValues: { bags: null } }), { ticketTypeId: ID, fieldValues: { bags: null } })
    assert.equal(TicketListQuery.parse({ projectId: OTHER, ticketTypeId: ID }).ticketTypeId, ID)
  })
})
