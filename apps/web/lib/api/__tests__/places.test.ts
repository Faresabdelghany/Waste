// The places on the adapter (#180, slice 5a of #81): a depot and an
// unloading station become the records of the prototype's mixed "Depots &
// Unloading" module, a warehouse the Warehouses module's; the records the
// generic forms write become the bodies the API's contracts accept, held
// here against the contracts' own zod schemas; and the writes go out through
// the store's seam over a scripted `fetch`, the API's refusals coming back
// as its sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { WasteFraction } from "@waste/contracts/catalogue"
import type { Project, ServiceProvider } from "@waste/contracts/organisation"
import {
  BOTH_HOURS_OR_NEITHER,
  DepotCreate,
  DepotPatch,
  PROVIDER_WITH_PROVIDER_OWNERSHIP,
  UnloadingStationCreate,
  UnloadingStationFractionsSet,
  UnloadingStationPatch,
  WarehouseCreate,
  WarehousePatch,
  type Depot,
  type UnloadingStation,
  type Warehouse,
} from "@waste/contracts/places"
import { DEPOT_STATUSES, WAREHOUSE_STATUSES } from "@waste/domain/resources/vocabulary"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, FIXTURE_SERVICE_PROVIDER_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter, serviceProviderAdapter } from "../records/organisation"
import {
  BOTH_HOURS_OR_NEITHER as LOCAL_BOTH_HOURS_OR_NEITHER,
  depotAdapter,
  placesModule,
  PROVIDER_WITH_PROVIDER_OWNERSHIP as LOCAL_PROVIDER_WITH_PROVIDER_OWNERSHIP,
  TWO_TIMES_OR_NOTHING,
  unloadingStationAdapter,
  warehouseAdapter,
  warehousesModule,
} from "../records/places"
import { loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixturesOf = (workspaceId: "resources" | "configure" | "service-providers", moduleId: string) => {
  const module = getModuleDefinition({ workspaceId, moduleId })
  if (!module) throw new Error(`no module ${workspaceId}.${moduleId}`)
  return module.records
}
const placeFixtures = fixturesOf("resources", "depots")
const warehouseFixtures = fixturesOf("resources", "warehouses")

// The seeded rows as the API answers them (packages/db/src/seed).
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const harbor: Project = { ...copenhagen, id: "01a0d2a4-a280-7002-8000-000000000002", name: "Harbor Commercial", kind: "Business unit", status: "onboarding", holidayList: null }
const nordren: ServiceProvider = { id: "01a0d2a4-a280-7003-8000-000000000001", ...STAMPS, legalName: "NordRen ApS", registrationNumber: "40291188", country: "DK", contactName: "Lars Mikkelsen", contactEmail: "contact@nordren.example" }
const residual: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, key: "residual", name: "Residual" }
const glass: WasteFraction = { ...residual, id: "01a0d2a4-a280-7005-8000-000000000005", key: "glass", name: "Glass" }
const mixed: WasteFraction = { ...residual, id: "01a0d2a4-a280-7005-8000-000000000008", key: "mixed", name: "Mixed" }

const at = (lng: number, lat: number) => ({ type: "Point" as const, coordinates: [lng, lat] as [number, number] })

const nordhavnDepot: Depot = { id: "01a0d2a4-a280-7010-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "DEPOT-NORDHAVN", name: "Nordhavn Depot", address: "Kaj 14, Nordhavn", location: at(12.5958, 55.7091), ownership: "company", serviceProviderId: null, opensAt: "05:00", closesAt: "22:00", vehicleCapacity: null, status: "active", notes: null }
const arc: UnloadingStation = { id: "01a0d2a4-a280-7012-8000-000000000001", ...STAMPS, code: "STATION-ARC", name: "ARC Amager", address: "Kraftværksvej 31", location: at(12.6186, 55.6903), ownership: "external", serviceProviderId: null, opensAt: null, closesAt: null, weighbridge: true, status: "active", notes: null, wasteFractionIds: [residual.id, mixed.id] }
const west: Warehouse = { id: "01a0d2a4-a280-7011-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "WAREHOUSE-WEST", name: "Warehouse West", address: "Logistikvej 8, Valby", location: null, depotId: null, status: "active", notes: null }
const nordhavnWarehouse: Warehouse = { ...west, id: "01a0d2a4-a280-7011-8000-000000000002", code: "WAREHOUSE-NORDHAVN", name: "Nordhavn Warehouse", address: "Kaj 14, Nordhavn", depotId: nordhavnDepot.id }

// The modules loaded before the places: the organisation, the providers, the master data.
const noResolve = (fixtures: readonly BusinessRecord[]): MappingContext => ({ fixtures, resolve: NOTHING_RESOLVED, now: NOW })
const copenhagenRecord = projectAdapter.toRecord(copenhagen, noResolve(fixturesOf("configure", "organization")))
const harborRecord = projectAdapter.toRecord(harbor, noResolve(fixturesOf("configure", "organization")))
const nordrenRecord = serviceProviderAdapter.toRecord(nordren, noResolve(fixturesOf("service-providers", "service-providers")))
const fractions = [residual, glass, mixed]
const fractionRecords = fractions.map((fraction) => wasteFractionAdapter.toRecord(fraction, noResolve(fixturesOf("configure", "master"))))
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [copenhagenRecord, harborRecord], serverIds: new Map([[copenhagenRecord.id, copenhagen.id], [harborRecord.id, harbor.id]]) }, 1)],
  ["service-providers.service-providers", loaded({ records: [nordrenRecord], serverIds: new Map([[nordrenRecord.id, nordren.id]]) }, 1)],
  ["configure.master", loaded({ records: fractionRecords, serverIds: new Map(fractionRecords.map((record, index) => [record.id, fractions[index].id])) }, 1)],
])
const resolve = resolverOver(state)
const context = (fixtures: readonly BusinessRecord[] = placeFixtures, resolver: Resolver = resolve): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const fractionWebId = (fraction: WasteFraction) => `fraction-${fraction.id}`
const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

/** A record the generic workspace has just made under a module's form: the minted id, the form's kind, the lifecycle's first status. */
const made = (moduleId: string, recordKind: string, status: string, submittedValues: BusinessRecord["submittedValues"], projectIds: string[] = [FIXTURE_PROJECT_IDS.copenhagen]): BusinessRecord => ({
  id: `${moduleId}-${recordKind.toLowerCase().replaceAll(" ", "-")}-1700000000000`,
  name: typeof submittedValues?.name === "string" ? submittedValues.name : "New row",
  context: "",
  status,
  owner: "Olivia Larsen",
  value: "",
  updated: "Now",
  description: "",
  facts: {},
  related: [],
  source: "Office workspace",
  freshness: "Now",
  companyId: FIXTURE_COMPANY_ID,
  projectIds,
  recordKind,
  submittedValues,
})

describe("the places modules", () => {
  test("are switched: the depots and stations after the master data whose fractions a station names, the warehouses after the depots one may share a yard with", () => {
    assert.ok(isServerBacked("resources", "depots"))
    assert.ok(isServerBacked("resources", "warehouses"))
    const at = (key: string) => SERVER_MODULE_KEYS.indexOf(key)
    assert.ok(at("configure.organization") < at("resources.depots"))
    assert.ok(at("configure.master") < at("resources.depots"))
    assert.ok(at("resources.depots") < at("resources.warehouses"))
  })

  test("the depots module lists the depots and the stations together, each under its own prefix", async () => {
    const { fetch, calls } = scripted([() => pageOf([nordhavnDepot]), () => pageOf([arc])])
    const result = await loadModule(clientOver(fetch), placesModule, { fixtures: placeFixtures, state, now: NOW })
    assert.deepEqual(
      calls.map((call) => call.url),
      ["http://api.test/depots?limit=200", "http://api.test/unloading-stations?limit=200"],
    )
    assert.deepEqual(
      result.records.map((record) => record.id),
      [`depot-${nordhavnDepot.id}`, `station-${arc.id}`],
    )
    assert.equal(result.records.length, 2, "no fixture lends its id: the fixture-id mapping retires here")
    assert.equal(result.serverIds.get(`station-${arc.id}`), arc.id)
  })

  test("the sentences quoted here are the contracts' own", () => {
    assert.equal(LOCAL_BOTH_HOURS_OR_NEITHER, BOTH_HOURS_OR_NEITHER)
    assert.equal(LOCAL_PROVIDER_WITH_PROVIDER_OWNERSHIP, PROVIDER_WITH_PROVIDER_OWNERSHIP)
  })
})

describe("a depot", () => {
  const record = depotAdapter.toRecord(nordhavnDepot, context())

  test("is a record in its project with its hours as the fixture spells them, the wire's four statuses, and typed values under the form's own field ids", () => {
    assert.equal(record.id, `depot-${nordhavnDepot.id}`)
    assert.equal(record.name, "Nordhavn Depot")
    assert.equal(record.context, "Depot · Copenhagen Central")
    assert.equal(record.status, "Active")
    assert.equal(record.value, "05:00–22:00")
    assert.equal(record.recordKind, "Operational Location")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.serviceProviderId, undefined)
    assert.equal(record.companyId, FIXTURE_COMPANY_ID)
    assert.equal(record.source, "Waste API")
    assert.deepEqual(record.facts, {
      Kind: "Depot",
      Code: "DEPOT-NORDHAVN",
      Address: "Kaj 14, Nordhavn",
      Coordinates: "55.7091, 12.5958",
      Ownership: "Company",
      Hours: "05:00–22:00",
      Project: "Copenhagen Central",
    })
    assert.deepEqual(record.submittedValues, {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      locationType: "depot",
      name: "Nordhavn Depot",
      code: "DEPOT-NORDHAVN",
      address: "Kaj 14, Nordhavn",
      latitude: "55.7091",
      longitude: "12.5958",
      ownership: "company",
      serviceProviderId: "",
      operatingHours: "05:00–22:00",
      vehicleCapacity: "",
    })
    assert.deepEqual(depotAdapter.statuses, DEPOT_STATUSES)
  })

  test("a provider's depot names it by the web id the store knows it under, and shows in the provider's scope", () => {
    const provided = depotAdapter.toRecord({ ...nordhavnDepot, ownership: "service-provider", serviceProviderId: nordren.id, vehicleCapacity: 12, opensAt: null, closesAt: null }, context())
    assert.equal(provided.serviceProviderId, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.equal(provided.facts.Ownership, "NordRen ApS")
    assert.equal(provided.facts.Hours, undefined)
    assert.equal(provided.facts["Vehicle capacity"], "12")
    assert.equal(provided.value, "")
    assert.equal(provided.submittedValues?.serviceProviderId, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.equal(provided.submittedValues?.vehicleCapacity, "12")
    assert.equal(provided.submittedValues?.operatingHours, "")
  })

  test("the depot adapter owns the depot rows and the new locations the form calls depots; the station adapter the rest", () => {
    assert.ok(depotAdapter.owns(record))
    assert.ok(!unloadingStationAdapter.owns(record))
    const newDepot = made("depots", "Operational Location", "Draft", { locationType: "depot", name: "Valby Depot" })
    const newStation = made("depots", "Operational Location", "Draft", { locationType: "unloading", name: "Paper Recovery" })
    assert.ok(depotAdapter.owns(newDepot))
    assert.ok(!unloadingStationAdapter.owns(newDepot))
    assert.ok(unloadingStationAdapter.owns(newStation))
    assert.ok(!depotAdapter.owns(newStation))
    assert.ok(!depotAdapter.owns({ id: "warehouse-west" } as BusinessRecord))
  })

  test("the record the form writes becomes a DepotCreate the contract accepts: the hours read out of the text, the point from the two numbers, the status the lifecycle's first", () => {
    const valby = made("depots", "Operational Location", "Draft", {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      locationType: "depot",
      name: "Valby Depot",
      code: "DEP-VALBY",
      address: "Gammel Køge Landevej 22, Valby",
      latitude: "55.6612",
      longitude: "12.5031",
      ownership: "company",
      serviceProviderId: "",
      operatingHours: "Mon–Fri 06:00–18:00",
      vehicleCapacity: "8",
      weighbridgeAvailable: false,
      source: "manual",
      effectiveFrom: "2026-10-01",
    })
    const body = depotAdapter.toCreateBody?.(valby, context())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      code: "DEP-VALBY",
      name: "Valby Depot",
      address: "Gammel Køge Landevej 22, Valby",
      location: at(12.5031, 55.6612),
      ownership: "company",
      opensAt: "06:00",
      closesAt: "18:00",
      vehicleCapacity: 8,
      status: "draft",
    })
    const parsed = DepotCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
  })

  test("is refused here, naming the field, for what the API would refuse: no location, one opening time, an ownership a depot cannot have, a provider that does not fit the ownership, a capacity that is no count, a project the store does not hold", () => {
    const valby = (over: Record<string, string>) =>
      made("depots", "Operational Location", "Draft", { projectId: FIXTURE_PROJECT_IDS.copenhagen, locationType: "depot", name: "Valby Depot", code: "DEP-VALBY", address: "Valby", latitude: "55.66", longitude: "12.5", ownership: "company", serviceProviderId: "", operatingHours: "", ...over })
    const body = (over: Record<string, string>) => depotAdapter.toCreateBody?.(valby(over), context())
    assert.deepEqual(body({ latitude: "", longitude: "" }), { path: "latitude", message: "A depot has a location: give the latitude and longitude" })
    assert.deepEqual(body({ longitude: "" }), { path: "longitude", message: "A depot has a location: give the latitude and longitude" })
    assert.deepEqual(body({ operatingHours: "Opens 06:00" }), { path: "operatingHours", message: BOTH_HOURS_OR_NEITHER })
    // A text the adapter cannot read as two times neither cuts nor clears what is on record.
    assert.deepEqual(body({ operatingHours: "Mon–Fri 8–16" }), { path: "operatingHours", message: TWO_TIMES_OR_NOTHING })
    assert.deepEqual(body({ operatingHours: "Mon–Fri 05:00–22:00, Sat 06:00–12:00" }), { path: "operatingHours", message: TWO_TIMES_OR_NOTHING })
    assert.deepEqual(body({ ownership: "external" }), { path: "ownership", message: 'The API has no ownership "external" for a depot; it knows company, service-provider' })
    assert.deepEqual(body({ ownership: "service-provider" }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP })
    assert.deepEqual(body({ serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP })
    assert.deepEqual(body({ ownership: "service-provider", serviceProviderId: "service-provider-nowhere" }), { path: "serviceProviderId", message: "Pick a service provider the API holds" })
    assert.deepEqual(body({ vehicleCapacity: "0" }), { path: "vehicleCapacity", message: "Vehicle capacity is a whole number, 1 or more" })
    assert.deepEqual(body({ projectId: "project-nowhere" }), { path: "projectId", message: "Pick a project" })
    assert.deepEqual(body({ code: "" }), { path: "code", message: "A depot needs a code" })
    assert.deepEqual(body({ name: "" }), { path: "name", message: "A depot needs a name" })
    assert.deepEqual(body({ address: "" }), { path: "address", message: "A depot needs an address" })
    const provided = body({ ownership: "service-provider", serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren })
    assert.ok(DepotCreate.safeParse(provided).success)
    assert.equal((provided as { serviceProviderId: string }).serviceProviderId, nordren.id)
  })

  test("a patch says what moved — a rename, hours cleared as two nulls, a new owner by server id, a status the lifecycle moved — and the contract accepts it", () => {
    const renamed: BusinessRecord = { ...record, name: "Nordhavn Base", submittedValues: { ...record.submittedValues, name: "Nordhavn Base", operatingHours: "" } }
    const body = depotAdapter.toPatchBody(record, renamed, context())
    assert.deepEqual(body, { name: "Nordhavn Base", opensAt: null, closesAt: null })
    assert.ok(DepotPatch.safeParse(body).success)
    const handedOver: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, ownership: "service-provider", serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren } }
    assert.deepEqual(depotAdapter.toPatchBody(record, handedOver, context()), { ownership: "service-provider", serviceProviderId: nordren.id })
    const seasonal: BusinessRecord = { ...record, status: "Seasonal" }
    assert.deepEqual(depotAdapter.toPatchBody(record, seasonal, context()), { status: "seasonal" })
    const moved: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, latitude: "55.71", longitude: "12.6", vehicleCapacity: "10" } }
    assert.deepEqual(depotAdapter.toPatchBody(record, moved, context()), { location: at(12.6, 55.71), vehicleCapacity: 10 })
    assert.equal(depotAdapter.toPatchBody(record, record, context()), null)
  })

  test("what is set once does not move: the code, the project, the kind of location; and a depot keeps a location", () => {
    const patch = (over: Record<string, string>) => depotAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, ...over } }, context())
    assert.deepEqual(patch({ code: "DEP-NORD" }), { path: "code", message: "The code is set once: a depot that needs another code is another depot" })
    assert.deepEqual(patch({ projectId: FIXTURE_PROJECT_IDS.harbor }), { path: "projectId", message: "A depot stays in its project" })
    assert.deepEqual(patch({ locationType: "unloading" }), { path: "locationType", message: "A location keeps its kind: a depot does not become an unloading station" })
    assert.deepEqual(patch({ latitude: "", longitude: "" }), { path: "latitude", message: "A depot keeps a location: give the latitude and longitude" })
    assert.deepEqual(patch({ serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }, "the rule is held against the row the patch leaves behind")
  })

  test("through the store's write, a create posts to /depots and the API's 409 comes back as its sentence", async () => {
    const valby = made("depots", "Operational Location", "Draft", { projectId: FIXTURE_PROJECT_IDS.copenhagen, locationType: "depot", name: "Valby Depot", code: "DEP-VALBY", address: "Valby", latitude: "55.66", longitude: "12.5", ownership: "company", serviceProviderId: "", operatingHours: "" })
    const created: Depot = { ...nordhavnDepot, id: "019995e0-0000-7000-8000-0000000000d1", code: "DEP-VALBY", name: "Valby Depot", address: "Valby", location: at(12.5, 55.66), opensAt: null, closesAt: null, status: "draft" }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/depots/${created.id}` })])
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(clientOver(fetch), placesModule, current, valby, { fixtures: placeFixtures, state, now: NOW })
    assert.equal(`${calls[0].init.method} ${calls[0].url}`, "POST http://api.test/depots")
    assert.deepEqual(bodyOf(calls[0]), { projectId: copenhagen.id, code: "DEP-VALBY", name: "Valby Depot", address: "Valby", location: at(12.5, 55.66), ownership: "company", status: "draft" })
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.record.status, "Draft")
    assert.equal(outcome.serverId, created.id)

    const refused = scripted([() => problem(409, 'This project already has a depot coded "DEP-VALBY"')])
    const answer = await writeRecord(clientOver(refused.fetch), placesModule, current, valby, { fixtures: placeFixtures, state, now: NOW })
    assert.equal(answer.kind, "refused")
    if (answer.kind !== "refused") return
    assert.equal(problemSentence(answer.problem), 'This project already has a depot coded "DEP-VALBY"')
  })
})

describe("an unloading station", () => {
  const record = unloadingStationAdapter.toRecord(arc, context())

  test("is the company's record — no project, every scope — with its fractions named by the master module's rows and the form's typed values", () => {
    assert.equal(record.id, `station-${arc.id}`)
    assert.equal(record.name, "ARC Amager")
    assert.equal(record.context, "Unloading station · external")
    assert.equal(record.status, "Active")
    assert.equal(record.projectIds, undefined)
    assert.equal(record.recordKind, "Operational Location")
    assert.deepEqual(record.facts, {
      Kind: "Unloading station",
      Code: "STATION-ARC",
      Address: "Kraftværksvej 31",
      Coordinates: "55.6903, 12.6186",
      Ownership: "External",
      Weighbridge: "Yes",
      Fractions: "Residual · Mixed",
    })
    assert.deepEqual(record.submittedValues, {
      locationType: "unloading",
      name: "ARC Amager",
      code: "STATION-ARC",
      address: "Kraftværksvej 31",
      latitude: "55.6903",
      longitude: "12.6186",
      ownership: "external",
      serviceProviderId: "",
      operatingHours: "",
      acceptedFractionIds: `${fractionWebId(residual)},${fractionWebId(mixed)}`,
      weighbridgeAvailable: true,
    })
    assert.deepEqual(unloadingStationAdapter.statuses, DEPOT_STATUSES, "the same four as a depot's")
  })

  test("the record the form writes becomes an UnloadingStationCreate the contract accepts, the fractions by server id", () => {
    const paper = made("depots", "Operational Location", "Draft", {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      locationType: "unloading",
      name: "Paper Recovery",
      code: "PAPER-RECOVERY",
      address: "Prøvestenen 4",
      latitude: "55.6801",
      longitude: "12.6302",
      ownership: "external",
      serviceProviderId: "",
      operatingHours: "07:00–15:00",
      acceptedFractionIds: `${fractionWebId(glass)},${fractionWebId(residual)}`,
      weighbridgeAvailable: false,
    })
    const body = unloadingStationAdapter.toCreateBody?.(paper, context())
    assert.deepEqual(body, {
      code: "PAPER-RECOVERY",
      name: "Paper Recovery",
      address: "Prøvestenen 4",
      location: at(12.6302, 55.6801),
      ownership: "external",
      opensAt: "07:00",
      closesAt: "15:00",
      weighbridge: false,
      status: "draft",
      wasteFractionIds: [glass.id, residual.id],
    })
    assert.ok(UnloadingStationCreate.safeParse(body).success)
    const refuse = (over: Record<string, string | boolean>) => unloadingStationAdapter.toCreateBody?.({ ...paper, submittedValues: { ...paper.submittedValues, ...over } }, context())
    assert.deepEqual(refuse({ ownership: "" }), { path: "ownership", message: "Say whose the station is: the company's, a service provider's or external" })
    assert.deepEqual(refuse({ acceptedFractionIds: "fraction-nowhere" }), { path: "acceptedFractionIds", message: "Pick waste fractions the API holds" })
    assert.deepEqual(refuse({ latitude: "" }), { path: "latitude", message: "An unloading station has a location: give the latitude and longitude" })
    // A station registered before it accepts anything is a set of none, as the
    // API has it; a browser that still holds the form's old static key under
    // the old field id reads as no selection, not a crash.
    const none = refuse({ acceptedFractionIds: "", acceptedFractionId: "residual" })
    assert.deepEqual((none as { wasteFractionIds: string[] }).wasteFractionIds, [])
    assert.ok(UnloadingStationCreate.safeParse(none).success)
  })

  test("an edit is a patch of the station, the whole set of fractions, or both; the same set in another order is no change", () => {
    const weighed: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, weighbridgeAvailable: false, acceptedFractionIds: `${fractionWebId(glass)},${fractionWebId(residual)}` } }
    const body = unloadingStationAdapter.toPatchBody(record, weighed, context()) as { station?: unknown; wasteFractionIds?: string[] }
    assert.deepEqual(body, { station: { weighbridge: false }, wasteFractionIds: [glass.id, residual.id] })
    assert.ok(UnloadingStationPatch.safeParse(body.station).success)
    assert.ok(UnloadingStationFractionsSet.safeParse({ wasteFractionIds: body.wasteFractionIds }).success)
    const reordered: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, acceptedFractionIds: `${fractionWebId(mixed)},${fractionWebId(residual)}` } }
    assert.equal(unloadingStationAdapter.toPatchBody(record, reordered, context()), null)
    const emptied: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, acceptedFractionIds: "" } }
    assert.deepEqual(unloadingStationAdapter.toPatchBody(record, emptied, context()), { wasteFractionIds: [] }, "a station that takes nothing yet is a set of none")
    const recoded: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, code: "ARC" } }
    assert.deepEqual(unloadingStationAdapter.toPatchBody(record, recoded, context()), { path: "code", message: "The code is set once: an unloading station that needs another code is another unloading station" })
    const rekinded: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, locationType: "depot" } }
    assert.deepEqual(unloadingStationAdapter.toPatchBody(record, rekinded, context()), { path: "locationType", message: "A location keeps its kind: an unloading station does not become a depot" })
  })

  test("the update patches the station, then puts the whole set through its own route, and answers the station as it now stands", async () => {
    const patched = { ...arc, weighbridge: false }
    const reset = { ...patched, wasteFractionIds: [glass.id] }
    const { fetch, calls } = scripted([() => json(patched), () => json(reset)])
    const answer = await unloadingStationAdapter.update(clientOver(fetch), arc.id, { station: { weighbridge: false }, wasteFractionIds: [glass.id] })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/unloading-stations/${arc.id}`, `PUT http://api.test/unloading-stations/${arc.id}/fractions`])
    assert.deepEqual(bodyOf(calls[1]), { wasteFractionIds: [glass.id] })
    assert.deepEqual(answer.wasteFractionIds, [glass.id])
    const setOnly = scripted([() => json(reset)])
    await unloadingStationAdapter.update(clientOver(setOnly.fetch), arc.id, { wasteFractionIds: [glass.id] })
    assert.deepEqual(setOnly.calls.map((call) => `${call.init.method} ${call.url}`), [`PUT http://api.test/unloading-stations/${arc.id}/fractions`])
  })
})

describe("a warehouse", () => {
  const depotRecord = depotAdapter.toRecord(nordhavnDepot, context())
  const withDepots: ServerRecordsState = new Map([...state, ["resources.depots", loaded({ records: [depotRecord], serverIds: new Map([[depotRecord.id, nordhavnDepot.id]]) }, 1)]])
  const resolveDepots = resolverOver(withDepots)
  const record = warehouseAdapter.toRecord(nordhavnWarehouse, context(warehouseFixtures, resolveDepots))

  test("is a record in its project naming the depot it shares a yard with by the web id the store knows it under", () => {
    assert.equal(record.id, `warehouse-${nordhavnWarehouse.id}`)
    assert.equal(record.name, "Nordhavn Warehouse")
    assert.equal(record.context, "Copenhagen Central · Kaj 14, Nordhavn")
    assert.equal(record.status, "Active")
    assert.equal(record.recordKind, "Warehouse")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.deepEqual(record.facts, { Code: "WAREHOUSE-NORDHAVN", Address: "Kaj 14, Nordhavn", "Colocated depot": "Nordhavn Depot", Project: "Copenhagen Central" })
    assert.deepEqual(record.submittedValues, {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      name: "Nordhavn Warehouse",
      code: "WAREHOUSE-NORDHAVN",
      status: "active",
      address: "Kaj 14, Nordhavn",
      latitude: "",
      longitude: "",
      colocatedDepotId: `depot-${nordhavnDepot.id}`,
    })
    assert.deepEqual(warehouseAdapter.statuses, WAREHOUSE_STATUSES)
    const alone = warehouseAdapter.toRecord({ ...west, location: at(12.5, 55.66) }, context(warehouseFixtures, resolveDepots))
    assert.equal(alone.facts["Colocated depot"], undefined)
    assert.equal(alone.facts.Coordinates, "55.66, 12.5")
    assert.equal(alone.submittedValues?.colocatedDepotId, "")
    assert.ok(warehouseAdapter.owns(record))
    assert.ok(warehouseAdapter.owns(made("warehouses", "Warehouse", "Draft", { name: "Valby Stock" })))
    assert.ok(!warehouseAdapter.owns(depotRecord))
  })

  test("the record the form writes becomes a WarehouseCreate the contract accepts: the status the form picked, the point only when both numbers are given, the depot by server id", () => {
    const valby = made("warehouses", "Warehouse", "Active", {
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      name: "Valby Stock",
      code: "WH-VALBY",
      status: "active",
      address: "Logistikvej 10, Valby",
      latitude: "",
      longitude: "",
      colocatedDepotId: `depot-${nordhavnDepot.id}`,
      zones: "A–C",
      allowFungibleStock: true,
      source: "manual",
      effectiveFrom: "2026-10-01",
    })
    const body = warehouseAdapter.toCreateBody?.(valby, context(warehouseFixtures, resolveDepots))
    assert.deepEqual(body, { projectId: copenhagen.id, code: "WH-VALBY", name: "Valby Stock", address: "Logistikvej 10, Valby", depotId: nordhavnDepot.id, status: "active" })
    assert.ok(WarehouseCreate.safeParse(body).success)
    const refuse = (over: Record<string, string>) => warehouseAdapter.toCreateBody?.({ ...valby, submittedValues: { ...valby.submittedValues, ...over } }, context(warehouseFixtures, resolveDepots))
    assert.deepEqual(refuse({ latitude: "55.66" }), { path: "longitude", message: "Give both the latitude and the longitude, or neither" })
    assert.deepEqual(refuse({ colocatedDepotId: `station-${arc.id}` }), { path: "colocatedDepotId", message: "Pick a depot the API holds" })
    assert.deepEqual(refuse({ status: "open" }), { path: "status", message: 'The API has no status "open" for a warehouse; it knows draft, active, restricted, closed' })
    assert.deepEqual(refuse({ code: "" }), { path: "code", message: "A warehouse needs a code" })
    const located = refuse({ latitude: "55.66", longitude: "12.5", colocatedDepotId: "" })
    assert.deepEqual(located, { projectId: copenhagen.id, code: "WH-VALBY", name: "Valby Stock", address: "Logistikvej 10, Valby", location: at(12.5, 55.66), status: "active" })
  })

  test("a patch says what moved, the yard shared no longer as null, and holds the code and the project still", () => {
    const parted: BusinessRecord = { ...record, name: "Nordhavn Stock", status: "Restricted", submittedValues: { ...record.submittedValues, name: "Nordhavn Stock", colocatedDepotId: "", latitude: "55.7091", longitude: "12.5958" } }
    const body = warehouseAdapter.toPatchBody(record, parted, context(warehouseFixtures, resolveDepots))
    assert.deepEqual(body, { name: "Nordhavn Stock", location: at(12.5958, 55.7091), depotId: null, status: "restricted" })
    assert.ok(WarehousePatch.safeParse(body).success)
    assert.equal(warehouseAdapter.toPatchBody(record, record, context(warehouseFixtures, resolveDepots)), null)
    // A location cleared on a geocoded warehouse is null on the wire, which the contract takes.
    const located = warehouseAdapter.toRecord({ ...west, location: at(12.5, 55.66) }, context(warehouseFixtures, resolveDepots))
    const ungeocoded = warehouseAdapter.toPatchBody(located, { ...located, submittedValues: { ...located.submittedValues, latitude: "", longitude: "" } }, context(warehouseFixtures, resolveDepots))
    assert.deepEqual(ungeocoded, { location: null })
    assert.ok(WarehousePatch.safeParse(ungeocoded).success)
    const patch = (over: Record<string, string>) => warehouseAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, ...over } }, context(warehouseFixtures, resolveDepots))
    assert.deepEqual(patch({ code: "WH-NORD" }), { path: "code", message: "The code is set once: a warehouse that needs another code is another warehouse" })
    assert.deepEqual(patch({ projectId: FIXTURE_PROJECT_IDS.harbor }), { path: "projectId", message: "A warehouse stays in its project" })
  })

  test("the module is Resources → Warehouses, and its update patches the row's own route", async () => {
    assert.equal(warehousesModule.workspaceId, "resources")
    assert.equal(warehousesModule.moduleId, "warehouses")
    const { fetch, calls } = scripted([() => json({ ...west, name: "West Stock" })])
    const answer = await warehouseAdapter.update(clientOver(fetch), west.id, { name: "West Stock" })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/warehouses/${west.id}`])
    assert.equal(answer.name, "West Stock")
  })
})
