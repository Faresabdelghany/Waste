// Ticket types on the adapter (#545 of #544): a type as Settings › Ticket
// types and the tickets' Type picker read it, its create, its edit — its own
// fields patched, its fields and its permissions each replaced through their
// own route — and a ticket's type and values on the record, in the create and
// in the patch. Every body is held against the contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Project } from "@waste/contracts/organisation"
import { TicketType, TicketTypeCreate, TicketTypeFieldsSet, TicketTypePatch, TicketTypePermissionsSet } from "@waste/contracts/ticket-types"
import { TicketCreate, TicketPatch, type Ticket } from "@waste/contracts/tickets"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { createTicketRecord, ticketFormFor, updateTicketRecord } from "../../data/tickets"
import {
  createTicketTypeRecord,
  editFieldsForm,
  fieldValuesAfterEdit,
  fieldValuesFromForm,
  formValuesOfFields,
  ticketTypeFormFields,
  typeFieldFormId,
  typeFieldsOf,
  typePermissionsOf,
  updatedTicketTypeRecord,
} from "../../data/ticket-types"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { projectAdapter } from "../records/organisation"
import { loaded, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { ticketTeamsModule } from "../records/ticket-teams"
import { isTicketTypeRecord, ticketTypeAdapter } from "../records/ticket-types"
import { TICKET_FIELD_VALUES_KEY, ticketAdapter } from "../records/tickets"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-11-05T10:00:00Z")
const STAMPS = { createdAt: "2026-11-05T08:00:00.000Z", updatedAt: "2026-11-05T08:00:00.000Z" }

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "none", holdForReview: false, privacyPolicy: { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }, branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } }
const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const handlerId = "01a0d2a4-a280-7004-8000-000000000001"
const bulkyId = "01a0d2a4-a280-7043-8000-000000000001"

const handler: BusinessRecord = { ...projectRecord, id: `role-${handlerId}`, name: "Case handler", recordKind: "Role", facts: {}, submittedValues: {} }
const baseState: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)],
  ["configure.access", loaded({ records: [handler], serverIds: new Map([[handler.id, handlerId]]) }, 1)],
])
const context: MappingContext = { fixtures: [], resolve: resolverOver(baseState), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }

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
}
const bulkyRecord = ticketTypeAdapter.toRecord(bulky, context)
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
    const outcome = await writeRecord(clientOver(fetch), ticketTeamsModule, typesState, edited, { fixtures: [], state, now: NOW })
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
    const ticket = { id: "01a0d2a4-a280-7040-8000-000000000001", ...STAMPS, projectId: copenhagen.id, number: 1001, label: "T-1001", kind: "container-request", ticketTypeId: bulkyId, fieldValues: { "requested-date": "2026-11-12", bags: 2, legacy: "kept" }, status: "open", priority: "none", source: "office", subject: "A sofa", description: "Collect it", occurredAt: STAMPS.createdAt, dueAt: null, assigneeUserAccountId: null, teamId: null, createdBy: null, sourceEventId: null, links: { routeId: null, pickupId: null, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null }, resolution: null, recollectionRouteId: null, recollectionPickupId: null, chargeProductId: null, closedAt: null, bookedRouteId: null, bookedPickupId: null } satisfies Ticket
    const record = ticketAdapter.toRecord(ticket, withTypes)
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
})
