import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ALLOCATION_STATUSES } from "@waste/domain/resources/vocabulary"

import {
  BOTH_ENDS_OF_THE_WINDOW,
  OVERLAPPING_WINDOW_ORDERED,
  VehicleAllocation,
  VehicleAllocationChange,
  VehicleAllocationConfirm,
  VehicleAllocationCreate,
  VehicleAllocationEvent,
  VehicleAllocationListQuery,
  VehicleAllocationRelease,
  WINDOW_ENDS_AFTER_IT_STARTS,
  windowOrdered,
} from "../allocations"
import { refusal, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const FROM = "2026-10-05T06:00:00+02:00"
const TO = "2026-10-05T14:00:00+02:00"
const backwards = { path: "plannedTo", message: WINDOW_ENDS_AFTER_IT_STARTS }

const allocation = {
  id: ID,
  projectId: OTHER,
  vehicleId: THIRD,
  driverId: ID,
  trailerId: null,
  depotId: OTHER,
  wasteFractionId: null,
  requiredCapacityKg: 9000,
  plannedFrom: FROM,
  plannedTo: TO,
  status: "planned",
  note: "Residual, north",
  ...STAMPS,
}

const event = {
  id: ID,
  recordedAt: STAMPS.createdAt,
  projectId: OTHER,
  vehicleAllocationId: THIRD,
  action: "allocate",
  status: "planned",
  vehicleId: THIRD,
  driverId: ID,
  trailerId: null,
  depotId: OTHER,
  plannedFrom: FROM,
  plannedTo: TO,
  reason: null,
  recordedBy: ID,
}

describe("windowOrdered", () => {
  test("the end comes after the start, strictly, comparing instants and not strings; a half-seen pair is not judged", () => {
    assert.equal(windowOrdered({ plannedFrom: FROM, plannedTo: TO }), true)
    assert.equal(windowOrdered({ plannedFrom: FROM, plannedTo: FROM }), false, "an empty window is an empty range")
    assert.equal(windowOrdered({ plannedFrom: TO, plannedTo: FROM }), false)
    assert.equal(windowOrdered({ plannedFrom: "2026-10-05T06:00:00+02:00", plannedTo: "2026-10-05T05:00:00Z" }), true, "the same wall clock an hour apart across offsets: instants, not strings")
    assert.equal(windowOrdered({ plannedFrom: FROM }), true)
  })
})

describe("VehicleAllocation", () => {
  test("is the current reservation: a vehicle over a window on a clock, with what else it reserves and no route or group", () => {
    assert.deepEqual(VehicleAllocation.parse(allocation), allocation)
    const bare = { ...allocation, driverId: null, depotId: null, requiredCapacityKg: null, note: null, status: "released" }
    assert.deepEqual(VehicleAllocation.parse(bare), bare)
    for (const key of ["routeId", "schemeId", "collectionGroupId"]) assert.equal(Object.keys(VehicleAllocation.shape).includes(key), false, key)
    assert.deepEqual(refusal(VehicleAllocation.safeParse({ ...allocation, plannedTo: FROM })), [backwards])
    assert.equal(VehicleAllocation.safeParse({ ...allocation, plannedFrom: "2026-10-05" }).success, false, "an instant, not a day")
  })
})

describe("VehicleAllocationCreate", () => {
  const body = { projectId: OTHER, vehicleId: THIRD, plannedFrom: FROM, plannedTo: TO }

  test("defaults to planned, takes confirmed, refuses released, and mints nothing", () => {
    assert.deepEqual(VehicleAllocationCreate.parse(body), { ...body, status: "planned" })
    assert.match(VehicleAllocationCreate.shape.status.description ?? "", /released is a command of its own/)
    assert.equal(VehicleAllocationCreate.parse({ ...body, status: "confirmed" }).status, "confirmed")
    assert.deepEqual(refusal(VehicleAllocationCreate.safeParse({ ...body, status: "released" })).map((issue) => issue.path), ["status"])
    assert.deepEqual(VehicleAllocationCreate.shape.status.unwrap().options, ALLOCATION_STATUSES.filter((status) => status !== "released"), "the vocabulary less the one that is a command")
    refusesWhatTheServerOwns(VehicleAllocationCreate, body)
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(VehicleAllocationCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("holds the window to the ordering rule on an equal instant and on a backwards one", () => {
    assert.deepEqual(refusal(VehicleAllocationCreate.safeParse({ ...body, plannedTo: FROM })), [backwards])
    assert.deepEqual(refusal(VehicleAllocationCreate.safeParse({ ...body, plannedFrom: TO, plannedTo: FROM })), [backwards])
    assert.equal(VehicleAllocationCreate.safeParse({ ...body, requiredCapacityKg: 0 }).success, false)
  })
})

describe("the commands", () => {
  test("a change moves any field and carries a reason, which alone is not a change; the window rule holds where both halves are given", () => {
    assert.deepEqual(VehicleAllocationChange.parse({ driverId: ID, reason: "Mads is back" }), { driverId: ID, reason: "Mads is back" })
    assert.deepEqual(VehicleAllocationChange.parse({ plannedTo: TO, reason: "Longer run" }), { plannedTo: TO, reason: "Longer run" }, "the start is the stored row's to judge")
    assert.deepEqual(refusal(VehicleAllocationChange.safeParse({ reason: "Nothing" })), [{ path: "", message: "Give at least one field to change" }])
    assert.deepEqual(refusal(VehicleAllocationChange.safeParse({ driverId: ID })).map((issue) => issue.path), ["reason"])
    assert.deepEqual(refusal(VehicleAllocationChange.safeParse({ plannedFrom: TO, plannedTo: FROM, reason: "x" })), [backwards])
    for (const key of ["status", "projectId", "id"]) assert.match(refusal(VehicleAllocationChange.safeParse({ note: "x", reason: "y", [key]: "z" }))[0].message, new RegExp(key))
  })

  test("a release carries a reason and nothing else; a confirm carries nothing at all", () => {
    assert.deepEqual(VehicleAllocationRelease.parse({ reason: "Truck in the workshop" }), { reason: "Truck in the workshop" })
    assert.deepEqual(refusal(VehicleAllocationRelease.safeParse({})).map((issue) => issue.path), ["reason"])
    assert.deepEqual(VehicleAllocationConfirm.parse({}), {})
    assert.match(refusal(VehicleAllocationConfirm.safeParse({ reason: "x" }))[0].message, /reason/)
  })
})

describe("VehicleAllocationEvent", () => {
  test("is a ledger row: the action, the status after it, the snapshot it left, a reason and who did it — an id and recordedAt, never updatedAt", () => {
    assert.deepEqual(VehicleAllocationEvent.parse(event), event)
    const released = { ...event, action: "release", status: "released", reason: "Truck in the workshop" }
    assert.deepEqual(VehicleAllocationEvent.parse(released), released)
    assert.equal(Object.keys(VehicleAllocationEvent.shape).includes("updatedAt"), false)
    assert.equal(VehicleAllocationEvent.safeParse({ ...event, action: "patch" }).success, false)
  })
})

describe("VehicleAllocationListQuery", () => {
  test("pages by project, vehicle, driver, trailer and status, and by a window the reservation touches, both ends or neither, ordered", () => {
    assert.deepEqual(VehicleAllocationListQuery.parse({ vehicleId: THIRD, status: "confirmed", overlappingFrom: FROM, overlappingTo: TO }), {
      vehicleId: THIRD,
      status: "confirmed",
      overlappingFrom: FROM,
      overlappingTo: TO,
      limit: 50,
    })
    assert.deepEqual(refusal(VehicleAllocationListQuery.safeParse({ overlappingFrom: FROM })), [{ path: "overlappingTo", message: BOTH_ENDS_OF_THE_WINDOW }])
    assert.deepEqual(refusal(VehicleAllocationListQuery.safeParse({ overlappingTo: TO })), [{ path: "overlappingTo", message: BOTH_ENDS_OF_THE_WINDOW }])
    assert.deepEqual(refusal(VehicleAllocationListQuery.safeParse({ overlappingFrom: TO, overlappingTo: FROM })), [{ path: "overlappingTo", message: OVERLAPPING_WINDOW_ORDERED }])
    assert.deepEqual(VehicleAllocationListQuery.parse({ driverId: ID, trailerId: OTHER, projectId: THIRD }), { driverId: ID, trailerId: OTHER, projectId: THIRD, limit: 50 })
  })
})
