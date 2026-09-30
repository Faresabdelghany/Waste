// The route's and the stop's dialogs on the Pilot (Issue #179): every
// command's dialog names its fields by the keys the command's `toBody` reads,
// and opens on what the route holds, so what a person fills in is the body
// the contract accepts — held here through the adapters themselves.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Driver } from "@waste/contracts/fleet"
import { PickupCorrection, PickupRemove, type Pickup } from "@waste/contracts/pickups"
import { RouteAssign, RouteCancel, RouteReschedule, type Route } from "@waste/contracts/routes"
import { PICKUP_OUTCOMES } from "@waste/domain/execution/vocabulary"

import { NOTHING_RESOLVED, type MappingContext } from "../../api/records/adapter"
import { driverAdapter } from "../../api/records/fleet"
import { CORRECT_PICKUP, pickupAdapter, REMOVE_PICKUP } from "../../api/records/pickups"
import { ASSIGN_ROUTE, CANCEL_ROUTE, RESCHEDULE_ROUTE, routeAdapter } from "../../api/records/routes"
import { loaded, resolverOver, type ServerRecordsState } from "../../api/records/server-records"
import { DEPOTS_MODULE, DRIVERS_MODULE, VEHICLES_MODULE } from "../allocations"
import { FIXTURE_COMPANY_ID } from "../business-modules"
import type { BusinessFormSchema } from "../business-form-types"
import { PICKUP_COMMAND_FORMS, ROUTE_COMMAND_FORMS, routeCommandValues } from "../routes"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-29T02:00:00.000Z", updatedAt: "2026-09-29T02:00:00.000Z" }
const route: Route = {
  id: "01a0d2a4-a280-7030-8000-000000000001",
  ...STAMPS,
  projectId: "01a0d2a4-a280-7002-8000-000000000001",
  routeSchemeId: "01a0d2a4-a280-7016-8000-000000000001",
  collectionGroupId: "01a0d2a4-a280-7017-8000-000000000001",
  serviceDate: "2026-10-01",
  operatingDate: "2026-10-01",
  number: 1042,
  label: "RC-1042",
  status: "planned",
  note: null,
  cancelledByGeneration: false,
  generationRunId: null,
  plannedStartTime: "06:30",
  planned: { vehicleId: "01a0d2a4-a280-7013-8000-000000000001", driverId: "01a0d2a4-a280-7014-8000-000000000001", trailerId: null, serviceProviderId: null, depotId: null, unloadingStationId: null },
  actual: { vehicleId: null, driverId: null, trailerId: null },
  dispatchedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  progress: { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 },
}
const freja: Driver = { id: "01a0d2a4-a280-7014-8000-000000000002", ...STAMPS, projectId: route.projectId, name: "Freja Nielsen", workforceReference: null, employment: "employee", serviceProviderId: null, homeDepotId: null, licenceClass: "ce", licenceNumber: null, licenceExpiry: null, userAccountId: null, status: "active", notes: null }
const frejaRecord = driverAdapter.toRecord(freja, { fixtures: [], resolve: NOTHING_RESOLVED, now: NOW })
const state: ServerRecordsState = new Map([["fleet.drivers", loaded({ records: [frejaRecord], serverIds: new Map([[frejaRecord.id, freja.id]]) }, 1)]])
const context: MappingContext = { fixtures: [], resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const record = routeAdapter.toRecord(route, context)

const fieldIdsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))
const requiredOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.filter((field) => field.required).map((field) => field.id))
const fieldOf = (schema: BusinessFormSchema, id: string) => schema.sections.flatMap((section) => section.fields).find((field) => field.id === id)

describe("the route's dialogs", () => {
  test("assign names the Planned Assignment's five fields, each a picker of the module that holds it, none required", () => {
    const form = ROUTE_COMMAND_FORMS[ASSIGN_ROUTE]
    assert.deepEqual(fieldIdsOf(form), ["vehicleId", "driverId", "trailerId", "depotId", "unloadingStationId"])
    assert.deepEqual(requiredOf(form), [])
    assert.deepEqual(fieldOf(form, "vehicleId")?.relation, VEHICLES_MODULE)
    assert.deepEqual(fieldOf(form, "driverId")?.relation, DRIVERS_MODULE)
    assert.deepEqual(fieldOf(form, "trailerId")?.relation, VEHICLES_MODULE)
    assert.deepEqual(fieldOf(form, "depotId")?.relation, DEPOTS_MODULE)
    assert.deepEqual(fieldOf(form, "unloadingStationId")?.relation, DEPOTS_MODULE)
  })

  test("the dialogs open on what the route holds, and a moved driver is the assign body the contract accepts", () => {
    const values = routeCommandValues(record)
    assert.deepEqual(values, {
      vehicleId: `vehicle-${route.planned.vehicleId}`,
      driverId: `driver-${route.planned.driverId}`,
      trailerId: "",
      depotId: "",
      unloadingStationId: "",
      operatingDate: "2026-10-01",
      plannedStartTime: "06:30",
    })
    const body = routeAdapter.commands?.[ASSIGN_ROUTE]?.toBody?.({ ...values, driverId: frejaRecord.id }, record, context)
    assert.deepEqual(body, { driverId: freja.id })
    assert.ok(RouteAssign.safeParse(body).success)
  })

  test("reschedule names the day it runs, required, and its planned start", () => {
    const form = ROUTE_COMMAND_FORMS[RESCHEDULE_ROUTE]
    assert.deepEqual(fieldIdsOf(form), ["operatingDate", "plannedStartTime"])
    assert.deepEqual(requiredOf(form), ["operatingDate"])
    assert.equal(fieldOf(form, "operatingDate")?.type, "date")
    assert.equal(fieldOf(form, "plannedStartTime")?.type, "time")
    const body = routeAdapter.commands?.[RESCHEDULE_ROUTE]?.toBody?.({ ...routeCommandValues(record), operatingDate: "2026-10-02" }, record, context)
    assert.deepEqual(body, { operatingDate: "2026-10-02" })
    assert.ok(RouteReschedule.safeParse(body).success)
  })

  test("cancel asks why, and the reason is the body", () => {
    const form = ROUTE_COMMAND_FORMS[CANCEL_ROUTE]
    assert.deepEqual(fieldIdsOf(form), ["reason"])
    assert.deepEqual(requiredOf(form), ["reason"])
    const body = routeAdapter.commands?.[CANCEL_ROUTE]?.toBody?.({ reason: "Road closed" }, record, context)
    assert.ok(RouteCancel.safeParse(body).success)
  })
})

describe("the stop's dialogs", () => {
  const pickup: Pickup = { id: "01a0d2a4-a280-7033-8000-000000000001", ...STAMPS, projectId: route.projectId, routeId: route.id, containerId: "01a0d2a4-a280-7014-8000-000000000009", position: 1, status: "completed", reason: null, note: null, propertyId: null, sharedCollectionPointId: "01a0d2a4-a280-7019-8000-000000000001", wasteFractionId: "01a0d2a4-a280-7005-8000-000000000001", arrivedAt: null, outcomeAt: "2026-10-01T05:00:00.000Z" }
  const stop = pickupAdapter.toRecord(pickup, context)

  test("remove asks why", () => {
    const form = PICKUP_COMMAND_FORMS[REMOVE_PICKUP]
    assert.deepEqual(fieldIdsOf(form), ["reason"])
    assert.deepEqual(requiredOf(form), ["reason"])
    assert.ok(PickupRemove.safeParse(pickupAdapter.commands?.[REMOVE_PICKUP]?.toBody?.({ reason: "Blocked" }, stop, context)).success)
  })

  test("a correction offers the three outcomes, a reason only with a miss, and why", () => {
    const form = PICKUP_COMMAND_FORMS[CORRECT_PICKUP]
    assert.deepEqual(fieldIdsOf(form), ["outcome", "reason", "note"])
    assert.deepEqual(requiredOf(form), ["outcome", "note"])
    assert.deepEqual(fieldOf(form, "outcome")?.options?.map((option) => option.value), [...PICKUP_OUTCOMES])
    assert.deepEqual(fieldOf(form, "reason")?.visibleWhen, { fieldId: "outcome", oneOf: ["skipped", "failed"] })
    assert.deepEqual(fieldOf(form, "reason")?.requiredWhen, { fieldId: "outcome", oneOf: ["skipped", "failed"] })
    const body = pickupAdapter.commands?.[CORRECT_PICKUP]?.toBody?.({ outcome: "failed", reason: "inaccessible", note: "Gate locked" }, stop, context)
    assert.deepEqual(body, { outcome: "failed", reason: "inaccessible", note: "Gate locked" })
    assert.ok(PickupCorrection.safeParse(body).success)
  })
})
