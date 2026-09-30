// Properties, property groups and shared collection points on the adapter
// (#184, slice 9b of #81): the Registry's three places-and-sets become the
// records of `customers.properties`, `customers.groups` and `customers.shared`
// — a property naming its parties through the switched contacts module, a
// group and a point naming their member properties through the properties
// loaded just before them; the records the workspace writes become the bodies
// the API's contracts accept, held here against the contracts' own zod
// schemas, each set replaced whole through its one `PUT`; and the writes go
// out through the store's seam over a scripted `fetch`, the API's refusals
// coming back as its sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Subscription } from "@waste/contracts/agreements"
import {
  PropertyCreate,
  PropertyGroupCreate,
  PropertyGroupMembersSet,
  PropertyGroupPatch,
  PropertyPartiesSet,
  PropertyPatch,
  SharedCollectionPointCreate,
  SharedCollectionPointMembersSet,
  SharedCollectionPointPatch,
  type Customer,
  type Property,
  type PropertyGroup,
  type SharedCollectionPoint,
} from "@waste/contracts/customers"
import type { Project } from "@waste/contracts/organisation"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { createPropertyGroupRecord, createPropertyRecord, createSharedPointRecord, PROPERTIES_MODULE, PROPERTY_GROUPS_MODULE, SHARED_POINTS_MODULE } from "../../data/properties"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { subscriptionAdapter } from "../records/agreements"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { propertiesModule, propertyAdapter, propertyGroupAdapter, propertyGroupsModule, sharedPointAdapter, sharedPointsModule } from "../records/properties"
import { customerAdapter } from "../records/registry"
import { loaded, loadModule, resolverOver, spellsStatus, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixturesOf = (workspaceId: "customers" | "configure", moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const propertyFixtures = fixturesOf("customers", PROPERTIES_MODULE.moduleId)

// The seeded rows as the API answers them (packages/db/src/seed/registry.ts), in the seed's id scheme.
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const HARBOR = "01a0d2a4-a280-7002-8000-000000000002"
const mikkel: Customer = { id: "01a0d2a4-a280-700b-8000-000000000001", ...STAMPS, kind: "person", name: "Mikkel Sørensen", registrationNumber: null, email: "mikkel.sorensen@example.dk", phone: null, billingAddress: null, serviceMessagesAllowed: true, status: "active" }
const osterbro: Customer = { ...mikkel, id: "01a0d2a4-a280-700b-8000-000000000002", kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null }
const kab: Customer = { ...osterbro, id: "01a0d2a4-a280-700b-8000-000000000004", name: "KAB Bolig", registrationNumber: null, status: "inactive" }
/** A customer the store has not loaded: named by its id chip. */
const HARBOR_PROPERTIES = "01a0d2a4-a280-700b-8000-000000000009"

const parkvej: Property = {
  id: "01a0d2a4-a280-700c-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  name: "Parkvej 18",
  address: "Parkvej 18, 2100 København Ø",
  registryId: "CPH-001882",
  kind: "residential",
  location: { type: "Point", coordinates: [12.5709, 55.7012] },
  notes: "Locked yard access.",
  status: "active",
  parties: [
    { customerId: osterbro.id, role: "owner" },
    { customerId: osterbro.id, role: "payer" },
    { customerId: mikkel.id, role: "service-contact" },
  ],
}
const dock4: Property = {
  ...parkvej,
  id: "01a0d2a4-a280-700c-8000-000000000002",
  projectId: HARBOR,
  name: "Dock 4 · Harbor Offices",
  address: "Dock 4, Nordhavn",
  registryId: null,
  kind: "commercial",
  location: null,
  notes: null,
  status: "inactive",
  parties: [
    { customerId: HARBOR_PROPERTIES, role: "owner" },
    { customerId: kab.id, role: "tenant" },
  ],
}
const ryesgade: Property = { ...parkvej, id: "01a0d2a4-a280-700c-8000-000000000004", name: "Ryesgade 3", address: "Ryesgade 3, 2200 København N", registryId: "CPH-91000", location: null, notes: null, parties: [] }
const jagtvej: Property = { ...ryesgade, id: "01a0d2a4-a280-700c-8000-000000000006", name: "Jagtvej 17", address: "Jagtvej 17, 2200 København N", registryId: "CPH-91002" }

const osterbroEast: PropertyGroup = {
  id: "01a0d2a4-a280-700e-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  name: "Østerbro East Portfolio",
  purpose: "administration",
  responsibleCustomerId: osterbro.id,
  status: "active",
  members: [
    { propertyId: parkvej.id, role: "member" },
    { propertyId: ryesgade.id, role: "administrator" },
  ],
}
const kongens: SharedCollectionPoint = {
  id: "01a0d2a4-a280-7010-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  name: "Kongens Nytorv Shared Point",
  kind: "underground",
  address: "Kongens Nytorv, 1050 København K",
  location: { type: "Point", coordinates: [12.5855, 55.6805] },
  eligibilityDistanceM: 350,
  operatingModel: "municipal",
  accessMode: "open",
  accessConditions: null,
  availability: "24/7",
  billingMode: "municipal",
  responsibleCustomerId: null,
  status: "open",
  members: [],
}

// The organisation and the customers as the store has them when the properties load.
const copenhagenRecord = projectAdapter.toRecord(copenhagen, { fixtures: fixturesOf("configure", "organization"), resolve: NOTHING_RESOLVED, now: NOW })
const customers = [mikkel, osterbro, kab]
const customerRecords = customers.map((customer) => customerAdapter.toRecord(customer, { fixtures: fixturesOf("customers", "contacts"), resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW }))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [copenhagenRecord], serverIds: new Map([[copenhagenRecord.id, copenhagen.id]]) }, 1)],
  ["customers.contacts", loaded({ records: customerRecords, serverIds: new Map(customerRecords.map((record, index) => [record.id, customers[index].id])) }, 1)],
])
const context = (resolver: Resolver = resolverOver(state), fixtures: readonly BusinessRecord[] = []): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

/** The properties module as the store holds it once loaded, for the groups, the points and the subscriptions that name its rows. */
function withProperties(properties: readonly Property[], base: ServerRecordsState = state): ServerRecordsState {
  const records = properties.map((property) => propertyAdapter.toRecord(property, context(resolverOver(base))))
  return new Map([...base, ["customers.properties", loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, properties[index].id])) }, 1)]])
}
const withAll = withProperties([parkvej, ryesgade, jagtvej])
const contextAll = () => context(resolverOver(withAll))

const pageOf = (items: unknown[]) => json({ items, nextCursor: null })
const MINTED = 1_700_000_000_000

const PROPERTY_VALUES: Record<string, string> = {
  projectId: FIXTURE_PROJECT_IDS.copenhagen,
  displayName: "Nørrebrogade 144",
  serviceAddress: "Nørrebrogade 144, 2200 København N",
  registryId: "",
  propertyType: "commercial",
  latitude: "55.6961",
  longitude: "12.546",
  specialConditions: "",
  ownerIds: "company-osterbro-housing",
  payerIds: "company-osterbro-housing, contact-mikkel",
  tenantIds: "",
  administratorIds: "",
  serviceContactIds: "contact-mikkel",
}

describe("the three modules", () => {
  test("are switched after the organisation and the customers they name, and before the agreements and the containers that name them", () => {
    const at = (key: string) => SERVER_MODULE_KEYS.indexOf(key)
    for (const { workspaceId, moduleId } of [PROPERTIES_MODULE, PROPERTY_GROUPS_MODULE, SHARED_POINTS_MODULE]) {
      const key = `${workspaceId}.${moduleId}`
      assert.ok(isServerBacked(workspaceId, moduleId), key)
      assert.ok(at(key) > at("configure.organization"), `${key} after the organisation`)
      assert.ok(at(key) > at("customers.contacts"), `${key} after the customers`)
      assert.ok(at(key) < at("customers.agreements"), `${key} before the subscriptions that name its rows`)
      assert.ok(at(key) < at("resources.containers"), `${key} before the containers placed there`)
    }
    assert.ok(at("customers.groups") > at("customers.properties"), "a group after the properties it gathers")
    assert.ok(at("customers.shared") > at("customers.properties"), "a point after the properties it serves")
    assert.deepEqual(propertiesModule.resources, [propertyAdapter])
    assert.deepEqual(propertyGroupsModule.resources, [propertyGroupAdapter])
    assert.deepEqual(sharedPointsModule.resources, [sharedPointAdapter])
  })

  test("a subscription loaded after them names its property by the row the store holds", () => {
    const sub: Subscription = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, agreementId: "01a0d2a4-a280-7012-8000-000000000001", productId: "01a0d2a4-a280-700a-8000-000000000001", propertyId: parkvej.id, sharedCollectionPointId: null, quantity: 1, validFrom: "2026-01-01", validTo: null }
    const record = subscriptionAdapter.toRecord(sub, contextAll())
    assert.equal(record.facts.Property, "Parkvej 18")
    assert.equal(record.submittedValues?.propertyId, `property-${parkvej.id}`)
  })
})

describe("a property", () => {
  test("loads from one list as `property-<uuid>`: no fixture lends its id, not even the one of its name and address", async () => {
    const { fetch, calls } = scripted([() => pageOf([parkvej, dock4])])
    const result = await loadModule(clientOver(fetch), propertiesModule, { fixtures: propertyFixtures, state, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/properties?limit=200"])
    assert.deepEqual(result.records.map((record) => record.id), [`property-${parkvej.id}`, `property-${dock4.id}`])
    assert.equal(result.serverIds.get(`property-${parkvej.id}`), parkvej.id)
    assert.ok(propertyFixtures.some((record) => record.name === "Parkvej 18"), "the fixture of the same name is there to lend, and does not")
  })

  test("is the wire's fields, its parties by role through the switched contacts module, scoped to its project", () => {
    const record = propertyAdapter.toRecord(parkvej, context(resolverOver(state), propertyFixtures))
    assert.equal(record.id, `property-${parkvej.id}`)
    assert.equal(record.name, "Parkvej 18")
    assert.equal(record.context, "Østerbro Housing · Payer Østerbro Housing")
    assert.equal(record.status, "Active")
    assert.equal(record.owner, "", "nothing of the fixture is inherited")
    assert.equal(record.description, "Locked yard access.")
    assert.equal(record.recordKind, "Property")
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.updated, "5 days ago")
    assert.deepEqual(record.facts, {
      "Property type": "Residential",
      Address: "Parkvej 18, 2100 København Ø",
      "Registry identifier": "CPH-001882",
      Coordinates: "55.7012, 12.5709",
      Project: "Copenhagen Central",
      Owners: "Østerbro Housing",
      Payers: "Østerbro Housing",
      "Service contacts": "Mikkel Sørensen",
    })
    assert.deepEqual(record.related, ["Østerbro Housing", "Mikkel Sørensen"])
    assert.deepEqual(record.allowedTransitions, ["Inactive"])
    assert.deepEqual(record.submittedValues, {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      displayName: "Parkvej 18",
      serviceAddress: "Parkvej 18, 2100 København Ø",
      registryId: "CPH-001882",
      propertyType: "residential",
      latitude: "55.7012",
      longitude: "12.5709",
      specialConditions: "Locked yard access.",
      ownerIds: "company-osterbro-housing",
      payerIds: "company-osterbro-housing",
      tenantIds: "",
      administratorIds: "",
      serviceContactIds: "contact-mikkel",
    })
    assert.ok(propertyAdapter.owns(record))
  })

  test("an unlocated, inactive property of a project not loaded names a customer the store lacks by its id chip", () => {
    const record = propertyAdapter.toRecord(dock4, context())
    assert.equal(record.status, "Inactive")
    assert.deepEqual(record.allowedTransitions, ["Active"])
    assert.equal(record.context, `customer-${HARBOR_PROPERTIES} · No payer`)
    assert.deepEqual(record.projectIds, [`project-${HARBOR}`])
    assert.equal(record.facts.Coordinates, undefined)
    assert.equal(record.facts.Project, undefined, "a project the store has not loaded is named by nothing but its id")
    assert.equal(record.facts.Owners, `customer-${HARBOR_PROPERTIES}`)
    assert.equal(record.facts.Tenants, "KAB Bolig")
    assert.equal(record.submittedValues?.ownerIds, `customer-${HARBOR_PROPERTIES}`)
    assert.equal(record.submittedValues?.tenantIds, `company-${kab.id}`)
    assert.equal(record.submittedValues?.latitude, "")
    assert.equal(record.submittedValues?.longitude, "")
  })

  test("says exactly the wire's two statuses, so the store refuses the lifecycle's Prospect, On hold and Archived before the API", () => {
    assert.deepEqual(propertyAdapter.statuses, ["active", "inactive"])
    const record = propertyAdapter.toRecord(parkvej, context())
    assert.ok(spellsStatus(propertiesModule, record, "Inactive"))
    assert.ok(spellsStatus(propertiesModule, record, "Active"))
    assert.ok(!spellsStatus(propertiesModule, record, "Prospect"))
    assert.ok(!spellsStatus(propertiesModule, record, "On hold"))
    assert.ok(!spellsStatus(propertiesModule, record, "Archived"))
  })

  test("the form's record becomes a PropertyCreate the contract accepts: the project and the parties by server id, the point from the two numbers", () => {
    const made = createPropertyRecord(PROPERTY_VALUES, { now: MINTED })
    assert.ok(propertyAdapter.owns(made))
    const body = propertyAdapter.toCreateBody?.(made, context())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      name: "Nørrebrogade 144",
      address: "Nørrebrogade 144, 2200 København N",
      kind: "commercial",
      location: { type: "Point", coordinates: [12.546, 55.6961] },
      status: "active",
      parties: [
        { customerId: osterbro.id, role: "owner" },
        { customerId: osterbro.id, role: "payer" },
        { customerId: mikkel.id, role: "payer" },
        { customerId: mikkel.id, role: "service-contact" },
      ],
    })
    const parsed = PropertyCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
    const bare = propertyAdapter.toCreateBody?.(createPropertyRecord({ ...PROPERTY_VALUES, latitude: "", longitude: "", registryId: "CPH-7", specialConditions: "Gate code 4411", ownerIds: `customer-${HARBOR_PROPERTIES}`, payerIds: "", serviceContactIds: "" }, { now: MINTED }), context()) as Record<string, unknown>
    assert.equal(bare.location, undefined, "no point is no location: the API's null until geocoded")
    assert.equal(bare.registryId, "CPH-7")
    assert.equal(bare.notes, "Gate code 4411")
    assert.deepEqual(bare.parties, [{ customerId: HARBOR_PROPERTIES, role: "owner" }], "a customer's id chip names the customer")
    assert.ok(PropertyCreate.safeParse(bare).success)
  })

  test("is refused here, naming the field, for no project, no name, no address, a kind the wire lacks, half a point or a party that is no customer the API holds", () => {
    const made = (values: Record<string, string>) => propertyAdapter.toCreateBody?.(createPropertyRecord({ ...PROPERTY_VALUES, ...values }, { now: MINTED }), context())
    assert.deepEqual(made({ projectId: "project-nowhere" }), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(made({ displayName: " " }), { path: "displayName", message: "A property needs a name" })
    assert.deepEqual(made({ serviceAddress: "" }), { path: "serviceAddress", message: "A property needs an address" })
    assert.deepEqual(made({ propertyType: "" }), { path: "propertyType", message: "A property needs a property type" })
    assert.deepEqual(made({ propertyType: "castle" }), { path: "propertyType", message: 'The API has no kind "castle" for a property; it knows residential, commercial, public, mixed, other' })
    assert.deepEqual(made({ latitude: "" }), { path: "latitude", message: "Give both the latitude and the longitude, or neither" })
    assert.deepEqual(made({ longitude: "east" }), { path: "longitude", message: "A coordinate is a number" })
    assert.deepEqual(made({ ownerIds: "company-nowhere" }), { path: "ownerIds", message: "Pick customers the API holds" })
    assert.deepEqual(made({ tenantIds: FIXTURE_PROJECT_IDS.copenhagen }), { path: "tenantIds", message: "Pick customers the API holds" }, "a row the store holds that is no customer is refused as one")
  })

  test("a patch says what moved of the property — a cleared registry id and notes as null, a point dropped as null, a status — and the parties as one whole set", () => {
    const record = propertyAdapter.toRecord(parkvej, context())
    const edit = (values: Record<string, string>, status = record.status): BusinessRecord => ({ ...record, status, submittedValues: { ...record.submittedValues, ...values } })
    const renamed = propertyAdapter.toPatchBody(record, edit({ displayName: "Parkvej 18A", registryId: "", specialConditions: "" }), context())
    assert.deepEqual(renamed, { property: { name: "Parkvej 18A", registryId: null, notes: null } })
    assert.ok(PropertyPatch.safeParse((renamed as { property: unknown }).property).success)
    assert.deepEqual(propertyAdapter.toPatchBody(record, edit({ latitude: "", longitude: "" }), context()), { property: { location: null } })
    assert.deepEqual(propertyAdapter.toPatchBody(record, edit({}, "Inactive"), context()), { property: { status: "inactive" } })
    const tenanted = propertyAdapter.toPatchBody(record, edit({ tenantIds: `company-${kab.id}` }), context())
    assert.deepEqual(tenanted, {
      parties: [
        { customerId: osterbro.id, role: "owner" },
        { customerId: osterbro.id, role: "payer" },
        { customerId: kab.id, role: "tenant" },
        { customerId: mikkel.id, role: "service-contact" },
      ],
    })
    assert.ok(PropertyPartiesSet.safeParse(tenanted).success)
    assert.deepEqual(propertyAdapter.toPatchBody(record, edit({ ownerIds: "", payerIds: "", serviceContactIds: "" }), context()), { parties: [] }, "an empty set is a property nobody is billed for")
    const both = propertyAdapter.toPatchBody(record, edit({ propertyType: "mixed", serviceContactIds: "" }), context())
    assert.deepEqual(both, { property: { kind: "mixed" }, parties: [{ customerId: osterbro.id, role: "owner" }, { customerId: osterbro.id, role: "payer" }] })
    assert.equal(propertyAdapter.toPatchBody(record, edit({}), context()), null)
  })

  test("a patch is refused for a project moved, half a point or a party the API does not hold", () => {
    const record = propertyAdapter.toRecord(parkvej, context())
    const edit = (values: Record<string, string>): BusinessRecord => ({ ...record, submittedValues: { ...record.submittedValues, ...values } })
    assert.deepEqual(propertyAdapter.toPatchBody(record, edit({ projectId: "project-harbor" }), context()), { path: "projectId", message: "A property stays in its project" })
    assert.deepEqual(propertyAdapter.toPatchBody(record, edit({ longitude: "" }), context()), { path: "longitude", message: "Give both the latitude and the longitude, or neither" })
    assert.deepEqual(propertyAdapter.toPatchBody(record, edit({ payerIds: "company-nowhere" }), context()), { path: "payerIds", message: "Pick customers the API holds" })
  })

  test("the update patches the property, then replaces its parties through their own route, and answers the property as the last request left it", async () => {
    const renamed = { ...parkvej, name: "Parkvej 18A" }
    const partied = { ...renamed, parties: [] }
    const { fetch, calls } = scripted([() => json(renamed), () => json(partied)])
    const answer = await propertyAdapter.update(clientOver(fetch), parkvej.id, { property: { name: "Parkvej 18A" }, parties: [] })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/properties/${parkvej.id}`, `PUT http://api.test/properties/${parkvej.id}/parties`])
    assert.deepEqual(bodyOf(calls[0]), { name: "Parkvej 18A" })
    assert.deepEqual(bodyOf(calls[1]), { parties: [] })
    assert.deepEqual(answer, partied)
    const setOnly = scripted([() => json(partied)])
    await propertyAdapter.update(clientOver(setOnly.fetch), parkvej.id, { parties: [] })
    assert.deepEqual(setOnly.calls.map((call) => `${call.init.method} ${call.url}`), [`PUT http://api.test/properties/${parkvej.id}/parties`])
  })

  test("through the store's write, a create posts with its parties and the API's 409 for a name taken comes back as its sentence", async () => {
    const made = createPropertyRecord(PROPERTY_VALUES, { now: MINTED })
    const created: Property = { ...parkvej, id: "019995e0-0000-7000-8000-0000000000c1", name: "Nørrebrogade 144", address: "Nørrebrogade 144, 2200 København N" }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/properties/${created.id}` })])
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(clientOver(fetch), propertiesModule, current, made, { fixtures: propertyFixtures, state, now: NOW })
    assert.equal(calls[0].init.method, "POST")
    assert.equal(calls[0].url, "http://api.test/properties")
    assert.ok(PropertyCreate.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.serverId, created.id)
    assert.equal(outcome.record.name, "Nørrebrogade 144")

    const refused = scripted([() => problem(409, 'This project already has a property called "Nørrebrogade 144"')])
    const answer = await writeRecord(clientOver(refused.fetch), propertiesModule, current, made, { fixtures: propertyFixtures, state, now: NOW })
    assert.equal(answer.kind, "refused")
    if (answer.kind !== "refused") return
    assert.equal(problemSentence(answer.problem), 'This project already has a property called "Nørrebrogade 144"')
  })
})

describe("a property group", () => {
  test("loads from one list as `group-<uuid>`, its members through the properties loaded before it, each with the role it holds", async () => {
    const { fetch, calls } = scripted([() => pageOf([osterbroEast])])
    const result = await loadModule(clientOver(fetch), propertyGroupsModule, { fixtures: fixturesOf("customers", "groups"), state: withAll, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/property-groups?limit=200"])
    assert.deepEqual(result.records.map((record) => record.id), [`group-${osterbroEast.id}`])
    const record = result.records[0]
    assert.equal(record.name, "Østerbro East Portfolio")
    assert.equal(record.context, "Administration · Østerbro Housing")
    assert.equal(record.status, "Active")
    assert.equal(record.value, "2 properties")
    assert.equal(record.recordKind, "Property Group")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.deepEqual(record.facts, {
      Purpose: "Administration",
      "Responsible customer": "Østerbro Housing",
      Project: "Copenhagen Central",
      Members: "Parkvej 18",
      Administrators: "Ryesgade 3",
    })
    assert.deepEqual(record.related, ["Parkvej 18", "Ryesgade 3"])
    assert.deepEqual(record.allowedTransitions, ["Draft", "Inactive"])
    assert.deepEqual(record.submittedValues, {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      name: "Østerbro East Portfolio",
      purpose: "administration",
      responsibleCustomerId: "company-osterbro-housing",
      memberPropertyIds: `property-${parkvej.id},property-${ryesgade.id}`,
      memberRole: "member",
      memberRoles: JSON.stringify({ [`property-${parkvej.id}`]: "member", [`property-${ryesgade.id}`]: "administrator" }),
    })
    assert.ok(propertyGroupAdapter.owns(record))
  })

  test("says exactly the wire's three statuses", () => {
    assert.deepEqual(propertyGroupAdapter.statuses, ["draft", "active", "inactive"])
    const record = propertyGroupAdapter.toRecord(osterbroEast, contextAll())
    assert.ok(spellsStatus(propertyGroupsModule, record, "Inactive"))
    assert.ok(!spellsStatus(propertyGroupsModule, record, "Archived"))
  })

  test("the form's record becomes a PropertyGroupCreate the contract accepts: the members by server id in the role new members join as", () => {
    const values = { projectId: FIXTURE_PROJECT_IDS.copenhagen, name: "Valby Organic Service Group", purpose: "service", status: "draft", responsibleCustomerId: "", memberPropertyIds: `property-${parkvej.id}, property-${ryesgade.id}`, memberRole: "reporting" }
    const made = createPropertyGroupRecord(values, { now: MINTED })
    assert.ok(propertyGroupAdapter.owns(made))
    const body = propertyGroupAdapter.toCreateBody?.(made, contextAll())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      name: "Valby Organic Service Group",
      purpose: "service",
      status: "draft",
      members: [
        { propertyId: parkvej.id, role: "reporting" },
        { propertyId: ryesgade.id, role: "reporting" },
      ],
    })
    assert.ok(PropertyGroupCreate.safeParse(body).success)
    const answered = propertyGroupAdapter.toCreateBody?.(createPropertyGroupRecord({ ...values, responsibleCustomerId: "company-osterbro-housing", memberPropertyIds: "", memberRole: "" }, { now: MINTED }), contextAll()) as Record<string, unknown>
    assert.equal(answered.responsibleCustomerId, osterbro.id)
    assert.deepEqual(answered.members, [])
    assert.ok(PropertyGroupCreate.safeParse(answered).success)
  })

  test("is refused here, naming the field, for no name or purpose, a purpose or a role the wire lacks, a customer or a property the API does not hold", () => {
    const values = { projectId: FIXTURE_PROJECT_IDS.copenhagen, name: "Group", purpose: "service", status: "draft", responsibleCustomerId: "", memberPropertyIds: "", memberRole: "member" }
    const made = (over: Record<string, string>) => propertyGroupAdapter.toCreateBody?.(createPropertyGroupRecord({ ...values, ...over }, { now: MINTED }), contextAll())
    assert.deepEqual(made({ name: "" }), { path: "name", message: "A property group needs a name" })
    assert.deepEqual(made({ purpose: "" }), { path: "purpose", message: "A property group needs a purpose" })
    assert.deepEqual(made({ purpose: "fun" }), { path: "purpose", message: 'The API has no purpose "fun" for a property group; it knows administration, reporting, service, agreement' })
    assert.deepEqual(made({ status: "archived" }), { path: "status", message: 'The API has no status "archived" for a property group; it knows draft, active, inactive' })
    assert.deepEqual(made({ responsibleCustomerId: "company-nowhere" }), { path: "responsibleCustomerId", message: "Pick a customer the API holds" })
    assert.deepEqual(made({ memberPropertyIds: "property-parkvej-18" }), { path: "memberPropertyIds", message: "Pick properties the API holds" }, "a fixture's id names no row of the API")
    assert.deepEqual(made({ memberPropertyIds: `property-${parkvej.id}`, memberRole: "boss" }), { path: "memberRole", message: 'The API has no role "boss" for a group member; it knows member, administrator, payer, reporting' })
  })

  test("a patch says what moved of the group, and the members as one whole set in which a member already there keeps its role", () => {
    const record = propertyGroupAdapter.toRecord(osterbroEast, contextAll())
    const edit = (values: Record<string, string>, status = record.status): BusinessRecord => ({ ...record, status, submittedValues: { ...record.submittedValues, ...values } })
    const renamed = propertyGroupAdapter.toPatchBody(record, edit({ name: "Østerbro East", responsibleCustomerId: "" }), contextAll())
    assert.deepEqual(renamed, { group: { name: "Østerbro East", responsibleCustomerId: null } })
    assert.ok(PropertyGroupPatch.safeParse((renamed as { group: unknown }).group).success)
    assert.deepEqual(propertyGroupAdapter.toPatchBody(record, edit({}, "Inactive"), contextAll()), { group: { status: "inactive" } })
    const regathered = propertyGroupAdapter.toPatchBody(record, edit({ memberPropertyIds: `property-${ryesgade.id},property-${jagtvej.id}`, memberRole: "payer" }), contextAll())
    assert.deepEqual(regathered, { members: [{ propertyId: ryesgade.id, role: "administrator" }, { propertyId: jagtvej.id, role: "payer" }] })
    assert.ok(PropertyGroupMembersSet.safeParse(regathered).success)
    assert.equal(propertyGroupAdapter.toPatchBody(record, edit({ memberRole: "reporting" }), contextAll()), null, "the role for new members moves nobody already there")
    assert.equal(propertyGroupAdapter.toPatchBody(record, edit({ memberPropertyIds: `property-${ryesgade.id}, property-${parkvej.id}` }), contextAll()), null, "the order the members were ticked in is not a change")
    assert.deepEqual(propertyGroupAdapter.toPatchBody(record, edit({ projectId: "project-harbor" }), contextAll()), { path: "projectId", message: "A property group stays in its project" })
    assert.deepEqual(propertyGroupAdapter.toPatchBody(record, edit({ memberPropertyIds: "property-nowhere" }), contextAll()), { path: "memberPropertyIds", message: "Pick properties the API holds" })
  })

  test("the update patches the group, then replaces its members through their own route", async () => {
    const { fetch, calls } = scripted([() => json({ ...osterbroEast, name: "Østerbro East" }), () => json({ ...osterbroEast, name: "Østerbro East", members: [] })])
    const answer = await propertyGroupAdapter.update(clientOver(fetch), osterbroEast.id, { group: { name: "Østerbro East" }, members: [] })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/property-groups/${osterbroEast.id}`, `PUT http://api.test/property-groups/${osterbroEast.id}/members`])
    assert.deepEqual(bodyOf(calls[1]), { members: [] })
    assert.deepEqual(answer.members, [])
  })
})

describe("a shared collection point", () => {
  test("loads from one list as `shared-point-<uuid>`, located always, its access, billing and eligibility as facts", async () => {
    const { fetch, calls } = scripted([() => pageOf([kongens])])
    const result = await loadModule(clientOver(fetch), sharedPointsModule, { fixtures: fixturesOf("customers", "shared"), state: withAll, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/shared-collection-points?limit=200"])
    assert.deepEqual(result.records.map((record) => record.id), [`shared-point-${kongens.id}`])
    const record = result.records[0]
    assert.equal(record.name, "Kongens Nytorv Shared Point")
    assert.equal(record.context, "Municipal shared service · Open access")
    assert.equal(record.status, "Open")
    assert.equal(record.value, "No members")
    assert.equal(record.recordKind, "Shared Collection Point")
    assert.deepEqual(record.facts, {
      Type: "Underground system",
      Address: "Kongens Nytorv, 1050 København K",
      Coordinates: "55.6805, 12.5855",
      "Operating model": "Municipal shared service",
      Access: "Open access",
      Availability: "24/7",
      Billing: "Project or municipality",
      Eligibility: "Within 350 m",
      Project: "Copenhagen Central",
    })
    assert.deepEqual(record.allowedTransitions, ["Draft", "Restricted", "Closed"])
    assert.deepEqual(record.submittedValues, {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      name: "Kongens Nytorv Shared Point",
      pointType: "underground",
      address: "Kongens Nytorv, 1050 København K",
      latitude: "55.6805",
      longitude: "12.5855",
      eligibilityDistance: "350",
      operatingModel: "municipal",
      availability: "24/7",
      accessMode: "open",
      accessConditions: "",
      billingMode: "municipal",
      responsibleCustomerId: "",
      memberPropertyIds: "",
      memberRole: "service-member",
      memberRoles: "{}",
    })
    assert.ok(sharedPointAdapter.owns(record))
  })

  test("says exactly the wire's four statuses, so a point is closed and drafted again by the lifecycle", () => {
    assert.deepEqual(sharedPointAdapter.statuses, ["draft", "open", "restricted", "closed"])
    const record = sharedPointAdapter.toRecord(kongens, contextAll())
    assert.ok(spellsStatus(sharedPointsModule, record, "Closed"))
    assert.ok(spellsStatus(sharedPointsModule, record, "Draft"))
    assert.ok(!spellsStatus(sharedPointsModule, record, "Billing issue"))
  })

  test("the form's record becomes a SharedCollectionPointCreate the contract accepts", () => {
    const values = {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      name: "Nordhavn Dock Shared Cardboard",
      pointType: "surface",
      address: "Sandkaj, 2150 Nordhavn",
      latitude: "55.7085",
      longitude: "12.5965",
      eligibilityDistance: "",
      operatingModel: "member-funded",
      availability: "Business hours",
      accessMode: "member",
      accessConditions: "Invited members",
      billingMode: "member-share",
      responsibleCustomerId: "company-osterbro-housing",
      status: "draft",
      memberPropertyIds: `property-${parkvej.id}`,
      memberRole: "service-member",
    }
    const made = createSharedPointRecord(values, { now: MINTED })
    assert.ok(sharedPointAdapter.owns(made))
    const body = sharedPointAdapter.toCreateBody?.(made, contextAll())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      name: "Nordhavn Dock Shared Cardboard",
      kind: "surface",
      address: "Sandkaj, 2150 Nordhavn",
      location: { type: "Point", coordinates: [12.5965, 55.7085] },
      operatingModel: "member-funded",
      accessMode: "member",
      accessConditions: "Invited members",
      availability: "Business hours",
      billingMode: "member-share",
      responsibleCustomerId: osterbro.id,
      status: "draft",
      members: [{ propertyId: parkvej.id, role: "service-member" }],
    })
    assert.ok(SharedCollectionPointCreate.safeParse(body).success)
    const far = sharedPointAdapter.toCreateBody?.(createSharedPointRecord({ ...values, eligibilityDistance: "350", accessConditions: "", availability: "", responsibleCustomerId: "", memberPropertyIds: "" }, { now: MINTED }), contextAll()) as Record<string, unknown>
    assert.equal(far.eligibilityDistanceM, 350)
    assert.equal(far.accessConditions, undefined)
    assert.equal(far.availability, undefined)
    assert.equal(far.responsibleCustomerId, undefined)
    assert.ok(SharedCollectionPointCreate.safeParse(far).success)
  })

  test("is refused here, naming the field, without its location, a model, an access mode or a billing mode, or with a distance that is no count of metres", () => {
    const values = { projectId: FIXTURE_PROJECT_IDS.copenhagen, name: "Point", pointType: "surface", address: "Sandkaj, 2150 Nordhavn", latitude: "55.7085", longitude: "12.5965", eligibilityDistance: "", operatingModel: "municipal", availability: "", accessMode: "open", accessConditions: "", billingMode: "municipal", responsibleCustomerId: "", status: "draft", memberPropertyIds: "", memberRole: "service-member" }
    const made = (over: Record<string, string>) => sharedPointAdapter.toCreateBody?.(createSharedPointRecord({ ...values, ...over }, { now: MINTED }), contextAll())
    assert.deepEqual(made({ latitude: "", longitude: "" }), { path: "latitude", message: "A shared collection point has a location: give the latitude and longitude" })
    assert.deepEqual(made({ address: "" }), { path: "address", message: "A shared collection point needs an address" })
    assert.deepEqual(made({ pointType: "" }), { path: "pointType", message: "A shared collection point needs a collection-point type" })
    assert.deepEqual(made({ operatingModel: "" }), { path: "operatingModel", message: "A shared collection point needs an operating model" })
    assert.deepEqual(made({ accessMode: "" }), { path: "accessMode", message: "A shared collection point needs an access mode" })
    assert.deepEqual(made({ billingMode: "" }), { path: "billingMode", message: "A shared collection point needs a billing mode" })
    assert.deepEqual(made({ eligibilityDistance: "0" }), { path: "eligibilityDistance", message: "An eligibility distance is a whole number of metres, 1 or more" })
    assert.deepEqual(made({ eligibilityDistance: "12.5" }), { path: "eligibilityDistance", message: "An eligibility distance is a whole number of metres, 1 or more" })
  })

  test("a patch says what moved of the point and the members as one whole set; the point keeps a location", () => {
    const record = sharedPointAdapter.toRecord(kongens, contextAll())
    const edit = (values: Record<string, string>, status = record.status): BusinessRecord => ({ ...record, status, submittedValues: { ...record.submittedValues, ...values } })
    assert.deepEqual(sharedPointAdapter.toPatchBody(record, edit({}, "Closed"), contextAll()), { point: { status: "closed" } })
    const moved = sharedPointAdapter.toPatchBody(record, edit({ eligibilityDistance: "", availability: "", accessConditions: "Key from the caretaker", latitude: "55.681" }), contextAll())
    assert.deepEqual(moved, { point: { location: { type: "Point", coordinates: [12.5855, 55.681] }, eligibilityDistanceM: null, accessConditions: "Key from the caretaker", availability: null } })
    assert.ok(SharedCollectionPointPatch.safeParse((moved as { point: unknown }).point).success)
    const joined = sharedPointAdapter.toPatchBody(record, edit({ memberPropertyIds: `property-${parkvej.id}`, memberRole: "notification-contact" }), contextAll())
    assert.deepEqual(joined, { members: [{ propertyId: parkvej.id, role: "notification-contact" }] })
    assert.ok(SharedCollectionPointMembersSet.safeParse(joined).success)
    assert.deepEqual(sharedPointAdapter.toPatchBody(record, edit({ latitude: "", longitude: "" }), contextAll()), { path: "latitude", message: "A shared collection point keeps a location: give the latitude and longitude" })
    assert.deepEqual(sharedPointAdapter.toPatchBody(record, edit({ projectId: "project-harbor" }), contextAll()), { path: "projectId", message: "A shared collection point stays in its project" })
    assert.equal(sharedPointAdapter.toPatchBody(record, edit({}), contextAll()), null)
  })

  test("the update patches the point, then replaces its members through their own route", async () => {
    const { fetch, calls } = scripted([() => json({ ...kongens, status: "closed" }), () => json({ ...kongens, status: "closed", members: [{ propertyId: parkvej.id, role: "service-member" }] })])
    await sharedPointAdapter.update(clientOver(fetch), kongens.id, { point: { status: "closed" }, members: [{ propertyId: parkvej.id, role: "service-member" }] })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/shared-collection-points/${kongens.id}`, `PUT http://api.test/shared-collection-points/${kongens.id}/members`])
    assert.deepEqual(bodyOf(calls[1]), { members: [{ propertyId: parkvej.id, role: "service-member" }] })
  })
})
