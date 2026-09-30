// The Pilot's forms for properties, property groups and shared collection
// points (#184): each offers what the wire carries and nothing it would drop,
// its field ids are the keys the adapters read, and what a person fills in is
// the body the contract accepts — held here through the adapters themselves,
// so a renamed field cannot quietly send nothing.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PropertyCreate, PropertyGroupCreate, SharedCollectionPointCreate, type Customer, type Property } from "@waste/contracts/customers"
import type { Project } from "@waste/contracts/organisation"

import { NOTHING_RESOLVED, type MappingContext } from "../../api/records/adapter"
import { projectAdapter } from "../../api/records/organisation"
import { propertyAdapter, propertyGroupAdapter, sharedPointAdapter } from "../../api/records/properties"
import { customerAdapter } from "../../api/records/registry"
import { loaded, resolverOver, type ServerRecordsState } from "../../api/records/server-records"
import { FIXTURE_COMPANY_ID, getModuleDefinition } from "../business-modules"
import type { BusinessFormSchema } from "../business-form-types"
import {
  createPropertyGroupRecord,
  createPropertyRecord,
  createSharedPointRecord,
  formValuesOf,
  PARTY_FIELDS,
  PROPERTY_EDIT_FORM,
  PROPERTY_FORM,
  PROPERTY_GROUP_EDIT_FORM,
  PROPERTY_GROUP_FORM,
  SHARED_POINT_EDIT_FORM,
  SHARED_POINT_FORM,
  updatedRecord,
} from "../properties"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, status: "active" }
const parkvej: Property = { id: "01a0d2a4-a280-700c-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", registryId: null, kind: "residential", location: null, notes: null, status: "active", parties: [{ customerId: osterbro.id, role: "owner" }] }

const fixtures = (moduleId: string, workspaceId: "configure" | "customers" = "customers") => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const bare: MappingContext = { fixtures: [], resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const projectRecord = projectAdapter.toRecord(copenhagen, { ...bare, fixtures: fixtures("organization", "configure") })
const osterbroRecord = customerAdapter.toRecord(osterbro, { ...bare, fixtures: fixtures("contacts") })
const base: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)],
  ["customers.contacts", loaded({ records: [osterbroRecord], serverIds: new Map([[osterbroRecord.id, osterbro.id]]) }, 1)],
])
const parkvejRecord = propertyAdapter.toRecord(parkvej, { ...bare, resolve: resolverOver(base) })
const state: ServerRecordsState = new Map([...base, ["customers.properties", loaded({ records: [parkvejRecord], serverIds: new Map([[parkvejRecord.id, parkvej.id]]) }, 1)]])
const context: MappingContext = { ...bare, resolve: resolverOver(state) }

const fieldIdsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))
const requiredOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.filter((field) => field.required).map((field) => field.id))
const fieldOf = (schema: BusinessFormSchema, id: string) => schema.sections.flatMap((section) => section.fields).find((field) => field.id === id)

describe("the property form on the Pilot", () => {
  test("offers what the wire carries — the point as two numbers, a multiselect per party role — and nothing it would drop", () => {
    assert.deepEqual(fieldIdsOf(PROPERTY_FORM), ["projectId", "displayName", "serviceAddress", "registryId", "propertyType", "latitude", "longitude", "ownerIds", "payerIds", "tenantIds", "administratorIds", "serviceContactIds", "specialConditions"])
    assert.deepEqual(requiredOf(PROPERTY_FORM), ["projectId", "displayName", "serviceAddress", "propertyType"], "a property is registered before it is geocoded, and with nobody billed yet")
    assert.deepEqual(Object.values(PARTY_FIELDS), ["ownerIds", "payerIds", "tenantIds", "administratorIds", "serviceContactIds"])
    for (const id of Object.values(PARTY_FIELDS)) assert.equal(fieldOf(PROPERTY_FORM, id)?.type, "multiselect", id)
  })

  test("what it makes is a create body the contract accepts, and the edit holds the project and opens on the record's values", () => {
    const made = createPropertyRecord({ projectId: projectRecord.id, displayName: "Ryesgade 3", serviceAddress: "Ryesgade 3, 2200 København N", registryId: "", propertyType: "mixed", latitude: "55.6931", longitude: "12.5667", ownerIds: osterbroRecord.id, specialConditions: "" }, { now: 1 })
    assert.equal(made.name, "Ryesgade 3")
    assert.deepEqual(made.projectIds, [projectRecord.id])
    assert.ok(PropertyCreate.safeParse(propertyAdapter.toCreateBody?.(made, context)).success)
    assert.equal(fieldOf(PROPERTY_EDIT_FORM, "projectId")?.readOnly, true)
    assert.deepEqual(fieldIdsOf(PROPERTY_EDIT_FORM), fieldIdsOf(PROPERTY_FORM))
    const values = formValuesOf(PROPERTY_EDIT_FORM, parkvejRecord)
    assert.equal(values.displayName, "Parkvej 18")
    assert.equal(values.ownerIds, osterbroRecord.id)
    const edited = updatedRecord(parkvejRecord, { ...values, displayName: "Parkvej 18A", tenantIds: osterbroRecord.id }, PROPERTY_EDIT_FORM.nameField ?? "displayName")
    assert.equal(edited.id, parkvejRecord.id)
    assert.equal(edited.name, "Parkvej 18A")
    assert.deepEqual(propertyAdapter.toPatchBody(parkvejRecord, edited, context), {
      property: { name: "Parkvej 18A" },
      parties: [
        { customerId: osterbro.id, role: "owner" },
        { customerId: osterbro.id, role: "tenant" },
      ],
    })
  })
})

describe("the property group form on the Pilot", () => {
  test("offers the group, its initial state and its members; the edit leaves the status to the lifecycle", () => {
    assert.deepEqual(fieldIdsOf(PROPERTY_GROUP_FORM), ["projectId", "name", "purpose", "status", "responsibleCustomerId", "memberPropertyIds", "memberRole"])
    assert.deepEqual(requiredOf(PROPERTY_GROUP_FORM), ["projectId", "name", "purpose", "status"])
    assert.equal(fieldOf(PROPERTY_GROUP_FORM, "memberPropertyIds")?.type, "multiselect")
    assert.equal(fieldOf(PROPERTY_GROUP_FORM, "memberRole")?.defaultValue, "member")
    assert.deepEqual(fieldIdsOf(PROPERTY_GROUP_EDIT_FORM), ["projectId", "name", "purpose", "responsibleCustomerId", "memberPropertyIds", "memberRole"])
    assert.equal(fieldOf(PROPERTY_GROUP_EDIT_FORM, "projectId")?.readOnly, true)
  })

  test("what it makes is a create body the contract accepts", () => {
    const made = createPropertyGroupRecord({ projectId: projectRecord.id, name: "Østerbro East", purpose: "administration", status: "active", responsibleCustomerId: osterbroRecord.id, memberPropertyIds: parkvejRecord.id, memberRole: "member" }, { now: 1 })
    assert.equal(made.status, "Active")
    const body = propertyGroupAdapter.toCreateBody?.(made, context)
    assert.ok(PropertyGroupCreate.safeParse(body).success, JSON.stringify(body))
    assert.deepEqual((body as { members: unknown }).members, [{ propertyId: parkvej.id, role: "member" }])
  })
})

describe("the shared collection point form on the Pilot", () => {
  test("offers the place always located, its access and billing, its initial state and its members", () => {
    assert.deepEqual(fieldIdsOf(SHARED_POINT_FORM), ["projectId", "name", "pointType", "status", "address", "latitude", "longitude", "eligibilityDistance", "operatingModel", "availability", "accessMode", "accessConditions", "billingMode", "responsibleCustomerId", "memberPropertyIds", "memberRole"])
    assert.deepEqual(requiredOf(SHARED_POINT_FORM), ["projectId", "name", "pointType", "status", "address", "latitude", "longitude", "operatingModel", "accessMode", "billingMode"])
    assert.equal(fieldOf(SHARED_POINT_FORM, "memberRole")?.defaultValue, "service-member")
    assert.ok(!fieldIdsOf(SHARED_POINT_EDIT_FORM).includes("status"))
    assert.equal(fieldOf(SHARED_POINT_EDIT_FORM, "projectId")?.readOnly, true)
  })

  test("what it makes is a create body the contract accepts", () => {
    const made = createSharedPointRecord(
      { projectId: projectRecord.id, name: "Kongens Nytorv", pointType: "underground", status: "draft", address: "Kongens Nytorv, 1050 København K", latitude: "55.6805", longitude: "12.5855", eligibilityDistance: "350", operatingModel: "municipal", availability: "24/7", accessMode: "open", accessConditions: "", billingMode: "municipal", responsibleCustomerId: "", memberPropertyIds: parkvejRecord.id, memberRole: "service-member" },
      { now: 1 },
    )
    assert.equal(made.status, "Draft")
    const body = sharedPointAdapter.toCreateBody?.(made, context)
    assert.ok(SharedCollectionPointCreate.safeParse(body).success, JSON.stringify(body))
  })
})
