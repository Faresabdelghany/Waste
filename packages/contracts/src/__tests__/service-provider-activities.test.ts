// Service Provider Activities on the wire (#474): a create shaped by its
// kind, a patch of the open fields alone, and the closing bodies, with a
// rejection that always says why.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SERVICE_PROVIDER_ACTIVITY_KINDS, SERVICE_PROVIDER_ACTIVITY_STATUSES } from "@waste/domain/service-providers/vocabulary"

import {
  ActivityClose,
  ActivityKind,
  ActivityReject,
  ActivityStatus,
  ServiceProviderActivity,
  ServiceProviderActivityCreate,
  ServiceProviderActivityListQuery,
  ServiceProviderActivityPatch,
} from "../service-provider-activities"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const BASE = { projectId: ID, serviceProviderId: OTHER, subject: "Organic route to Wednesday" } as const
const PROPOSAL = { ...BASE, kind: "route-day-change", routeSchemeId: ID, collectionGroupId: OTHER, serviceDays: ["wednesday"], effectiveFrom: "2026-11-04" } as const
const FOLLOW_UP = { ...BASE, kind: "compliance-follow-up", subject: "Insurance document renewal", dueOn: "2026-11-12" } as const
const VEHICLE = { ...BASE, kind: "vehicle-change", routeSchemeId: ID, collectionGroupId: OTHER, vehicleId: ID, effectiveFrom: "2026-11-04" } as const
const STOPS = { ...BASE, kind: "stop-set-change", routeSchemeId: ID, collectionGroupId: OTHER, containerIds: [OTHER, ID], effectiveFrom: "2026-11-04" } as const
const NOTE = { ...BASE, kind: "coordination-note", subject: "Harbour access closed Friday", body: "The harbour gate is closed for works." } as const

const fails = (result: { success: boolean }) => !result.success

describe("the vocabularies", () => {
  test("are the service providers'", () => {
    assert.deepEqual(ActivityKind.options, [...SERVICE_PROVIDER_ACTIVITY_KINDS])
    assert.deepEqual(ActivityStatus.options, [...SERVICE_PROVIDER_ACTIVITY_STATUSES])
  })
})

describe("a create", () => {
  test("is shaped by its kind", () => {
    assert.deepEqual(ServiceProviderActivityCreate.parse(PROPOSAL), PROPOSAL)
    assert.deepEqual(ServiceProviderActivityCreate.parse(FOLLOW_UP), FOLLOW_UP)
    assert.deepEqual(ServiceProviderActivityCreate.parse(NOTE), NOTE)
    assert.equal(ServiceProviderActivityCreate.safeParse({ ...NOTE, serviceAreaId: ID }).success, true)
  })

  test("a proposal names its scheme, group, at least one day and the day it applies from", () => {
    for (const missing of ["routeSchemeId", "collectionGroupId", "serviceDays", "effectiveFrom"]) {
      const body: Record<string, unknown> = { ...PROPOSAL }
      delete body[missing]
      assert.ok(fails(ServiceProviderActivityCreate.safeParse(body)), missing)
    }
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...PROPOSAL, serviceDays: [] })))
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...PROPOSAL, serviceDays: ["wednesday", "wednesday"] })))
  })

  test("a follow-up names its due day, and only a follow-up does", () => {
    const { dueOn: _, ...undated } = FOLLOW_UP
    assert.ok(fails(ServiceProviderActivityCreate.safeParse(undated)))
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...NOTE, dueOn: "2026-11-12" })))
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...FOLLOW_UP, routeSchemeId: ID })))
  })

  test("refuses what the server owns", () => {
    for (const member of [{ number: 1 }, { status: "approved" }, { successorSchemeId: ID }, { openedBy: ID }]) assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...NOTE, ...member })), JSON.stringify(member))
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...NOTE, subject: " " })))
  })
})

describe("a vehicle change", () => {
  test("names its group, its vehicle and its day, its driver where it moves one, and no days", () => {
    assert.deepEqual(ServiceProviderActivityCreate.parse(VEHICLE), VEHICLE)
    assert.equal(ServiceProviderActivityCreate.safeParse({ ...VEHICLE, driverId: OTHER }).success, true)
    const { vehicleId: _, ...unnamed } = VEHICLE
    assert.ok(fails(ServiceProviderActivityCreate.safeParse(unnamed)))
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...VEHICLE, serviceDays: ["monday"] })))
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...PROPOSAL, vehicleId: ID })), "a route-day change names no vehicle")
  })
})

describe("a stop-set change", () => {
  test("names its group, its containers in stop order, each once, at least one, and its day", () => {
    assert.deepEqual(ServiceProviderActivityCreate.parse(STOPS), STOPS)
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...STOPS, containerIds: [] })))
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...STOPS, containerIds: [ID, ID] })))
    assert.ok(fails(ServiceProviderActivityCreate.safeParse({ ...STOPS, vehicleId: ID })), "a stop-set change names no vehicle")
  })
})

describe("a patch", () => {
  test("changes something", () => {
    assert.ok(fails(ServiceProviderActivityPatch.safeParse({})))
    assert.equal(ServiceProviderActivityPatch.safeParse({ subject: "Moved" }).success, true)
    assert.equal(ServiceProviderActivityPatch.safeParse({ serviceDays: ["thursday"], effectiveFrom: "2026-11-11" }).success, true)
    assert.equal(ServiceProviderActivityPatch.safeParse({ body: null, serviceAreaId: null }).success, true)
    assert.equal(ServiceProviderActivityPatch.safeParse({ vehicleId: ID, driverId: null }).success, true)
    assert.equal(ServiceProviderActivityPatch.safeParse({ containerIds: [ID] }).success, true)
    assert.ok(fails(ServiceProviderActivityPatch.safeParse({ containerIds: [] })))
  })

  test("never moves the kind, the provider or the project", () => {
    for (const member of [{ kind: "coordination-note" }, { serviceProviderId: ID }, { projectId: ID }, { status: "approved" }]) assert.ok(fails(ServiceProviderActivityPatch.safeParse(member)), JSON.stringify(member))
  })
})

describe("closing", () => {
  test("a rejection says why; every other close may", () => {
    assert.ok(fails(ActivityReject.safeParse({})))
    assert.equal(ActivityReject.safeParse({ reason: "Wednesday clashes with the market." }).success, true)
    assert.equal(ActivityClose.safeParse({}).success, true)
    assert.equal(ActivityClose.safeParse({ reason: "Document received." }).success, true)
    assert.ok(fails(ActivityClose.safeParse({ status: "completed" })))
  })
})

describe("the resource and its list", () => {
  test("reads an approved proposal with the version it made", () => {
    const row = {
      id: ID,
      createdAt: "2026-11-01T08:00:00.000Z",
      updatedAt: "2026-11-02T08:00:00.000Z",
      projectId: ID,
      number: 1,
      kind: "route-day-change",
      status: "approved",
      serviceProviderId: OTHER,
      serviceAreaId: null,
      subject: "Organic route to Wednesday",
      body: null,
      dueOn: null,
      routeSchemeId: ID,
      collectionGroupId: OTHER,
      serviceDays: ["wednesday"],
      effectiveFrom: "2026-11-04",
      vehicleId: null,
      driverId: null,
      containerIds: null,
      successorSchemeId: OTHER,
      openedBy: ID,
      closedBy: OTHER,
      closedAt: "2026-11-02T08:00:00.000Z",
      closeReason: null,
    }
    assert.deepEqual(ServiceProviderActivity.parse(row), row)
  })

  test("is filtered by provider, kind and status", () => {
    assert.equal(ServiceProviderActivityListQuery.safeParse({ serviceProviderId: ID, kind: "route-day-change", status: "pending-approval" }).success, true)
    assert.ok(fails(ServiceProviderActivityListQuery.safeParse({ status: "overdue" })))
  })
})
