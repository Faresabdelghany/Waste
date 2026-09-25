import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  A_POWERED_VEHICLE_HAS_A_COMPARTMENT,
  COMPARTMENTS_MAX,
  Driver,
  DriverCreate,
  DriverListQuery,
  DriverPatch,
  EACH_FRACTION_ONCE,
  poweredVehicleHasACompartment,
  PROVIDER_WITH_PROVIDER_EMPLOYMENT,
  Vehicle,
  VehicleCompartment,
  VehicleCompartmentCreate,
  VehicleCompartmentsSet,
  VehicleCreate,
  VehicleListQuery,
  VehiclePatch,
} from "../fleet"
import { PROVIDER_WITH_PROVIDER_OWNERSHIP } from "../places"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const FOURTH = "01a0d3a5-e5e0-7000-8000-000000000004"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const providerIssue = { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }
/** A driver body has no ownership to be told about: the same rule over its employment, in its own words. */
const employmentIssue = { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_EMPLOYMENT }

const body = { position: 1, name: "Body", capacityKg: 9000, volumeLitres: 18000, wasteFractionIds: [THIRD] }
const left = { position: 2, name: "Left", capacityKg: 4000, volumeLitres: null, wasteFractionIds: [THIRD, FOURTH] }

const vehicle = {
  id: ID,
  projectId: OTHER,
  registration: "CN 42 018",
  callsign: "WH-24",
  kind: "powered-vehicle",
  vehicleTypeId: THIRD,
  ownership: "company",
  serviceProviderId: null,
  status: "active",
  capacityKg: 18000,
  requiredLicenceClass: "c",
  homeDepotId: FOURTH,
  fuel: "hvo",
  telematicsDeviceId: "TLM-0042",
  notes: null,
  compartments: [body, left],
  ...STAMPS,
}

const driver = {
  id: ID,
  projectId: OTHER,
  name: "Mads Jensen",
  workforceReference: "WF-1042",
  employment: "employee",
  serviceProviderId: null,
  homeDepotId: FOURTH,
  licenceClass: "ce",
  licenceNumber: "DK-1234567",
  licenceExpiry: "2029-05-01",
  userAccountId: THIRD,
  status: "active",
  notes: null,
  ...STAMPS,
}

describe("VehicleCompartment", () => {
  test("is a positioned part of the vehicle carrying one or more fractions, each once", () => {
    assert.deepEqual(VehicleCompartment.parse(body), body)
    assert.deepEqual(refusal(VehicleCompartment.safeParse({ ...body, wasteFractionIds: [] })).map((issue) => issue.path), ["wasteFractionIds"])
    assert.deepEqual(refusal(VehicleCompartment.safeParse({ ...body, wasteFractionIds: [THIRD, THIRD] })), [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
    for (const position of [0, -1, 1.5]) assert.equal(VehicleCompartment.safeParse({ ...body, position }).success, false, String(position))
    assert.equal(VehicleCompartment.safeParse({ ...body, capacityKg: 0 }).success, false)
  })

  test("a body gives no position — the order is the position — and nothing the server owns", () => {
    const create = { name: "Body", capacityKg: 9000, wasteFractionIds: [THIRD] }
    assert.deepEqual(VehicleCompartmentCreate.parse(create), create)
    assert.match(refusal(VehicleCompartmentCreate.safeParse({ ...create, position: 1 }))[0].message, /position/)
    assert.match(refusal(VehicleCompartmentCreate.safeParse({ ...create, vehicleId: ID }))[0].message, /vehicleId/)
  })
})

describe("Vehicle", () => {
  test("is the powered vehicle or the trailer with its compartments by position, and a required licence class that is never unknown", () => {
    assert.deepEqual(Vehicle.parse(vehicle), vehicle)
    const trailer = { ...vehicle, kind: "trailer", callsign: null, capacityKg: null, homeDepotId: null, fuel: null, telematicsDeviceId: null, compartments: [], requiredLicenceClass: "ce" }
    assert.deepEqual(Vehicle.parse(trailer), trailer)
    assert.equal(Vehicle.safeParse({ ...vehicle, requiredLicenceClass: null }).success, false, "unknown passes nobody")
    assert.equal(Vehicle.safeParse({ ...vehicle, requiredLicenceClass: "C" }).success, false, "the token is lowercase")
    for (const key of ["effectiveFrom", "availability", "costRate"]) assert.equal(Object.keys(Vehicle.shape).includes(key), false, key)
  })
})

describe("VehicleCreate", () => {
  const create = { projectId: OTHER, registration: "CN 42 018", kind: "powered-vehicle", vehicleTypeId: THIRD, requiredLicenceClass: "c", compartments: [{ wasteFractionIds: [THIRD] }] }

  test("defaults the ownership and the status, says so, takes the compartments in body order, and mints nothing", () => {
    assert.deepEqual(VehicleCreate.parse(create), { ...create, ownership: "company", status: "active" })
    assert.match(VehicleCreate.shape.ownership.description ?? "", /company/)
    assert.match(VehicleCreate.shape.compartments.description ?? "", /trailer may have none/)
    refusesWhatTheServerOwns(VehicleCreate, create)
    for (const key of ["projectId", "registration", "kind", "vehicleTypeId", "requiredLicenceClass"]) {
      const without: Record<string, unknown> = { ...create }
      delete without[key]
      assert.deepEqual(refusal(VehicleCreate.safeParse(without)).map((issue) => issue.path), [key], key)
    }
  })

  test("a powered vehicle has at least one compartment, a trailer may have none, and at most twenty either way", () => {
    const compartments = { path: "compartments", message: A_POWERED_VEHICLE_HAS_A_COMPARTMENT }
    assert.deepEqual(refusal(VehicleCreate.safeParse({ ...create, compartments: [] })), [compartments])
    const withoutList: Record<string, unknown> = { ...create }
    delete withoutList.compartments
    assert.deepEqual(refusal(VehicleCreate.safeParse(withoutList)), [compartments], "absent is none")
    assert.equal(VehicleCreate.safeParse({ ...create, kind: "trailer", compartments: [] }).success, true)
    assert.equal(VehicleCreate.safeParse({ ...create, compartments: Array.from({ length: COMPARTMENTS_MAX }, () => ({ wasteFractionIds: [THIRD] })) }).success, true)
    assert.deepEqual(refusal(VehicleCreate.safeParse({ ...create, compartments: Array.from({ length: COMPARTMENTS_MAX + 1 }, () => ({ wasteFractionIds: [THIRD] })) })).map((issue) => issue.path), ["compartments"])
    assert.equal(poweredVehicleHasACompartment("trailer", []), true)
    assert.equal(poweredVehicleHasACompartment("powered-vehicle", []), false)
  })

  test("holds the provider to the ownership, and each compartment to its own rules at its own path", () => {
    assert.deepEqual(refusal(VehicleCreate.safeParse({ ...create, ownership: "service-provider" })), [providerIssue])
    assert.deepEqual(refusal(VehicleCreate.safeParse({ ...create, serviceProviderId: FOURTH })), [providerIssue])
    assert.equal(VehicleCreate.safeParse({ ...create, ownership: "service-provider", serviceProviderId: FOURTH }).success, true)
    assert.deepEqual(refusal(VehicleCreate.safeParse({ ...create, compartments: [{ wasteFractionIds: [THIRD] }, { wasteFractionIds: [THIRD, THIRD] }] })), [
      { path: "compartments.1.wasteFractionIds", message: EACH_FRACTION_ONCE },
    ])
  })
})

describe("VehiclePatch and VehicleCompartmentsSet", () => {
  test("a patch moves everything but the project, the kind, the compartments and the stamps: a vehicle does not become a trailer", () => {
    const patch = { registration: "CN 42 019", status: "retired", requiredLicenceClass: "ce", homeDepotId: null, fuel: "electric" }
    assert.deepEqual(VehiclePatch.parse(patch), patch)
    refusesAnEmptyPatch(VehiclePatch)
    for (const key of ["projectId", "kind", "compartments", "id"]) assert.match(refusal(VehiclePatch.safeParse({ notes: "x", [key]: "y" }))[0].message, new RegExp(key))
    assert.deepEqual(refusal(VehiclePatch.safeParse({ ownership: "company", serviceProviderId: FOURTH })), [providerIssue])
    assert.deepEqual(VehiclePatch.parse({ serviceProviderId: FOURTH }), { serviceProviderId: FOURTH }, "the ownership is the stored row's to judge")
  })

  test("the set is the whole list in position order, at most twenty; whether it may be empty is the stored kind's question", () => {
    const compartments = [{ wasteFractionIds: [THIRD] }, { name: "Left", wasteFractionIds: [FOURTH] }]
    assert.deepEqual(VehicleCompartmentsSet.parse({ compartments }), { compartments })
    assert.deepEqual(VehicleCompartmentsSet.parse({ compartments: [] }), { compartments: [] })
    assert.equal(VehicleCompartmentsSet.safeParse({ compartments: Array.from({ length: COMPARTMENTS_MAX + 1 }, () => ({ wasteFractionIds: [THIRD] })) }).success, false)
    assert.match(refusal(VehicleCompartmentsSet.safeParse({ compartments, vehicleId: ID }))[0].message, /vehicleId/)
  })
})

describe("Driver", () => {
  test("is a workforce profile linked to a login, never the same record, with the licence as three attributes", () => {
    assert.deepEqual(Driver.parse(driver), driver)
    const hire = { ...driver, workforceReference: null, homeDepotId: null, licenceClass: null, licenceNumber: null, licenceExpiry: null, userAccountId: null }
    assert.deepEqual(Driver.parse(hire), hire, "a new hire without a licence is a real record")
    assert.equal(Driver.safeParse({ ...driver, licenceClass: "CE" }).success, false)
    assert.equal(Driver.safeParse({ ...driver, licenceExpiry: "2029-05-01T00:00:00Z" }).success, false, "a day, not an instant")
    for (const key of ["driverAppAccess", "skills"]) assert.equal(Object.keys(Driver.shape).includes(key), false, key)
  })

  test("the create defaults to active, holds the provider to the employment, needs the project, the name and the employment, and mints nothing", () => {
    const create = { projectId: OTHER, name: "Jonas Lind", employment: "employee" }
    assert.deepEqual(DriverCreate.parse(create), { ...create, status: "active" })
    assert.deepEqual(refusal(DriverCreate.safeParse({ ...create, employment: "service-provider" })), [employmentIssue])
    assert.equal(DriverCreate.safeParse({ ...create, employment: "service-provider", serviceProviderId: FOURTH }).success, true)
    assert.deepEqual(refusal(DriverCreate.safeParse({ ...create, serviceProviderId: FOURTH })), [employmentIssue])
    assert.match(PROVIDER_WITH_PROVIDER_EMPLOYMENT, /employment/, "a driver is told about its employment, not an ownership it does not have")
    refusesWhatTheServerOwns(DriverCreate, create)
    for (const key of Object.keys(create)) {
      const without: Record<string, unknown> = { ...create }
      delete without[key]
      assert.deepEqual(refusal(DriverCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("the patch moves everything but the project, and holds the provider where it carries both halves", () => {
    assert.deepEqual(DriverPatch.parse({ licenceClass: "c", licenceExpiry: "2030-01-01", userAccountId: null }), { licenceClass: "c", licenceExpiry: "2030-01-01", userAccountId: null })
    refusesAnEmptyPatch(DriverPatch)
    assert.match(refusal(DriverPatch.safeParse({ name: "x", projectId: OTHER }))[0].message, /projectId/)
    assert.deepEqual(refusal(DriverPatch.safeParse({ employment: "employee", serviceProviderId: FOURTH })), [employmentIssue])
    assert.deepEqual(DriverPatch.parse({ employment: "temporary" }), { employment: "temporary" })
  })
})

describe("the list queries", () => {
  test("a vehicle page by project, kind, type, status and depot; a driver page by project, status, class and depot", () => {
    assert.deepEqual(VehicleListQuery.parse({ projectId: OTHER, kind: "trailer", vehicleTypeId: THIRD, status: "active", homeDepotId: FOURTH }), {
      projectId: OTHER,
      kind: "trailer",
      vehicleTypeId: THIRD,
      status: "active",
      homeDepotId: FOURTH,
      limit: 50,
    })
    assert.equal(VehicleListQuery.safeParse({ kind: "bicycle" }).success, false)
    assert.deepEqual(DriverListQuery.parse({ status: "active", licenceClass: "ce", limit: "10" }), { status: "active", licenceClass: "ce", limit: 10 })
    assert.equal(DriverListQuery.safeParse({ licenceClass: "CE" }).success, false)
  })
})
