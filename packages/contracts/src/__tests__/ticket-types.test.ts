import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TICKET_TYPE_ACTIONS_MAX } from "@waste/domain/resolution/automation"

import { AT_MOST_FIELDS, DEFAULT_TYPE_OFFERED, EACH_COMMAND_ONCE, EACH_ROLE_ONCE, TICKET_FIELD_KEY_SHAPE, TicketFieldValues, TicketFieldValuesPatch, TicketType, TicketTypeActionsSet, TicketTypeCreate, TicketTypeFieldsSet, TicketTypePatch, TicketTypePermissionsSet } from "../ticket-types"
import { Ticket, TicketCreate, TicketListQuery, TicketPatch, TYPE_OR_KIND } from "../tickets"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMP = "2026-11-05T09:00:00.000Z"

describe("TicketType", () => {
  test("is the company's, by a name, of one kind, active or retired, its kind's default or not, with its fields, permissions and actions", () => {
    const type = {
      id: ID,
      name: "Bulky waste collection",
      kind: "container-request",
      description: null,
      status: "active",
      isDefault: false,
      fields: [{ key: "requested-date", label: "Requested date", helpText: null, input: "date", choices: [], requirement: "to-open" }],
      permissions: [{ command: "complete", roleIds: [OTHER] }],
      actions: [{ trigger: "opened", kind: "assign-team", teamId: OTHER, userAccountId: null, priority: null, command: null, resolution: null, messageTemplateName: null, recipient: null, followUpTypeId: null }],
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

describe("TicketTypeActionsSet (#546 of #544)", () => {
  test("an action leaves out what its kind does not take", () => {
    assert.deepEqual(TicketTypeActionsSet.parse({ actions: [{ trigger: "completed", kind: "send-message", messageTemplateName: "Container delivered", recipient: "owner" }] }), {
      actions: [{ trigger: "completed", kind: "send-message", teamId: null, userAccountId: null, priority: null, command: null, resolution: null, messageTemplateName: "Container delivered", recipient: "owner", followUpTypeId: null }],
    })
    assert.equal(TicketTypeActionsSet.safeParse({ actions: [] }).success, true, "a type with no automation")
  })

  test("each action names what its kind needs and nothing else, and moves to no status its trigger is, at the member at fault", () => {
    assert.deepEqual(refusal(TicketTypeActionsSet.safeParse({ actions: [{ trigger: "opened", kind: "open-follow-up" }] })), [{ path: "actions.0.followUpTypeId", message: "An action to open a follow-up names a ticket type" }])
    assert.deepEqual(refusal(TicketTypeActionsSet.safeParse({ actions: [{ trigger: "opened", kind: "set-status", command: "complete" }] })), [{ path: "actions.0.resolution", message: "An action to move the status names a resolution" }])
    assert.deepEqual(refusal(TicketTypeActionsSet.safeParse({ actions: [{ trigger: "pending", kind: "set-status", command: "wait" }] })), [{ path: "actions.0.command", message: "A ticket reaching pending is pending already; move it to another status" }])
    assert.deepEqual(refusal(TicketTypeActionsSet.safeParse({ actions: [{ trigger: "rejected", kind: "assign-team", teamId: ID }] })), [{ path: "actions.0.teamId", message: "A ticket reaching rejected is closed and keeps its team" }])
    assert.equal(TicketTypeActionsSet.safeParse({ actions: [{ trigger: "opened", kind: "set-status", command: "reopen" }] }).success, false, "reopen is no action's: open is no trigger")
    assert.equal(TicketTypeActionsSet.safeParse({ actions: [{ trigger: "open", kind: "set-priority", priority: "high" }] }).success, false)
    assert.equal(TicketTypeActionsSet.safeParse({ actions: [{ trigger: "opened", kind: "send-message", messageTemplateName: "Hello", recipient: "neighbour" }] }).success, false)
  })

  test("holds a type's actions to the domain's cap", () => {
    const action = { trigger: "opened", kind: "set-priority", priority: "high" }
    assert.equal(TicketTypeActionsSet.safeParse({ actions: Array.from({ length: TICKET_TYPE_ACTIONS_MAX }, () => action) }).success, true)
    assert.equal(TicketTypeActionsSet.safeParse({ actions: Array.from({ length: TICKET_TYPE_ACTIONS_MAX + 1 }, () => action) }).success, false)
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
