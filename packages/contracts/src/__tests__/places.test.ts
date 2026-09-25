import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  BOTH_HOURS_OR_NEITHER,
  Depot,
  DepotCreate,
  DepotListQuery,
  DepotPatch,
  EACH_FRACTION_ONCE,
  hoursShape,
  PROVIDER_WITH_PROVIDER_OWNERSHIP,
  providerShape,
  UnloadingStation,
  UnloadingStationCreate,
  UnloadingStationFractionsSet,
  UnloadingStationListQuery,
  UnloadingStationPatch,
  Warehouse,
  WarehouseCreate,
  WarehouseListQuery,
  WarehousePatch,
} from "../places"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const POINT = { type: "Point", coordinates: [12.5951, 55.7089] }
const providerIssue = { path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }
const hoursIssue = { path: "closesAt", message: BOTH_HOURS_OR_NEITHER }

/** More ids than a set body may carry, to tell the body's bound from the row's. */
const tooManyIds = Array.from({ length: 201 }, (_unused, index) => `01a0d3a5-e5e0-7000-8000-${String(index).padStart(12, "0")}`)

const warehouse = { id: ID, projectId: OTHER, code: "WH-WEST", name: "Warehouse West", address: "Sundkrogsgade 1, 2100 København Ø", location: POINT, depotId: THIRD, status: "active", notes: "Two bays.", ...STAMPS }

const depot = {
  id: ID,
  projectId: OTHER,
  code: "DEP-NORD",
  name: "Nordhavn",
  address: "Sundkrogsgade 1, 2100 København Ø",
  location: POINT,
  ownership: "company",
  serviceProviderId: null,
  opensAt: "05:30",
  closesAt: "18:00",
  vehicleCapacity: 24,
  status: "active",
  notes: null,
  ...STAMPS,
}

const station = {
  id: ID,
  code: "ARC-AMAGER",
  name: "ARC Amager Bakke",
  address: "Vindmøllevej 6, 2300 København S",
  location: POINT,
  ownership: "external",
  serviceProviderId: null,
  opensAt: null,
  closesAt: null,
  weighbridge: true,
  status: "active",
  notes: null,
  wasteFractionIds: [OTHER, THIRD],
  ...STAMPS,
}

describe("the two shape rules", () => {
  test("providerShape: the provider is named exactly with service-provider ownership, and a half-seen pair is not judged", () => {
    assert.equal(providerShape("service-provider", { serviceProviderId: THIRD }), true)
    assert.equal(providerShape("company", { serviceProviderId: null }), true)
    assert.equal(providerShape("service-provider", { serviceProviderId: null }), false)
    assert.equal(providerShape("company", { serviceProviderId: THIRD }), false)
    assert.equal(providerShape(undefined, { serviceProviderId: THIRD }), true, "a patch giving the provider alone: the route holds it against the stored ownership")
    assert.equal(providerShape("company", {}), true, "a patch giving the ownership alone")
  })

  test("hoursShape: both times or neither, a half-seen pair not judged", () => {
    assert.equal(hoursShape({ opensAt: "22:00", closesAt: "05:00" }), true, "an overnight window is two times")
    assert.equal(hoursShape({ opensAt: null, closesAt: null }), true)
    assert.equal(hoursShape({ opensAt: "06:00", closesAt: null }), false)
    assert.equal(hoursShape({ opensAt: "06:00" }), true)
  })
})

describe("Warehouse", () => {
  test("is the project's stock place: registered before it is geocoded, colocated with a depot by one pointer", () => {
    assert.deepEqual(Warehouse.parse(warehouse), warehouse)
    const bare = { ...warehouse, location: null, depotId: null, notes: null }
    assert.deepEqual(Warehouse.parse(bare), bare)
    assert.equal(Warehouse.safeParse({ ...warehouse, status: "seasonal" }).success, false, "a depot's status, not a warehouse's")
  })

  test("is created with its code once and defaults to active, and its patch never moves the project or the code", () => {
    const body = { projectId: OTHER, code: "WH-WEST", name: "Warehouse West", address: "Sundkrogsgade 1" }
    assert.deepEqual(WarehouseCreate.parse(body), { ...body, status: "active" })
    assert.match(WarehouseCreate.shape.status.description ?? "", /active/)
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(WarehouseCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(WarehouseCreate, body)
    assert.deepEqual(WarehousePatch.parse({ depotId: null, status: "closed" }), { depotId: null, status: "closed" })
    refusesAnEmptyPatch(WarehousePatch)
    for (const key of ["projectId", "code"]) assert.match(refusal(WarehousePatch.safeParse({ name: "x", [key]: "y" }))[0].message, new RegExp(key))
  })
})

describe("Depot", () => {
  test("is always located, and carries its ownership, its hours and its yard's capacity", () => {
    assert.deepEqual(Depot.parse(depot), depot)
    const providers = { ...depot, ownership: "service-provider", serviceProviderId: THIRD, opensAt: null, closesAt: null, vehicleCapacity: null }
    assert.deepEqual(Depot.parse(providers), providers)
    assert.equal(Depot.safeParse({ ...depot, location: null }).success, false, "a route departs from a point")
    assert.equal(Depot.safeParse({ ...depot, vehicleCapacity: 0 }).success, false)
    assert.equal(Depot.safeParse({ ...depot, opensAt: "05:30:00" }).success, false, "a time of day carries no seconds")
  })

  test("the create defaults to the company's and active, and holds the provider and the hours to their shapes", () => {
    const body = { projectId: OTHER, code: "DEP-NORD", name: "Nordhavn", address: "Sundkrogsgade 1", location: POINT }
    assert.deepEqual(DepotCreate.parse(body), { ...body, ownership: "company", status: "active" })
    assert.deepEqual(refusal(DepotCreate.safeParse({ ...body, ownership: "service-provider" })), [providerIssue], "a provider's depot names its provider")
    assert.deepEqual(refusal(DepotCreate.safeParse({ ...body, serviceProviderId: THIRD })), [providerIssue], "the company's names none")
    assert.equal(DepotCreate.safeParse({ ...body, ownership: "service-provider", serviceProviderId: THIRD }).success, true)
    assert.deepEqual(refusal(DepotCreate.safeParse({ ...body, opensAt: "06:00" })), [hoursIssue])
    assert.deepEqual(refusal(DepotCreate.safeParse({ ...body, closesAt: "18:00" })), [hoursIssue])
    assert.equal(DepotCreate.safeParse({ ...body, opensAt: "22:00", closesAt: "05:00" }).success, true, "an overnight window")
    refusesWhatTheServerOwns(DepotCreate, body)
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(DepotCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("the patch holds the shapes where it carries both halves, leaves a half to the route, and never moves the project or the code", () => {
    assert.deepEqual(refusal(DepotPatch.safeParse({ ownership: "company", serviceProviderId: THIRD })), [providerIssue])
    assert.deepEqual(DepotPatch.parse({ serviceProviderId: THIRD }), { serviceProviderId: THIRD }, "the ownership is the stored row's to judge")
    assert.deepEqual(refusal(DepotPatch.safeParse({ opensAt: "06:00", closesAt: null })), [hoursIssue])
    assert.deepEqual(DepotPatch.parse({ closesAt: "19:00" }), { closesAt: "19:00" })
    refusesAnEmptyPatch(DepotPatch)
    for (const key of ["projectId", "code"]) assert.match(refusal(DepotPatch.safeParse({ name: "x", [key]: "y" }))[0].message, new RegExp(key))
  })
})

describe("UnloadingStation", () => {
  test("is the company's — no project anywhere — always located, with a weighbridge flag and the fractions it accepts", () => {
    assert.deepEqual(UnloadingStation.parse(station), station)
    assert.equal(Object.keys(UnloadingStation.shape).includes("projectId"), false)
    assert.equal(UnloadingStation.safeParse({ ...station, ownership: "leased" }).success, false, "a vehicle's ownership, not a station's")
    assert.deepEqual(UnloadingStation.parse({ ...station, wasteFractionIds: [] }).wasteFractionIds, [])
  })

  test("the create names its ownership, defaults the weighbridge, the status and the fractions, holds the shapes, and mints nothing", () => {
    const body = { code: "ARC-AMAGER", name: "ARC Amager Bakke", address: "Vindmøllevej 6", location: POINT, ownership: "external" }
    assert.deepEqual(UnloadingStationCreate.parse(body), { ...body, weighbridge: false, status: "active", wasteFractionIds: [] })
    assert.deepEqual(refusal(UnloadingStationCreate.safeParse({ ...body, ownership: "service-provider" })), [providerIssue])
    assert.deepEqual(refusal(UnloadingStationCreate.safeParse({ ...body, opensAt: "06:00" })), [hoursIssue])
    assert.deepEqual(refusal(UnloadingStationCreate.safeParse({ ...body, wasteFractionIds: [OTHER, OTHER] })), [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
    assert.equal(UnloadingStationCreate.safeParse({ ...body, wasteFractionIds: tooManyIds }).success, false)
    refusesWhatTheServerOwns(UnloadingStationCreate, body)
    assert.match(refusal(UnloadingStationCreate.safeParse({ ...body, projectId: OTHER }))[0].message, /projectId/)
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(UnloadingStationCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("the patch moves everything but the code and the fractions; the set replaces the whole list", () => {
    assert.deepEqual(UnloadingStationPatch.parse({ weighbridge: true, status: "closed" }), { weighbridge: true, status: "closed" })
    assert.deepEqual(refusal(UnloadingStationPatch.safeParse({ ownership: "service-provider", serviceProviderId: null })), [providerIssue])
    refusesAnEmptyPatch(UnloadingStationPatch)
    for (const key of ["code", "wasteFractionIds"]) assert.match(refusal(UnloadingStationPatch.safeParse({ name: "x", [key]: "y" }))[0].message, new RegExp(key))
    assert.deepEqual(UnloadingStationFractionsSet.parse({ wasteFractionIds: [THIRD] }), { wasteFractionIds: [THIRD] })
    assert.deepEqual(UnloadingStationFractionsSet.parse({ wasteFractionIds: [] }), { wasteFractionIds: [] })
    assert.deepEqual(refusal(UnloadingStationFractionsSet.safeParse({ wasteFractionIds: [THIRD, THIRD] })), [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
    assert.equal(UnloadingStation.parse({ ...station, wasteFractionIds: tooManyIds }).wasteFractionIds.length, tooManyIds.length, "the bound is a body's")
  })
})

describe("the list queries", () => {
  test("a warehouse and a depot page by project and status; a station page by status and the fraction it accepts, and by no project", () => {
    assert.deepEqual(WarehouseListQuery.parse({ projectId: OTHER, status: "active" }), { projectId: OTHER, status: "active", limit: 50 })
    assert.deepEqual(DepotListQuery.parse({ status: "seasonal", limit: "5" }), { status: "seasonal", limit: 5 })
    assert.equal(DepotListQuery.safeParse({ status: "restricted" }).success, false, "a warehouse's status")
    assert.deepEqual(UnloadingStationListQuery.parse({ wasteFractionId: THIRD, status: "active" }), { wasteFractionId: THIRD, status: "active", limit: 50 })
    assert.deepEqual(UnloadingStationListQuery.parse({ projectId: OTHER }), { limit: 50 }, "a project is not a filter here and is dropped")
  })
})
