// Ticket types on the adapter (#545 of #544): a type as Settings › Tickets'
// Types tab and the tickets' Type picker read it, its create, its edit — its own
// fields patched, its fields and its permissions each replaced through their
// own route — and a ticket's type and values on the record, in the create and
// in the patch; and a type's automation (#546 of #544), carried by web id
// and replaced through its own route where it changed, and what the
// Automation tab offers each trigger. Every body is held against the
// contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Project } from "@waste/contracts/organisation"
import { TicketType, TicketTypeActionsSet, TicketTypeCreate, TicketTypeFieldsSet, TicketTypePatch, TicketTypePermissionsSet, type TicketTypeAction } from "@waste/contracts/ticket-types"
import { TicketCreate, TicketPatch, type Ticket } from "@waste/contracts/tickets"

import { type BusinessRecord } from "../../data/business-modules"
import { createTicketRecord, ticketFormFor, updateTicketRecord } from "../../data/tickets"
import {
  actionKindsFor,
  actionsIssue,
  createTicketTypeRecord,
  editFieldsForm,
  newAction,
  fieldValuesAfterEdit,
  fieldValuesFromForm,
  formValuesOfFields,
  TICKET_TYPE_PERMISSIONS_KEY,
  ticketTypeFormFields,
  typeActionsOf,
  typeFieldFormId,
  typeFieldsOf,
  typePermissionsOf,
  updatedTicketTypeRecord,
} from "../../data/ticket-types"
import { NOTHING_RESOLVED, recordFrom, type MappingContext } from "../records/adapter"
import { projectAdapter } from "../records/organisation"
import { loaded, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { ticketTeamsModule } from "../records/ticket-teams"
import { isTicketTypeRecord, ticketTypeAdapter, typeLetsRole } from "../records/ticket-types"
import { TICKET_FIELD_VALUES_KEY, ticketAdapter } from "../records/tickets"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-11-05T10:00:00Z")
const STAMPS = { createdAt: "2026-11-05T08:00:00.000Z", updatedAt: "2026-11-05T08:00:00.000Z" }

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const projectRecord = recordFrom(projectAdapter, copenhagen, { resolve: NOTHING_RESOLVED, now: NOW })

const handlerId = "01a0d2a4-a280-7004-8000-000000000001"
const bulkyId = "01a0d2a4-a280-7043-8000-000000000001"

const handler: BusinessRecord = { ...projectRecord, id: `role-${handlerId}`, name: "Case handler", recordKind: "Role", facts: {}, submittedValues: {} }
const baseState: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)],
  ["configure.access", loaded({ records: [handler], serverIds: new Map([[handler.id, handlerId]]) }, 1)],
])
const context: MappingContext = { resolve: resolverOver(baseState), now: NOW }

const bulky: TicketType = {
  id: bulkyId,
  ...STAMPS,
  name: "Bulky waste collection",
  kind: "container-request",
  description: null,
  status: "active",
  isDefault: false,
  fields: [
    { key: "requested-date", label: "Requested date", helpText: null, input: "date", choices: [], requirement: "to-open" },
    { key: "bags", label: "Bags", helpText: "Bags beside the items", input: "number", choices: [], requirement: "optional" },
    { key: "gate-open", label: "Gate open", helpText: null, input: "yes-no", choices: [], requirement: "optional" },
  ],
  permissions: [{ command: "complete", roleIds: [handlerId] }],
  actions: [],
}
const bulkyRecord = recordFrom(ticketTypeAdapter, bulky, context)
const typesState = loaded({ records: [bulkyRecord], serverIds: new Map([[bulkyRecord.id, bulkyId]]) }, 1)
const state: ServerRecordsState = new Map([...baseState, ["configure.templates", typesState]])
const withTypes: MappingContext = { ...context, resolve: resolverOver(state) }

describe("a ticket type", () => {
  test("reads its kind, its fields and whether it is the default, and carries its fields and its permissions, each role by web id", () => {
    assert.equal(bulkyRecord.id, `ticket-type-${bulkyId}`)
    assert.ok(isTicketTypeRecord(bulkyRecord))
    assert.deepEqual([bulkyRecord.status, bulkyRecord.facts.Kind, bulkyRecord.facts.Fields, bulkyRecord.facts.Default], ["Active", "Container request", "Requested date, Bags, Gate open", "No"])
    assert.deepEqual(typeFieldsOf(bulkyRecord), bulky.fields)
    assert.deepEqual(typePermissionsOf(bulkyRecord), [{ command: "complete", roleIds: [handler.id] }])
  })

  test("a move is offered to a role the type lets make it: a command ticked for roles is theirs alone, an unticked one everyone's", () => {
    const otherRole = "01a0d2a4-a280-7004-8000-000000000002"
    assert.equal(typeLetsRole(bulkyRecord, "complete", handlerId, context.resolve), true)
    assert.equal(typeLetsRole(bulkyRecord, "complete", otherRole, context.resolve), false, "the API would refuse it")
    assert.equal(typeLetsRole(bulkyRecord, "reject", otherRole, context.resolve), true, "no role ticked")
    // A role named by its id chip, its row not read, is the same role.
    const chipped = { submittedValues: { ...bulkyRecord.submittedValues, [TICKET_TYPE_PERMISSIONS_KEY]: JSON.stringify([{ command: "complete", roleIds: [`role-${otherRole}`] }]) } }
    assert.equal(typeLetsRole(chipped, "complete", otherRole, NOTHING_RESOLVED), true)
    assert.equal(typeLetsRole(undefined, "complete", otherRole, context.resolve), true, "a type not read is left to the API")
    assert.equal(typeLetsRole(bulkyRecord, "complete", undefined, context.resolve), true, "so is a role not yet known")
  })

  test("a create is the contracts' body: the name, the kind, the description, the status and whether it is the default", () => {
    const made = createTicketTypeRecord({ name: " Sofa pick-up ", kind: "container-request", description: "", isDefault: true }, { now: 1 })
    assert.ok(isTicketTypeRecord(made))
    const body = ticketTypeAdapter.toCreateBody?.(made, context)
    assert.deepEqual(body, { name: "Sofa pick-up", kind: "container-request", description: null, status: "active", isDefault: true })
    assert.ok(TicketTypeCreate.safeParse(body).success)
    assert.deepEqual(ticketTypeAdapter.toCreateBody?.(createTicketTypeRecord({ name: "Sofa" }, { now: 2 }), context), { path: "kind", message: "Pick the kind the type belongs to" })
  })

  test("an edit patches what moved of the type, then replaces its fields and its permissions each where it changed, roles by server id", async () => {
    const fields = [...bulky.fields.slice(0, 2)]
    const edited = updatedTicketTypeRecord(bulkyRecord, { name: "Bulky waste", description: "Kerbside", status: "Active", isDefault: true, fields, permissions: [{ command: "complete", roleIds: [] }, { command: "reject", roleIds: [handler.id] }] })
    const body = ticketTypeAdapter.toPatchBody?.(bulkyRecord, edited, context) as { type: unknown; fields: unknown; permissions: unknown }
    assert.deepEqual(body, { type: { name: "Bulky waste", description: "Kerbside", isDefault: true }, fields, permissions: [{ command: "reject", roleIds: [handlerId] }] })
    assert.ok(TicketTypePatch.safeParse(body.type).success)
    assert.ok(TicketTypeFieldsSet.safeParse({ fields: body.fields }).success)
    assert.ok(TicketTypePermissionsSet.safeParse({ permissions: body.permissions }).success)
    assert.equal(ticketTypeAdapter.toPatchBody?.(bulkyRecord, updatedTicketTypeRecord(bulkyRecord, { name: bulky.name, description: "", status: "Active", isDefault: false, fields: bulky.fields, permissions: typePermissionsOf(bulkyRecord) }), context), null, "nothing moved")

    const answered: TicketType = { ...bulky, name: "Bulky waste", description: "Kerbside", isDefault: true, fields, permissions: [{ command: "reject", roleIds: [handlerId] }] }
    const { fetch, calls } = scripted([() => json(answered), () => json(answered), () => json(answered)])
    const outcome = await writeRecord(clientOver(fetch), ticketTeamsModule, typesState, edited, { state, now: NOW })
    assert.deepEqual(
      calls.map((call) => [call.init.method, call.url]),
      [
        ["PATCH", `http://api.test/ticket-types/${bulkyId}`],
        ["PUT", `http://api.test/ticket-types/${bulkyId}/fields`],
        ["PUT", `http://api.test/ticket-types/${bulkyId}/permissions`],
      ],
    )
    assert.deepEqual(bodyOf(calls[2]), { permissions: [{ command: "reject", roleIds: [handlerId] }] })
    assert.equal(outcome.kind, "updated")
  })

  test("retiring it is an edit the store sends: the type's patch carries the status, and the row reads the API's answer", async () => {
    const retired = updatedTicketTypeRecord(bulkyRecord, { name: bulky.name, description: "", status: "Inactive", isDefault: false, fields: bulky.fields, permissions: typePermissionsOf(bulkyRecord) })
    const { fetch, calls } = scripted([() => json({ ...bulky, status: "inactive" })])
    const outcome = await writeRecord(clientOver(fetch), ticketTeamsModule, typesState, retired, { state, now: NOW })
    assert.deepEqual(
      calls.map((call) => [call.init.method, call.url, bodyOf(call)]),
      [["PATCH", `http://api.test/ticket-types/${bulkyId}`, { status: "inactive" }]],
    )
    assert.equal(outcome.kind, "updated")
    assert.equal(outcome.kind === "updated" ? outcome.record.status : undefined, "Inactive")
  })
})

describe("a ticket type's automation (#546 of #544)", () => {
  const teamId = "01a0d2a4-a280-7050-8000-000000000001"
  const vehicleId = "01a0d2a4-a280-7051-8000-000000000001"
  const NONE = { teamId: null, userAccountId: null, priority: null, command: null, resolution: null, messageTemplateName: null, recipient: null, followUpTypeId: null, vehicleId: null, daysAhead: null }
  const wire: TicketTypeAction[] = [
    { ...NONE, trigger: "opened", kind: "assign-team", teamId },
    { ...NONE, trigger: "opened", kind: "plan-in-route", vehicleId, daysAhead: 2 },
    { ...NONE, trigger: "completed", kind: "open-follow-up", followUpTypeId: bulkyId },
  ]
  const automated = recordFrom(ticketTypeAdapter, { ...bulky, actions: wire }, context)

  test("a type carries its actions with every team, follow-up type and vehicle by its web id, and counts them", () => {
    assert.deepEqual(
      typeActionsOf(automated).map((action) => [action.kind, action.teamId, action.vehicleId, action.followUpTypeId]),
      [
        ["assign-team", `team-${teamId}`, null, null],
        ["plan-in-route", null, `vehicle-${vehicleId}`, null],
        ["open-follow-up", null, null, `ticket-type-${bulkyId}`],
      ],
    )
    assert.equal(automated.facts.Automation, "3 actions")
    assert.equal(bulkyRecord.facts.Automation, "None")
  })

  test("an edit of the actions alone replaces them through their own route, every reference by its server id", async () => {
    const edited = updatedTicketTypeRecord(automated, { name: bulky.name, description: "", status: "Active", isDefault: false, fields: bulky.fields, permissions: typePermissionsOf(automated), actions: typeActionsOf(automated).slice(1) })
    const body = ticketTypeAdapter.toPatchBody?.(automated, edited, context) as { actions: unknown }
    assert.deepEqual(body, { actions: wire.slice(1) })
    assert.ok(TicketTypeActionsSet.safeParse({ actions: body.actions }).success)

    const { fetch, calls } = scripted([() => json({ ...bulky, actions: wire.slice(1) })])
    const automatedState = loaded({ records: [automated], serverIds: new Map([[automated.id, bulkyId]]) }, 1)
    const outcome = await writeRecord(clientOver(fetch), ticketTeamsModule, automatedState, edited, { state: new Map([...baseState, ["configure.templates", automatedState]]), now: NOW })
    assert.deepEqual(calls.map((call) => [call.init.method, call.url]), [["PUT", `http://api.test/ticket-types/${bulkyId}/actions`]])
    assert.equal(outcome.kind, "updated")
  })

  test("a trigger that closes the ticket offers a message or a follow-up alone; a plan in a route is offered where a stop naming the ticket's container answers the kind", () => {
    assert.deepEqual(actionKindsFor("completed", "overflow"), ["send-message", "open-follow-up"])
    assert.deepEqual(actionKindsFor("rejected", "overflow"), ["send-message", "open-follow-up"])
    assert.ok(actionKindsFor("opened", "overflow").includes("plan-in-route"))
    assert.ok(!actionKindsFor("opened", "container-request").includes("plan-in-route"), "a delivery names more than the container")
    assert.ok(!actionKindsFor("opened", "complaint").includes("plan-in-route"))
    for (const kind of actionKindsFor("opened", "overflow")) assert.equal(newAction("opened", kind).kind, kind)
  })

  test("the tab's actions are held to the domain's rules before the request, each told by its trigger and its place", () => {
    assert.equal(actionsIssue([newAction("opened", "set-priority"), newAction("opened", "assign-team")]), "On opening, action 2: An action to assign to a team names a team.")
    assert.equal(actionsIssue([newAction("in-progress", "set-status")]), undefined, "a start's sensible default: complete it, serviced")
    assert.equal(actionsIssue([{ ...newAction("on-hold", "set-status"), command: "hold", resolution: null }]), "On reaching on hold, action 1: A ticket reaching on hold is on hold already; move it to another status.")
    assert.equal(actionsIssue(wire), undefined)
  })
})

describe("a ticket of a type", () => {
  const base = { projectId: projectRecord.id, subject: "A sofa", description: "Collect a sofa at Parkvej 18" }

  test("New ticket asks for a type's fields while that type is picked, and requires the ones it needs to open but yes or no", () => {
    const fields = ticketTypeFormFields([bulkyRecord])
    assert.deepEqual(
      fields.map((field) => [field.id, field.type, field.visibleWhen?.equals, field.requiredWhen !== undefined]),
      [
        [typeFieldFormId(bulkyRecord.id, "requested-date"), "date", bulkyRecord.id, true],
        [typeFieldFormId(bulkyRecord.id, "bags"), "number", bulkyRecord.id, false],
        [typeFieldFormId(bulkyRecord.id, "gate-open"), "checkbox", bulkyRecord.id, false],
      ],
    )
    assert.ok(ticketFormFor([bulkyRecord]).sections.some((section) => section.id === "type-fields"))
    assert.equal(ticketFormFor([]).sections.length, 3, "no type with fields, no section")
  })

  test("a create names the picked type and its values as the wire takes them, or the kind alone without one", () => {
    const values = { ...base, ticketTypeId: bulkyRecord.id, kind: "", [typeFieldFormId(bulkyRecord.id, "requested-date")]: "2026-11-12", [typeFieldFormId(bulkyRecord.id, "bags")]: "3", [typeFieldFormId(bulkyRecord.id, "gate-open")]: true }
    const body = ticketAdapter.toCreateBody?.(createTicketRecord(values, { now: 1 }), withTypes) as Record<string, unknown>
    assert.equal(body.ticketTypeId, bulkyId)
    assert.equal(body.kind, undefined, "the type's kind is the ticket's")
    assert.deepEqual(body.fieldValues, { "requested-date": "2026-11-12", bags: 3, "gate-open": true })
    assert.ok(TicketCreate.safeParse(body).success)
    const untyped = ticketAdapter.toCreateBody?.(createTicketRecord({ ...base, kind: "complaint" }, { now: 2 }), withTypes) as Record<string, unknown>
    assert.deepEqual([untyped.kind, untyped.ticketTypeId], ["complaint", undefined])
    assert.deepEqual(ticketAdapter.toCreateBody?.(createTicketRecord(base, { now: 3 }), withTypes), { path: "kind", message: "Pick the type or the kind of case" })
  })

  test("the details' edit of the fields clears a blank one, keeps a value no field of the type holds, and the patch sends what moved with null for a clear", () => {
    const ticket = { id: "01a0d2a4-a280-7040-8000-000000000001", ...STAMPS, projectId: copenhagen.id, number: 1001, label: "T-1001", kind: "container-request", ticketTypeId: bulkyId, fieldValues: { "requested-date": "2026-11-12", bags: 2, legacy: "kept" }, status: "open", priority: "none", source: "office", subject: "A sofa", description: "Collect it", occurredAt: STAMPS.createdAt, dueAt: null, assigneeUserAccountId: null, teamId: null, createdBy: null, sourceEventId: null, links: { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }, resolution: null, recollectionRouteId: null, recollectionPickupId: null, chargeProductId: null, closedAt: null, bookedRouteId: null, bookedPickupId: null, countedBy: null } satisfies Ticket
    const record = recordFrom(ticketAdapter, ticket, withTypes)
    assert.equal(record.facts.Type, "Bulky waste collection")
    assert.equal(record.submittedValues?.ticketTypeId, bulkyRecord.id)
    const form = editFieldsForm(bulkyRecord)
    assert.ok(form.sections[0].fields.every((field) => field.visibleWhen === undefined && field.requiredWhen === undefined))
    const shown = formValuesOfFields(bulkyRecord.id, ticket.fieldValues)
    const next = fieldValuesAfterEdit(bulkyRecord, ticket.fieldValues, { ...shown, [typeFieldFormId(bulkyRecord.id, "bags")]: "", [typeFieldFormId(bulkyRecord.id, "gate-open")]: true })
    assert.deepEqual(next, { legacy: "kept", "requested-date": "2026-11-12", "gate-open": true })
    const body = ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { [TICKET_FIELD_VALUES_KEY]: JSON.stringify(next) }), withTypes)
    assert.deepEqual(body, { fieldValues: { "gate-open": true, bags: null } })
    assert.ok(TicketPatch.safeParse(body).success)
    assert.deepEqual(fieldValuesFromForm(bulkyRecord, { [typeFieldFormId(bulkyRecord.id, "bags")]: " " }), {}, "a blank is no value")
  })

  test("a role that reads no types still patches a ticket: its type is named by the id its web id carries, as a team's is", () => {
    const ticket = { id: "01a0d2a4-a280-7040-8000-000000000002", ...STAMPS, projectId: copenhagen.id, number: 1002, label: "T-1002", kind: "container-request", ticketTypeId: bulkyId, fieldValues: {}, status: "open", priority: "none", source: "office", subject: "A sofa", description: "Collect it", occurredAt: STAMPS.createdAt, dueAt: null, assigneeUserAccountId: null, teamId: null, createdBy: null, sourceEventId: null, links: { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }, resolution: null, recollectionRouteId: null, recollectionPickupId: null, chargeProductId: null, closedAt: null, bookedRouteId: null, bookedPickupId: null, countedBy: null } satisfies Ticket
    // The types' module never read: the store holds the organisation and the accounts alone.
    const record = recordFrom(ticketAdapter, ticket, context)
    assert.equal(record.submittedValues?.ticketTypeId, `ticket-type-${bulkyId}`)
    assert.deepEqual(ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { priority: "high" }), context), { priority: "high" })
    const otherType = "01a0d2a4-a280-7043-8000-000000000002"
    assert.deepEqual(ticketAdapter.toPatchBody?.(record, updateTicketRecord(record, { ticketTypeId: `ticket-type-${otherType}` }), context), { ticketTypeId: otherType })
  })
})
