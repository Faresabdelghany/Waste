// The fleet on the adapter (#180, slice 5a of #81): a vehicle with its
// compartments becomes the record Fleet › Vehicles, the wizard and the group
// forms read, a driver the record Fleet › Drivers and the licence rule read;
// the records the generic forms write become the bodies the API's contracts
// accept, held here against the contracts' own zod schemas; and the writes
// go out through the store's seam over a scripted `fetch`, the API's
// refusals coming back as its sentences.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { WasteFraction } from "@waste/contracts/catalogue"
import { A_POWERED_VEHICLE_HAS_A_COMPARTMENT, DriverCreate, DriverPatch, PROVIDER_WITH_PROVIDER_EMPLOYMENT, VehicleCompartmentsSet, VehicleCreate, VehiclePatch, type Driver, type Vehicle } from "@waste/contracts/fleet"
import type { Project, ServiceProvider } from "@waste/contracts/organisation"
import { PROVIDER_WITH_PROVIDER_OWNERSHIP, type Depot } from "@waste/contracts/places"
import type { VehicleType } from "@waste/contracts/vehicle-types"
import { DRIVER_STATUSES, VEHICLE_STATUSES } from "@waste/domain/resources/vocabulary"
import { driverProfile, vehicleProfile } from "@waste/domain/route-schemes/fleet-profiles"

import { FIXTURE_COMPANY_ID, FIXTURE_PROJECT_IDS, FIXTURE_SERVICE_PROVIDER_IDS, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import {
  A_POWERED_VEHICLE_HAS_A_COMPARTMENT as LOCAL_A_POWERED_VEHICLE_HAS_A_COMPARTMENT,
  compartmentsOfRecord,
  driverAdapter,
  fleetDriversModule,
  fleetVehiclesModule,
  PROVIDER_WITH_PROVIDER_EMPLOYMENT as LOCAL_PROVIDER_WITH_PROVIDER_EMPLOYMENT,
  vehicleAdapter,
} from "../records/fleet"
import { vehicleTypeAdapter, wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter, serviceProviderAdapter } from "../records/organisation"
import { depotAdapter } from "../records/places"
import { loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixturesOf = (workspaceId: "fleet" | "resources" | "configure" | "service-providers", moduleId: string) => {
  const module = getModuleDefinition({ workspaceId, moduleId })
  if (!module) throw new Error(`no module ${workspaceId}.${moduleId}`)
  return module.records
}
const vehicleFixtures = fixturesOf("fleet", "vehicles")
const driverFixtures = fixturesOf("fleet", "drivers")

// The seeded rows as the API answers them (packages/db/src/seed).
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const nordren: ServiceProvider = { id: "01a0d2a4-a280-7003-8000-000000000001", ...STAMPS, legalName: "NordRen ApS", registrationNumber: "40291188", country: "DK", contactName: "Lars Mikkelsen", contactEmail: "contact@nordren.example" }
const residual: WasteFraction = { id: "01a0d2a4-a280-7005-8000-000000000001", ...STAMPS, key: "residual", name: "Residual" }
const glass: WasteFraction = { ...residual, id: "01a0d2a4-a280-7005-8000-000000000005", key: "glass", name: "Glass" }
const mixed: WasteFraction = { ...residual, id: "01a0d2a4-a280-7005-8000-000000000008", key: "mixed", name: "Mixed" }
const rearLoader: VehicleType = { id: "01a0d2a4-a280-7008-8000-000000000001", ...STAMPS, key: "rear-loader", name: "Rear loader", description: null, containerTypeIds: [] }
const organicSealed: VehicleType = { ...rearLoader, id: "01a0d2a4-a280-7008-8000-000000000002", key: "organic-sealed", name: "Organic sealed" }
const closedTrailer: VehicleType = { ...rearLoader, id: "01a0d2a4-a280-7008-8000-000000000006", key: "closed-trailer", name: "Closed trailer" }
const nordhavn: Depot = { id: "01a0d2a4-a280-7010-8000-000000000001", ...STAMPS, projectId: copenhagen.id, code: "DEPOT-NORDHAVN", name: "Nordhavn Depot", address: "Kaj 14, Nordhavn", location: { type: "Point", coordinates: [12.5958, 55.7091] }, ownership: "company", serviceProviderId: null, opensAt: "05:00", closesAt: "22:00", vehicleCapacity: null, status: "active", notes: null }
const MADS_ACCOUNT_ID = "01a0d2a4-a280-7009-8000-000000000003"

const compartment = (wasteFractionIds: string[], over: Partial<Vehicle["compartments"][number]> = {}): Vehicle["compartments"][number] => ({ position: 1, name: null, capacityKg: null, volumeLitres: null, wasteFractionIds, ...over })
const wh24: Vehicle = { id: "01a0d2a4-a280-7013-8000-000000000001", ...STAMPS, projectId: copenhagen.id, registration: "CN 42 018", callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: rearLoader.id, ownership: "company", serviceProviderId: null, status: "active", capacityKg: 18_000, requiredLicenceClass: "c", homeDepotId: nordhavn.id, fuel: "hvo", telematicsDeviceId: null, notes: null, compartments: [compartment([residual.id, mixed.id])] }
const nr08: Vehicle = { ...wh24, id: "01a0d2a4-a280-7013-8000-000000000003", registration: "AB 51 912", callsign: "NR-08", vehicleTypeId: organicSealed.id, ownership: "service-provider", serviceProviderId: nordren.id, capacityKg: 12_000, homeDepotId: null, fuel: "biogas", compartments: [compartment([residual.id])] }
const trailer: Vehicle = { ...wh24, id: "01a0d2a4-a280-7013-8000-000000000005", registration: "TR 12 012", callsign: "WH-T12", kind: "trailer", vehicleTypeId: closedTrailer.id, requiredLicenceClass: "ce", fuel: null, compartments: [] }

const mads: Driver = { id: "01a0d2a4-a280-7014-8000-000000000001", ...STAMPS, projectId: copenhagen.id, name: "Mads Jensen", workforceReference: null, employment: "employee", serviceProviderId: null, homeDepotId: null, licenceClass: "ce", licenceNumber: null, licenceExpiry: "2028-12-31", userAccountId: MADS_ACCOUNT_ID, status: "active", notes: null }
const lars: Driver = { ...mads, id: "01a0d2a4-a280-7014-8000-000000000003", name: "Lars Møller", employment: "service-provider", serviceProviderId: nordren.id, licenceClass: "c", licenceExpiry: "2026-09-05", userAccountId: null }
const jonas: Driver = { ...mads, id: "01a0d2a4-a280-7014-8000-000000000004", name: "Jonas Lind", licenceClass: null, licenceExpiry: null, userAccountId: null }

// The modules loaded before the fleet: the organisation, the providers, the access, the master data, the depots.
const noResolve = (fixtures: readonly BusinessRecord[]): MappingContext => ({ fixtures, resolve: NOTHING_RESOLVED, now: NOW })
const copenhagenRecord = projectAdapter.toRecord(copenhagen, noResolve(fixturesOf("configure", "organization")))
const nordrenRecord = serviceProviderAdapter.toRecord(nordren, noResolve(fixturesOf("service-providers", "service-providers")))
const madsAccount: BusinessRecord = { id: "user-mads", name: "Mads Jensen", context: "Company · Copenhagen Central", status: "Active", owner: "", value: "", updated: "", description: "", facts: {}, related: [], source: "Waste API", freshness: "", recordKind: "User" }
// The access module lists the roles beside the users, and the account picker is over the whole module.
const PLANNER_ROLE_ID = "01a0d2a4-a280-7004-8000-000000000002"
const plannerRole: BusinessRecord = { ...madsAccount, id: "role-route-planner", name: "Route Planner", recordKind: "Role" }
const fractions = [residual, glass, mixed]
const types = [rearLoader, organicSealed, closedTrailer]
const masterRecords = [
  ...fractions.map((fraction) => wasteFractionAdapter.toRecord(fraction, noResolve(fixturesOf("configure", "master")))),
  ...types.map((type) => vehicleTypeAdapter.toRecord(type, noResolve(fixturesOf("configure", "master")))),
]
const masterIds = new Map(masterRecords.map((record, index) => [record.id, [...fractions, ...types][index].id]))
const withoutDepots: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [copenhagenRecord], serverIds: new Map([[copenhagenRecord.id, copenhagen.id]]) }, 1)],
  ["service-providers.service-providers", loaded({ records: [nordrenRecord], serverIds: new Map([[nordrenRecord.id, nordren.id]]) }, 1)],
  ["configure.access", loaded({ records: [plannerRole, madsAccount], serverIds: new Map([[plannerRole.id, PLANNER_ROLE_ID], [madsAccount.id, MADS_ACCOUNT_ID]]) }, 1)],
  ["configure.master", loaded({ records: masterRecords, serverIds: masterIds }, 1)],
])
const nordhavnRecord = depotAdapter.toRecord(nordhavn, { fixtures: fixturesOf("resources", "depots"), resolve: resolverOver(withoutDepots), now: NOW })
const state: ServerRecordsState = new Map([...withoutDepots, ["resources.depots", loaded({ records: [nordhavnRecord], serverIds: new Map([[nordhavnRecord.id, nordhavn.id]]) }, 1)]])
const resolve = resolverOver(state)
const context = (fixtures: readonly BusinessRecord[] = vehicleFixtures): MappingContext => ({ fixtures, resolve, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })

const fractionWebId = (fraction: WasteFraction) => `fraction-${fraction.id}`
const typeWebId = (type: VehicleType) => `vehicle-type-${type.id}`
const DEPOT_WEB_ID = `depot-${nordhavn.id}`
const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

/** A record the generic workspace has just made under a module's form: the minted id, the form's kind, the status the lifecycle gives it. */
const made = (moduleId: string, recordKind: string, status: string, name: string, submittedValues: BusinessRecord["submittedValues"]): BusinessRecord => ({
  id: `${moduleId}-${recordKind.toLowerCase().replaceAll(" ", "-")}-1700000000000`,
  name,
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
  projectIds: [FIXTURE_PROJECT_IDS.copenhagen],
  recordKind,
  submittedValues,
})

/** The record without the typed key the adapter keeps the compartments under, for a comparison of the form's fields alone. */
const formValuesOf = (record: BusinessRecord) => {
  const values = { ...record.submittedValues }
  for (const key of Object.keys(values)) if (!/^[a-z][A-Za-z]*$/.test(key) || key === "compartmentSet") delete values[key]
  return values
}

describe("the fleet modules", () => {
  test("are switched, after every module a vehicle or a driver names a row of", () => {
    assert.ok(isServerBacked("fleet", "vehicles"))
    assert.ok(isServerBacked("fleet", "drivers"))
    const at = (key: string) => SERVER_MODULE_KEYS.indexOf(key)
    for (const earlier of ["configure.organization", "service-providers.service-providers", "configure.master", "resources.depots"]) {
      assert.ok(at(earlier) < at("fleet.vehicles"), `${earlier} loads before the vehicles`)
    }
    for (const earlier of ["configure.organization", "service-providers.service-providers", "configure.access", "resources.depots"]) {
      assert.ok(at(earlier) < at("fleet.drivers"), `${earlier} loads before the drivers`)
    }
  })

  test("each lists its one resource and files every row under its own prefix; no fixture lends its id", async () => {
    const vehicles = scripted([() => pageOf([wh24, nr08, trailer])])
    const loadedVehicles = await loadModule(clientOver(vehicles.fetch), fleetVehiclesModule, { fixtures: vehicleFixtures, state, now: NOW })
    assert.deepEqual(vehicles.calls.map((call) => call.url), ["http://api.test/vehicles?limit=200"])
    assert.deepEqual(loadedVehicles.records.map((record) => record.id), [`vehicle-${wh24.id}`, `vehicle-${nr08.id}`, `vehicle-${trailer.id}`])
    const drivers = scripted([() => pageOf([mads, lars, jonas])])
    const loadedDrivers = await loadModule(clientOver(drivers.fetch), fleetDriversModule, { fixtures: driverFixtures, state, now: NOW })
    assert.deepEqual(drivers.calls.map((call) => call.url), ["http://api.test/drivers?limit=200"])
    assert.deepEqual(loadedDrivers.records.map((record) => record.id), [`driver-${mads.id}`, `driver-${lars.id}`, `driver-${jonas.id}`])
  })

  test("the sentences quoted here are the contracts' own", () => {
    assert.equal(LOCAL_A_POWERED_VEHICLE_HAS_A_COMPARTMENT, A_POWERED_VEHICLE_HAS_A_COMPARTMENT)
    assert.equal(LOCAL_PROVIDER_WITH_PROVIDER_EMPLOYMENT, PROVIDER_WITH_PROVIDER_EMPLOYMENT)
  })
})

describe("a vehicle", () => {
  const record = vehicleAdapter.toRecord(wh24, context())

  test("is the record the fixtures spell — callsign · plate, type and tonnage · depot — with the wire's four statuses and typed values under the form's field ids", () => {
    assert.equal(record.id, `vehicle-${wh24.id}`)
    assert.equal(record.name, "WH-24 · CN 42 018")
    assert.equal(record.context, "Rear loader 18 t · Nordhavn Depot")
    assert.equal(record.status, "Active")
    assert.equal(record.owner, "")
    assert.equal(record.recordKind, "Vehicle or trailer")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.serviceProviderId, undefined)
    assert.deepEqual(record.facts, {
      Registration: "CN 42 018",
      Callsign: "WH-24",
      Kind: "Powered vehicle",
      Type: "Rear loader",
      Ownership: "Company",
      Capacity: "18 t",
      Fractions: "Residual · Mixed",
      Compartments: "1",
      Fuel: "HVO",
      "Required licence class": "C",
      "Home depot": "Nordhavn Depot",
      Project: "Copenhagen Central",
    })
    assert.deepEqual(formValuesOf(record), {
      registrationNumber: "CN 42 018",
      assetReference: "WH-24",
      resourceKind: "powered-vehicle",
      vehicleType: typeWebId(rearLoader),
      ownershipType: "company",
      serviceProviderId: "",
      status: "active",
      capacity: "18000",
      requiredLicenceClass: "C",
      volumeCapacity: "",
      wasteFractionIds: `${fractionWebId(residual)},${fractionWebId(mixed)}`,
      compartments: "Compartment 1: Residual, Mixed",
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      homeDepotId: DEPOT_WEB_ID,
      gpsDeviceId: "",
      fuelOrEnergyType: "hvo",
    })
    assert.deepEqual(compartmentsOfRecord(record), [{ name: null, capacityKg: null, volumeLitres: null, wasteFractionIds: [residual.id, mixed.id] }])
    assert.deepEqual(vehicleAdapter.statuses, VEHICLE_STATUSES)
    assert.ok(vehicleAdapter.owns(record))
    assert.ok(vehicleAdapter.owns(made("vehicles", "Vehicle or trailer", "Active", "AB 12 345", {})))
    assert.ok(!vehicleAdapter.owns(nordhavnRecord))
  })

  test("is what the wizard's fleet readers read: the callsign, the canonical type, the tonnage, the licence class; a trailer is a trailer", () => {
    assert.deepEqual(vehicleProfile(record), { id: record.id, callsign: "WH-24", type: "Rear loader", capacityT: 18, licenceClass: "C", isTrailer: false })
    const towed = vehicleAdapter.toRecord(trailer, context())
    assert.equal(towed.name, "WH-T12 · TR 12 012")
    assert.equal(towed.context, "Closed trailer 18 t · Nordhavn Depot")
    assert.deepEqual(vehicleProfile(towed), { id: towed.id, callsign: "WH-T12", type: "Closed trailer", capacityT: 18, licenceClass: "CE", isTrailer: true })
    assert.equal(towed.facts.Fractions, undefined)
    assert.equal(towed.facts.Compartments, undefined)
    assert.equal(towed.facts.Fuel, undefined)
    assert.equal(towed.submittedValues?.resourceKind, "trailer")
    assert.equal(towed.submittedValues?.wasteFractionIds, "")
    assert.equal(towed.submittedValues?.compartments, "")
    assert.deepEqual(compartmentsOfRecord(towed), [])
  })

  test("a provider's vehicle names it by the web id the store knows it under, has no base when no depot record is, and shows in the provider's scope", () => {
    const provided = vehicleAdapter.toRecord(nr08, context())
    assert.equal(provided.context, "Organic sealed 12 t")
    assert.equal(provided.owner, "NordRen ApS")
    assert.equal(provided.facts.Ownership, "NordRen ApS")
    assert.equal(provided.facts["Home depot"], undefined)
    assert.equal(provided.facts.Fuel, "Biogas")
    assert.equal(provided.serviceProviderId, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.equal(provided.submittedValues?.serviceProviderId, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.equal(provided.submittedValues?.ownershipType, "service-provider")
    assert.equal(provided.submittedValues?.homeDepotId, "")
  })

  const registered = (over: Record<string, string | boolean> = {}) =>
    made("vehicles", "Vehicle or trailer", "Active", "AB 12 345", {
      registrationNumber: "AB 12 345",
      assetReference: "WH-40",
      resourceKind: "powered-vehicle",
      vehicleType: typeWebId(rearLoader),
      ownershipType: "company",
      serviceProviderId: "",
      status: "active",
      capacity: "16000",
      requiredLicenceClass: "C",
      volumeCapacity: "20",
      wasteFractionIds: `${fractionWebId(residual)},${fractionWebId(mixed)}`,
      compartments: "",
      bodyOrLiftType: "",
      trailerCompatibility: "",
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      homeDepotId: DEPOT_WEB_ID,
      effectiveFrom: "2026-10-01",
      availability: "Weekdays",
      gpsDeviceId: "GPS-7",
      fuelOrEnergyType: "diesel",
      costRate: "",
      ...over,
    })

  test("the record the form writes becomes a VehicleCreate the contract accepts: the asset reference as the callsign, the class as its token, the fractions as one compartment with the volume in litres", () => {
    const body = vehicleAdapter.toCreateBody?.(registered(), context())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      registration: "AB 12 345",
      callsign: "WH-40",
      kind: "powered-vehicle",
      vehicleTypeId: rearLoader.id,
      ownership: "company",
      status: "active",
      capacityKg: 16_000,
      requiredLicenceClass: "c",
      homeDepotId: nordhavn.id,
      fuel: "diesel",
      telematicsDeviceId: "GPS-7",
      compartments: [{ volumeLitres: 20_000, wasteFractionIds: [residual.id, mixed.id] }],
    })
    const parsed = VehicleCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
    const towed = vehicleAdapter.toCreateBody?.(registered({ resourceKind: "trailer", wasteFractionIds: "", volumeCapacity: "", requiredLicenceClass: "CE", fuelOrEnergyType: "" }), context()) as { compartments: unknown[]; fuel?: unknown }
    assert.deepEqual(towed.compartments, [])
    assert.equal(towed.fuel, undefined)
    assert.ok(VehicleCreate.safeParse(towed).success)
  })

  test("is refused here, naming the field, for what the API would refuse — a powered vehicle without a fraction in the contract's sentence, a status, a class or a fuel the wire lacks, a reference the store does not hold", () => {
    const refuse = (over: Record<string, string | boolean>) => vehicleAdapter.toCreateBody?.(registered(over), context())
    assert.deepEqual(refuse({ wasteFractionIds: "" }), { path: "wasteFractionIds", message: A_POWERED_VEHICLE_HAS_A_COMPARTMENT })
    assert.deepEqual(refuse({ wasteFractionIds: "", wasteFractions: "Residual, mixed" }), { path: "wasteFractionIds", message: A_POWERED_VEHICLE_HAS_A_COMPARTMENT }, "the retired free-text field reads as no selection")
    assert.deepEqual(refuse({ wasteFractionIds: "fraction-nowhere" }), { path: "wasteFractionIds", message: "Pick waste fractions the API holds" })
    assert.deepEqual(refuse({ status: "inactive" }), { path: "status", message: 'The API has no status "inactive" for a vehicle; it knows active, unavailable, maintenance, retired' })
    assert.deepEqual(refuse({ requiredLicenceClass: "D" }), { path: "requiredLicenceClass", message: "A licence class is B, C or CE" })
    assert.deepEqual(refuse({ requiredLicenceClass: "" }), { path: "requiredLicenceClass", message: "A licence class is B, C or CE" })
    assert.deepEqual(refuse({ capacity: "0" }), { path: "capacity", message: "A rated capacity is a whole number of kilograms, 1 or more" })
    assert.deepEqual(refuse({ volumeCapacity: "0" }), { path: "volumeCapacity", message: "A volume capacity is cubic metres, above zero" })
    assert.deepEqual(refuse({ vehicleType: "vehicle-type-nowhere" }), { path: "vehicleType", message: "Pick a vehicle type the API holds" })
    assert.deepEqual(refuse({ vehicleType: fractionWebId(residual) }), { path: "vehicleType", message: "Pick a vehicle type the API holds" })
    assert.deepEqual(refuse({ homeDepotId: "depot-nowhere" }), { path: "homeDepotId", message: "Pick a depot the API holds" })
    assert.deepEqual(refuse({ fuelOrEnergyType: "petrol" }), { path: "fuelOrEnergyType", message: 'The API has no fuel "petrol" for a vehicle; it knows diesel, hvo, biogas, electric, hybrid, other' })
    assert.deepEqual(refuse({ ownershipType: "service-provider" }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP })
    assert.deepEqual(refuse({ serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP })
    assert.deepEqual(refuse({ resourceKind: "" }), { path: "resourceKind", message: "Say whether this is a powered vehicle or a trailer" })
    assert.deepEqual(refuse({ registrationNumber: "" }), { path: "registrationNumber", message: "A vehicle needs a registration" })
    assert.deepEqual(refuse({ projectId: "project-nowhere" }), { path: "projectId", message: "Pick a project" })
    const provided = refuse({ ownershipType: "service-provider", serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren }) as { ownership: string; serviceProviderId: string }
    assert.equal(provided.serviceProviderId, nordren.id)
    assert.ok(VehicleCreate.safeParse(provided).success)
  })

  test("an edit is a patch of the vehicle, the whole list of compartments, or both; the same fractions in another order are no change", () => {
    const renamed: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, assetReference: "WH-24A", capacity: "17000" } }
    const body = vehicleAdapter.toPatchBody(record, renamed, context()) as { vehicle?: unknown; compartments?: unknown[] }
    assert.deepEqual(body, { vehicle: { callsign: "WH-24A", capacityKg: 17_000 } })
    assert.ok(VehiclePatch.safeParse(body.vehicle).success)
    const refilled: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, wasteFractionIds: `${fractionWebId(residual)},${fractionWebId(glass)}` } }
    const set = vehicleAdapter.toPatchBody(record, refilled, context()) as { compartments: unknown[] }
    assert.deepEqual(set, { compartments: [{ wasteFractionIds: [residual.id, glass.id] }] })
    assert.ok(VehicleCompartmentsSet.safeParse(set).success)
    const widened: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, volumeCapacity: "22" } }
    assert.deepEqual(vehicleAdapter.toPatchBody(record, widened, context()), { compartments: [{ volumeLitres: 22_000, wasteFractionIds: [residual.id, mixed.id] }] })
    const reordered: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, wasteFractionIds: `${fractionWebId(mixed)},${fractionWebId(residual)}` } }
    assert.equal(vehicleAdapter.toPatchBody(record, reordered, context()), null)
    const retired: BusinessRecord = { ...record, status: "Retired" }
    assert.deepEqual(vehicleAdapter.toPatchBody(record, retired, context()), { vehicle: { status: "retired" } })
    const both: BusinessRecord = { ...record, status: "Maintenance", submittedValues: { ...record.submittedValues, wasteFractionIds: fractionWebId(glass), gpsDeviceId: "GPS-9" } }
    assert.deepEqual(vehicleAdapter.toPatchBody(record, both, context()), { vehicle: { telematicsDeviceId: "GPS-9", status: "maintenance" }, compartments: [{ wasteFractionIds: [glass.id] }] })
    assert.equal(vehicleAdapter.toPatchBody(record, record, context()), null)
  })

  test("a compartment keeps its name and capacities when its fractions move; a vehicle of several compartments is not re-cut from the form; what is set once stays", () => {
    const named = vehicleAdapter.toRecord({ ...wh24, compartments: [compartment([residual.id], { name: "Body", capacityKg: 12_000, volumeLitres: 18_000 })] }, context())
    const moved: BusinessRecord = { ...named, submittedValues: { ...named.submittedValues, wasteFractionIds: fractionWebId(glass) } }
    assert.deepEqual(vehicleAdapter.toPatchBody(named, moved, context()), { compartments: [{ name: "Body", capacityKg: 12_000, volumeLitres: 18_000, wasteFractionIds: [glass.id] }] })
    const split = vehicleAdapter.toRecord({ ...wh24, compartments: [compartment([residual.id], { name: "Left" }), compartment([mixed.id], { position: 2, name: "Right" })] }, context())
    assert.equal(split.facts.Compartments, "2")
    assert.equal(split.submittedValues?.compartments, "Left: Residual; Right: Mixed")
    const recut: BusinessRecord = { ...split, submittedValues: { ...split.submittedValues, wasteFractionIds: fractionWebId(glass) } }
    assert.deepEqual(vehicleAdapter.toPatchBody(split, recut, context()), { path: "wasteFractionIds", message: "WH-24 has 2 compartments: their fractions are set compartment by compartment on the API" })
    assert.deepEqual(vehicleAdapter.toPatchBody(split, { ...split, submittedValues: { ...split.submittedValues, capacity: "17000" } }, context()), { vehicle: { capacityKg: 17_000 } }, "the vehicle itself still patches")
    const emptied: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, wasteFractionIds: "" } }
    assert.deepEqual(vehicleAdapter.toPatchBody(record, emptied, context()), { path: "wasteFractionIds", message: A_POWERED_VEHICLE_HAS_A_COMPARTMENT })
    const towed = vehicleAdapter.toRecord(trailer, context())
    assert.deepEqual(vehicleAdapter.toPatchBody(towed, { ...towed, submittedValues: { ...towed.submittedValues, wasteFractionIds: fractionWebId(glass) } }, context()), { compartments: [{ wasteFractionIds: [glass.id] }] }, "a trailer may carry a compartment")
    const patch = (over: Record<string, string>) => vehicleAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, ...over } }, context())
    assert.deepEqual(patch({ resourceKind: "trailer" }), { path: "resourceKind", message: "A vehicle keeps its kind: a powered vehicle does not become a trailer" })
    assert.deepEqual(patch({ projectId: FIXTURE_PROJECT_IDS.harbor }), { path: "projectId", message: "A vehicle stays in its project" })
    assert.deepEqual(patch({ ownershipType: "leased", serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP })
    assert.deepEqual(patch({ homeDepotId: "" }), { vehicle: { homeDepotId: null } })
  })

  test("the update patches the vehicle, then puts the whole list through its own route, and answers the vehicle as it now stands", async () => {
    const patched = { ...wh24, callsign: "WH-24A" }
    const reset = { ...patched, compartments: [compartment([glass.id])] }
    const { fetch, calls } = scripted([() => json(patched), () => json(reset)])
    const answer = await vehicleAdapter.update(clientOver(fetch), wh24.id, { vehicle: { callsign: "WH-24A" }, compartments: [{ wasteFractionIds: [glass.id] }] })
    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [`PATCH http://api.test/vehicles/${wh24.id}`, `PUT http://api.test/vehicles/${wh24.id}/compartments`])
    assert.deepEqual(bodyOf(calls[1]), { compartments: [{ wasteFractionIds: [glass.id] }] })
    assert.deepEqual(answer.compartments, reset.compartments)
    const setOnly = scripted([() => json(reset)])
    await vehicleAdapter.update(clientOver(setOnly.fetch), wh24.id, { compartments: [{ wasteFractionIds: [glass.id] }] })
    assert.deepEqual(setOnly.calls.map((call) => `${call.init.method} ${call.url}`), [`PUT http://api.test/vehicles/${wh24.id}/compartments`])
  })

  test("through the store's write, a create posts to /vehicles and the API's 409 comes back as its sentence", async () => {
    const created: Vehicle = { ...wh24, id: "019995e0-0000-7000-8000-0000000000e1", registration: "AB 12 345", callsign: "WH-40", capacityKg: 16_000, fuel: "diesel", telematicsDeviceId: "GPS-7", compartments: [compartment([residual.id, mixed.id], { volumeLitres: 20_000 })] }
    const { fetch, calls } = scripted([() => json(created, 201, { location: `/vehicles/${created.id}` })])
    const current = loaded({ records: [], serverIds: new Map() }, 1)
    const outcome = await writeRecord(clientOver(fetch), fleetVehiclesModule, current, registered(), { fixtures: vehicleFixtures, state, now: NOW })
    assert.equal(`${calls[0].init.method} ${calls[0].url}`, "POST http://api.test/vehicles")
    assert.equal((bodyOf(calls[0]) as { registration: string }).registration, "AB 12 345")
    assert.equal(outcome.kind, "created")
    if (outcome.kind !== "created") return
    assert.equal(outcome.record.name, "WH-40 · AB 12 345")
    assert.equal(outcome.serverId, created.id)

    const refused = scripted([() => problem(409, "This company already has a vehicle registered AB 12 345")])
    const answer = await writeRecord(clientOver(refused.fetch), fleetVehiclesModule, current, registered(), { fixtures: vehicleFixtures, state, now: NOW })
    assert.equal(answer.kind, "refused")
    if (answer.kind !== "refused") return
    assert.equal(problemSentence(answer.problem), "This company already has a vehicle registered AB 12 345")
  })
})

describe("a driver", () => {
  const record = driverAdapter.toRecord(lars, context(driverFixtures))

  test("is a record with its licence kept literal — the class and the last day it holds — its employer, and typed values under the form's field ids", () => {
    assert.equal(record.id, `driver-${lars.id}`)
    assert.equal(record.name, "Lars Møller")
    assert.equal(record.context, "NordRen ApS · service provider")
    assert.equal(record.status, "Active")
    assert.equal(record.recordKind, "Driver workforce profile")
    assert.deepEqual(record.projectIds, [FIXTURE_PROJECT_IDS.copenhagen])
    assert.equal(record.serviceProviderId, FIXTURE_SERVICE_PROVIDER_IDS.nordren)
    assert.deepEqual(record.facts, {
      Licence: "C · valid to 2026-09-05",
      Employer: "NordRen ApS",
      Employment: "Service provider",
      "App access": "None",
      Project: "Copenhagen Central",
    })
    assert.deepEqual(record.submittedValues, {
      driverName: "Lars Møller",
      workforceReference: "",
      employmentType: "service-provider",
      serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren,
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      homeDepotId: "",
      licenceNumber: "",
      licenceClass: "C",
      licenceExpiry: "2026-09-05",
      driverAppAccess: false,
      linkedUserId: "",
    })
    assert.deepEqual(driverAdapter.statuses, DRIVER_STATUSES)
    assert.ok(driverAdapter.owns(record))
    assert.ok(driverAdapter.owns(made("drivers", "Driver workforce profile", "Invited", "Sofie Eriksen", {})))
    assert.ok(!driverAdapter.owns(vehicleAdapter.toRecord(wh24, context())))
  })

  test("is what the licence rule reads, unjudged here: the expired licence stays the expired licence, the new hire has none on record", () => {
    assert.deepEqual(driverProfile(record), { id: record.id, name: "Lars Møller", licenceClass: "C", licenceExpiry: "2026-09-05" })
    const hire = driverAdapter.toRecord(jonas, context(driverFixtures))
    assert.equal(hire.facts.Licence, "Not on record")
    assert.equal(hire.submittedValues?.licenceClass, "")
    assert.equal(hire.submittedValues?.licenceExpiry, "")
    assert.deepEqual(driverProfile(hire), { id: hire.id, name: "Jonas Lind", licenceClass: null, licenceExpiry: null })
  })

  test("a driver with a login names the account by the web id the store knows it under", () => {
    const bound = driverAdapter.toRecord(mads, context(driverFixtures))
    assert.equal(bound.context, "Company · employee")
    assert.equal(bound.facts.Employer, "Company")
    assert.equal(bound.facts["App access"], "Mads Jensen")
    assert.equal(bound.facts.Licence, "CE · valid to 2028-12-31")
    assert.equal(bound.serviceProviderId, undefined)
    assert.equal(bound.submittedValues?.driverAppAccess, true)
    assert.equal(bound.submittedValues?.linkedUserId, "user-mads")
  })

  const hired = (over: Record<string, string | boolean> = {}) =>
    made("drivers", "Driver workforce profile", "Invited", "Sofie Eriksen", {
      driverName: "Sofie Eriksen",
      workforceReference: "WF-0417",
      employmentType: "employee",
      serviceProviderId: "",
      projectId: FIXTURE_PROJECT_IDS.copenhagen,
      homeDepotId: DEPOT_WEB_ID,
      licenceNumber: "DK-4471",
      licenceClass: "CE",
      licenceExpiry: "2029-01-31",
      driverAppAccess: true,
      linkedUserId: "user-mads",
      ...over,
    })

  test("the record the form writes becomes a DriverCreate the contract accepts; the lifecycle's Invited is the account's word, so the create says no status and the API's default stands", () => {
    const body = driverAdapter.toCreateBody?.(hired(), context(driverFixtures))
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      name: "Sofie Eriksen",
      workforceReference: "WF-0417",
      employment: "employee",
      homeDepotId: nordhavn.id,
      licenceClass: "ce",
      licenceNumber: "DK-4471",
      licenceExpiry: "2029-01-31",
      userAccountId: MADS_ACCOUNT_ID,
    })
    const parsed = DriverCreate.safeParse(body)
    assert.ok(parsed.success, JSON.stringify(parsed.error))
    const unlicensed = driverAdapter.toCreateBody?.(hired({ licenceClass: "", licenceExpiry: "", licenceNumber: "", driverAppAccess: false, linkedUserId: "", homeDepotId: "", workforceReference: "" }), context(driverFixtures))
    assert.deepEqual(unlicensed, { projectId: copenhagen.id, name: "Sofie Eriksen", employment: "employee" })
    assert.ok(DriverCreate.safeParse(unlicensed).success)
  })

  test("is refused here, naming the field, for what the API would refuse: the employment, the provider that does not fit it, a day that is no day, a class or a status the wire lacks, an account the store does not hold", () => {
    const refuse = (over: Record<string, string | boolean>) => driverAdapter.toCreateBody?.(hired(over), context(driverFixtures))
    assert.deepEqual(refuse({ employmentType: "" }), { path: "employmentType", message: "Say how the driver is employed" })
    assert.deepEqual(refuse({ employmentType: "service-provider" }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_EMPLOYMENT })
    assert.deepEqual(refuse({ serviceProviderId: FIXTURE_SERVICE_PROVIDER_IDS.nordren }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_EMPLOYMENT })
    assert.deepEqual(refuse({ licenceExpiry: "31/01/2029" }), { path: "licenceExpiry", message: "A licence expiry is a day, YYYY-MM-DD" })
    assert.deepEqual(refuse({ licenceClass: "D" }), { path: "licenceClass", message: "A licence class is B, C or CE" })
    assert.deepEqual(refuse({ linkedUserId: "" }), { path: "linkedUserId", message: "Pick the driver's user account" })
    assert.deepEqual(refuse({ linkedUserId: "user-nowhere" }), { path: "linkedUserId", message: "Pick a user account the API holds" })
    assert.deepEqual(refuse({ linkedUserId: "role-route-planner" }), { path: "linkedUserId", message: "Pick a user account the API holds" }, "a role row of the access module is no login")
    assert.deepEqual(refuse({ status: "invited" }), { path: "status", message: 'The API has no status "invited" for a driver; it knows active, inactive, suspended' })
    assert.deepEqual(refuse({ driverName: "" }), { path: "driverName", message: "A driver needs a name" })
    assert.deepEqual(refuse({ homeDepotId: "depot-nowhere" }), { path: "homeDepotId", message: "Pick a depot the API holds" })
  })

  test("a patch says what moved — a licence renewal, an account unlinked as null, a status the lifecycle moved — holds the project and the provider rule, and the contract accepts it", () => {
    const renewed: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, licenceClass: "CE", licenceExpiry: "2031-09-05" } }
    const body = driverAdapter.toPatchBody(record, renewed, context(driverFixtures))
    assert.deepEqual(body, { licenceClass: "ce", licenceExpiry: "2031-09-05" })
    assert.ok(DriverPatch.safeParse(body).success)
    const bound = driverAdapter.toRecord(mads, context(driverFixtures))
    assert.deepEqual(driverAdapter.toPatchBody(bound, { ...bound, submittedValues: { ...bound.submittedValues, driverAppAccess: false } }, context(driverFixtures)), { userAccountId: null })
    assert.deepEqual(driverAdapter.toPatchBody(record, { ...record, status: "Suspended" }, context(driverFixtures)), { status: "suspended" })
    assert.equal(driverAdapter.toPatchBody(record, record, context(driverFixtures)), null)
    const patch = (over: Record<string, string | boolean>) => driverAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, ...over } }, context(driverFixtures))
    assert.deepEqual(patch({ projectId: FIXTURE_PROJECT_IDS.harbor }), { path: "projectId", message: "A driver stays in its project" })
    assert.deepEqual(patch({ employmentType: "employee" }), { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_EMPLOYMENT }, "the rule is held against the row the patch leaves behind")
    assert.deepEqual(patch({ employmentType: "employee", serviceProviderId: "" }), { employment: "employee", serviceProviderId: null })
    assert.deepEqual(patch({ driverName: "Lars Møller Hansen", licenceExpiry: "" }), { name: "Lars Møller Hansen", licenceExpiry: null })
  })

  test("through the store's write, an edit patches the row's own route and the API's 409 comes back as its sentence", async () => {
    const current = loaded({ records: [record], serverIds: new Map([[record.id, lars.id]]) }, 1)
    const bound: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, driverAppAccess: true, linkedUserId: "user-mads" } }
    const { fetch, calls } = scripted([() => json({ ...lars, userAccountId: MADS_ACCOUNT_ID })])
    const outcome = await writeRecord(clientOver(fetch), fleetDriversModule, current, bound, { fixtures: driverFixtures, state, now: NOW })
    assert.equal(`${calls[0].init.method} ${calls[0].url}`, `PATCH http://api.test/drivers/${lars.id}`)
    assert.deepEqual(bodyOf(calls[0]), { userAccountId: MADS_ACCOUNT_ID })
    assert.equal(outcome.kind, "updated")
    if (outcome.kind !== "updated") return
    assert.equal(outcome.record.facts["App access"], "Mads Jensen")

    const refused = scripted([() => problem(409, "That login already has a driver profile")])
    const answer = await writeRecord(clientOver(refused.fetch), fleetDriversModule, current, bound, { fixtures: driverFixtures, state, now: NOW })
    assert.equal(answer.kind, "refused")
    if (answer.kind !== "refused") return
    assert.equal(problemSentence(answer.problem), "That login already has a driver profile")
  })
})
