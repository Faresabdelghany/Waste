// The route's and the stop's dialogs on the Pilot (Issue #179): every
// command's dialog names its fields by the keys the command's `toBody` reads,
// and opens on what the route holds, so what a person fills in is the body
// the contract accepts — held here through the adapters themselves.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Driver } from "@waste/contracts/fleet"
import { A_WORK_ORDER_OF_A_CONTAINER, PickupAdd, PickupCorrection, PickupRemove, type Pickup } from "@waste/contracts/pickups"
import { RouteAssign, RouteCancel, RouteReschedule, type Route } from "@waste/contracts/routes"
import { OFFICE_CANCEL_REASON_CODES, PICKUP_OUTCOMES } from "@waste/domain/execution/vocabulary"

import { NOTHING_RESOLVED, type MappingContext } from "../../api/records/adapter"
import { driverAdapter } from "../../api/records/fleet"
import { CORRECT_PICKUP, pickupAdapter, REMOVE_PICKUP } from "../../api/records/pickups"
import { CONTAINERS_MODULE } from "../../api/records/containers"
import { ADD_STOP, ASSIGN_ROUTE, CANCEL_ROUTE, RESCHEDULE_ROUTE, routeAdapter } from "../../api/records/routes"
import { loaded, resolverOver, type ServerRecordsState } from "../../api/records/server-records"
import { AGREEMENTS_MODULE } from "../agreements"
import { DEPOTS_MODULE, DRIVERS_MODULE, isTrailerRecord, VEHICLES_MODULE } from "../allocations"
import { FIXTURE_COMPANY_ID, type BusinessRecord } from "../business-modules"
import type { BusinessFormSchema } from "../business-form-types"
import { WAREHOUSES_MODULE } from "../containers"
import { MASTER_DATA_MODULE } from "../master-data"
import { ORGANISATION_MODULE } from "../containers"
import { PROPERTIES_MODULE, SHARED_POINTS_MODULE } from "../properties"
import { A_WORK_ORDER_IS_OF_A_CONTAINER } from "../pickup-services"
import { SERVICE_PROVIDERS_MODULE } from "../provider-money"
import { createRouteRecord, DISPATCH_DAY_FORM, dispatchDayRows, PICKUP_COMMAND_FORMS, ROUTE_COMMAND_FORMS, ROUTE_CREATE_FORM, routeCommandValues, routesToJoin } from "../routes"

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
  cancelReasonCode: null,
  cancelledByGeneration: false,
  generationRunId: null,
  plannedStartTime: "06:30",
  planned: { vehicleId: "01a0d2a4-a280-7013-8000-000000000001", driverId: "01a0d2a4-a280-7014-8000-000000000001", trailerId: null, serviceProviderId: null, depotId: null, unloadingStationId: null },
  heldAt: null,
  actual: { vehicleId: null, driverId: null, trailerId: null },
  dispatchedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: null,
  progress: { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 },
}
const freja: Driver = { id: "01a0d2a4-a280-7014-8000-000000000002", ...STAMPS, projectId: route.projectId, name: "Freja Nielsen", workforceReference: null, employment: "employee", serviceProviderId: null, homeDepotId: null, licenceClass: "ce", licenceNumber: null, licenceExpiry: null, userAccountId: null, status: "active", notes: null, shift: null }
const frejaRecord = driverAdapter.toRecord(freja, { fixtures: [], resolve: NOTHING_RESOLVED, now: NOW })
const state: ServerRecordsState = new Map([["fleet.drivers", loaded({ records: [frejaRecord], serverIds: new Map([[frejaRecord.id, freja.id]]) }, 1)]])
const context: MappingContext = { fixtures: [], resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const record = routeAdapter.toRecord(route, context)

const fieldIdsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))
const requiredOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.filter((field) => field.required).map((field) => field.id))
const fieldOf = (schema: BusinessFormSchema, id: string) => schema.sections.flatMap((section) => section.fields).find((field) => field.id === id)

describe("the vehicle pickers", () => {
  const row = (id: string, submittedValues?: BusinessRecord["submittedValues"]): BusinessRecord => ({ id, name: id, context: "", status: "Active", owner: "", value: "", updated: "", description: "", facts: {}, related: [], source: "", freshness: "", submittedValues })

  test("a trailer is told by its typed kind — the server's rows, the fixture form's — else by the fixture id's prefix, so Vehicle offers no trailer and Trailer nothing else", () => {
    assert.equal(isTrailerRecord(row("vehicle-01a0d2a4", { resourceKind: "trailer" })), true)
    assert.equal(isTrailerRecord(row("vehicle-01a0d2a5", { resourceKind: "powered-vehicle" })), false)
    assert.equal(isTrailerRecord(row("trailer-wh12", { requiredLicenceClass: "CE" })), true)
    assert.equal(isTrailerRecord(row("vehicle-wh24", { requiredLicenceClass: "C" })), false)
  })
})

describe("the route's dialogs", () => {
  test("assign names the Planned Assignment's six fields, each a picker of the module that holds it, none required — the service provider since O5 of #290 — and whether the crew's same day is meant (O7 of #290)", () => {
    const form = ROUTE_COMMAND_FORMS[ASSIGN_ROUTE]
    assert.deepEqual(fieldIdsOf(form), ["vehicleId", "driverId", "trailerId", "serviceProviderId", "depotId", "unloadingStationId", "acceptSameDay"])
    assert.deepEqual([fieldOf(form, "acceptSameDay")?.type, fieldOf(form, "acceptSameDay")?.defaultValue], ["checkbox", false])
    assert.deepEqual(fieldOf(form, "serviceProviderId")?.relation, SERVICE_PROVIDERS_MODULE)
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
      serviceProviderId: "",
      depotId: "",
      unloadingStationId: "",
      operatingDate: "2026-10-01",
      plannedStartTime: "06:30",
    })
    const body = routeAdapter.commands?.[ASSIGN_ROUTE]?.toBody?.({ ...values, driverId: frejaRecord.id }, record, context)
    assert.deepEqual(body, { driverId: freja.id })
    assert.ok(RouteAssign.safeParse(body).success)
  })

  test("reschedule names the day it runs, required, its planned start, and whether a non-working day is meant (O5 of #290)", () => {
    const form = ROUTE_COMMAND_FORMS[RESCHEDULE_ROUTE]
    assert.deepEqual(fieldIdsOf(form), ["operatingDate", "plannedStartTime", "acceptNonWorkingDay", "acceptSameDay"])
    assert.deepEqual([fieldOf(form, "acceptNonWorkingDay")?.type, fieldOf(form, "acceptNonWorkingDay")?.defaultValue], ["checkbox", false])
    const knowingly = routeAdapter.commands?.[RESCHEDULE_ROUTE]?.toBody?.({ ...routeCommandValues(record), operatingDate: "2026-10-03", acceptNonWorkingDay: true }, record, context)
    assert.ok(RouteReschedule.safeParse(knowingly).success, JSON.stringify(knowingly))
    assert.deepEqual(requiredOf(form), ["operatingDate"])
    assert.equal(fieldOf(form, "operatingDate")?.type, "date")
    assert.equal(fieldOf(form, "plannedStartTime")?.type, "time")
    const body = routeAdapter.commands?.[RESCHEDULE_ROUTE]?.toBody?.({ ...routeCommandValues(record), operatingDate: "2026-10-02" }, record, context)
    assert.deepEqual(body, { operatingDate: "2026-10-02" })
    assert.ok(RouteReschedule.safeParse(body).success)
  })

  test("New route names the project and the day, required, and the optional ends, crew and note; the routes adapter owns the record it makes (#111)", () => {
    assert.deepEqual(fieldIdsOf(ROUTE_CREATE_FORM), ["projectId", "operatingDate", "depotId", "unloadingStationId", "vehicleId", "driverId", "note", "acceptSameDay"])
    assert.deepEqual(requiredOf(ROUTE_CREATE_FORM), ["projectId", "operatingDate"])
    assert.equal(ROUTE_CREATE_FORM.mode, "create")
    assert.ok(routeAdapter.owns(createRouteRecord({ operatingDate: "2026-10-06" }, { now: 1 })), "the routes adapter owns what New route makes; routes.test.ts holds its body to the contract")
  })

  test("Add stop asks what it collects at, then the container, or the property or the shared point with its fraction, each shown only for its choice, and a note (#111)", () => {
    const form = ROUTE_COMMAND_FORMS["add-stop"]
    assert.deepEqual(fieldIdsOf(form), ["service", "stopAt", "bulkyBookingId", "containerId", "subscriptionId", "deliveryFractionId", "replacementContainerId", "warehouseId", "propertyId", "sharedCollectionPointId", "wasteFractionId", "note"])
    assert.deepEqual(requiredOf(form), ["stopAt"])
    assert.deepEqual(fieldOf(form, "service")?.requiredWhen, { fieldId: "stopAt", notIn: ["bulky-booking"] }, "a bulky booking's stop is a bulky collection")
    assert.deepEqual(fieldOf(form, "bulkyBookingId")?.requiredWhen, { fieldId: "stopAt", equals: "bulky-booking" })
    assert.equal(fieldOf(form, "stopAt")?.defaultValue, "container")
    assert.deepEqual(fieldOf(form, "containerId")?.relation, CONTAINERS_MODULE)
    assert.deepEqual(fieldOf(form, "propertyId")?.relation, PROPERTIES_MODULE)
    assert.deepEqual(fieldOf(form, "sharedCollectionPointId")?.relation, SHARED_POINTS_MODULE)
    assert.deepEqual(fieldOf(form, "wasteFractionId")?.relation, MASTER_DATA_MODULE)
    assert.deepEqual(fieldOf(form, "wasteFractionId")?.requiredWhen, { fieldId: "stopAt", oneOf: ["property", "shared-point"] })
    const atAProperty = routeAdapter.commands?.[ADD_STOP]?.toBody?.({ stopAt: "property", propertyId: "property-01a0d2a4-a280-7011-8000-000000000001", wasteFractionId: "fraction-01a0d2a4-a280-7005-8000-000000000001", note: "Re-collection" }, record, context)
    assert.ok(PickupAdd.safeParse(atAProperty).success, JSON.stringify(atAProperty))
    // It opens empty but for its choice's default: nothing of the route's own values belongs in it.
    assert.deepEqual(Object.keys(routeCommandValues(record)).filter((key) => fieldIdsOf(form).includes(key)), [])
  })

  test("Add stop books an emptying unless it says a work order, each of a container; an emptying's body says no service, the API's default (O3 of #290)", () => {
    const form = ROUTE_COMMAND_FORMS["add-stop"]
    assert.equal(fieldOf(form, "service")?.defaultValue, "empty")
    assert.deepEqual(fieldOf(form, "service")?.options?.map((option) => [option.value, option.label]), [
      ["empty", "Emptying"],
      ["deliver", "Delivery"],
      ["remove", "Removal"],
      ["swap", "Swap"],
      ["repair", "Repair"],
      ["wash", "Wash"],
    ])
    const toBody = (input: Record<string, unknown>) => routeAdapter.commands?.[ADD_STOP]?.toBody?.(input, record, context)
    const atAProperty = { stopAt: "property", propertyId: "property-01a0d2a4-a280-7011-8000-000000000001", wasteFractionId: "fraction-01a0d2a4-a280-7005-8000-000000000001" }
    assert.equal((toBody({ ...atAProperty, service: "empty" }) as Record<string, unknown>).service, undefined, "an emptying is the API's default")
    assert.deepEqual(toBody({ ...atAProperty, service: "wash" }), { path: "stopAt", message: A_WORK_ORDER_IS_OF_A_CONTAINER })
    assert.equal(A_WORK_ORDER_IS_OF_A_CONTAINER, A_WORK_ORDER_OF_A_CONTAINER, "one sentence, whichever side refuses")
    assert.deepEqual(toBody({ ...atAProperty, service: "deliver" }), { path: "stopAt", message: A_WORK_ORDER_IS_OF_A_CONTAINER })
    assert.deepEqual(toBody({ ...atAProperty, service: "sweep" }), { path: "service", message: "Book an emptying or one of the work orders offered" })
  })

  test("Add stop books a delivery under a subscription, a removal back to a warehouse and a swap for a container from stock, each field shown and asked for its service alone (O3b of #290)", () => {
    const form = ROUTE_COMMAND_FORMS["add-stop"]
    assert.deepEqual(fieldOf(form, "subscriptionId")?.relation, AGREEMENTS_MODULE)
    assert.deepEqual(fieldOf(form, "subscriptionId")?.requiredWhen, { fieldId: "service", equals: "deliver" })
    assert.deepEqual(fieldOf(form, "deliveryFractionId")?.relation, MASTER_DATA_MODULE)
    assert.deepEqual(fieldOf(form, "deliveryFractionId")?.visibleWhen, { fieldId: "service", equals: "deliver" })
    assert.equal(fieldOf(form, "deliveryFractionId")?.requiredWhen, undefined, "blank takes the subscription product's fraction")
    assert.deepEqual(fieldOf(form, "replacementContainerId")?.relation, CONTAINERS_MODULE)
    assert.deepEqual(fieldOf(form, "replacementContainerId")?.requiredWhen, { fieldId: "service", equals: "swap" })
    assert.deepEqual(fieldOf(form, "warehouseId")?.relation, WAREHOUSES_MODULE)
    assert.deepEqual(fieldOf(form, "warehouseId")?.requiredWhen, { fieldId: "service", oneOf: ["remove", "swap"] })
    for (const id of ["subscriptionId", "replacementContainerId", "warehouseId"]) assert.deepEqual(fieldOf(form, id)?.visibleWhen, fieldOf(form, id)?.requiredWhen, id)

    const toBody = (input: Record<string, unknown>) => routeAdapter.commands?.[ADD_STOP]?.toBody?.(input, record, context)
    const bin = "01a0d2a4-a280-7014-8000-000000000009"
    const replacement = "01a0d2a4-a280-7014-8000-000000000010"
    const subscription = "01a0d2a4-a280-7021-8000-000000000001"
    const warehouse = "01a0d2a4-a280-7008-8000-000000000001"
    const fraction = "01a0d2a4-a280-7005-8000-000000000001"
    // Whatever a hidden field still holds is not read: the delivery's fields under a swap, an address under a delivery.
    const filled = { stopAt: "container", containerId: `asset-${bin}`, subscriptionId: `subscription-${subscription}`, replacementContainerId: `asset-${replacement}`, warehouseId: `warehouse-${warehouse}`, propertyId: "property-01a0d2a4-a280-7011-8000-000000000001", wasteFractionId: `fraction-${fraction}` }
    const delivery = toBody({ ...filled, service: "deliver" })
    assert.deepEqual(delivery, { service: "deliver", containerId: bin, subscriptionId: subscription })
    assert.deepEqual(toBody({ ...filled, service: "deliver", deliveryFractionId: `fraction-${fraction}` }), { service: "deliver", containerId: bin, subscriptionId: subscription, wasteFractionId: fraction })
    const removal = toBody({ ...filled, service: "remove" })
    assert.deepEqual(removal, { service: "remove", containerId: bin, warehouseId: warehouse })
    const swap = toBody({ ...filled, service: "swap", note: "Bring the 370 l" })
    assert.deepEqual(swap, { service: "swap", containerId: bin, replacementContainerId: replacement, warehouseId: warehouse, note: "Bring the 370 l" })
    for (const body of [delivery, removal, swap]) assert.ok(PickupAdd.safeParse(body).success, JSON.stringify(body))

    const atBin = { stopAt: "container", containerId: `asset-${bin}` }
    assert.deepEqual(toBody({ ...atBin, service: "deliver" }), { path: "subscriptionId", message: "Pick the subscription it will serve under" })
    assert.deepEqual(toBody({ ...atBin, service: "deliver", subscriptionId: "subscription-sub-1" }), { path: "subscriptionId", message: "Pick a subscription the API holds" })
    assert.deepEqual(toBody({ ...atBin, service: "remove" }), { path: "warehouseId", message: "Pick the warehouse it goes back to" })
    assert.deepEqual(toBody({ ...atBin, service: "swap", warehouseId: `warehouse-${warehouse}` }), { path: "replacementContainerId", message: "Pick the container that replaces it" })
    assert.deepEqual(toBody({ ...atBin, service: "swap", replacementContainerId: `asset-${replacement}`, warehouseId: "warehouse-1" }), { path: "warehouseId", message: "Pick a warehouse the API holds" })
  })

  test("cancel asks why as one of the office's codes, and in words; the two are the body (O5 of #290)", () => {
    const form = ROUTE_COMMAND_FORMS[CANCEL_ROUTE]
    assert.deepEqual(fieldIdsOf(form), ["reasonCode", "reason"])
    assert.deepEqual(requiredOf(form), ["reasonCode", "reason"])
    assert.deepEqual(fieldOf(form, "reasonCode")?.options?.map((option) => option.value), [...OFFICE_CANCEL_REASON_CODES])
    assert.equal(fieldOf(form, "reasonCode")?.options?.[0]?.label, "Vehicle breakdown")
    const body = routeAdapter.commands?.[CANCEL_ROUTE]?.toBody?.({ reasonCode: "road-closure", reason: "Road closed" }, record, context)
    assert.ok(RouteCancel.safeParse(body).success)
  })

  test("Dispatch day asks for the project and the day, then offers the project's planned routes of that day by number (O5 of #290)", () => {
    assert.deepEqual(fieldIdsOf(DISPATCH_DAY_FORM), ["projectId", "operatingDate"])
    assert.deepEqual(requiredOf(DISPATCH_DAY_FORM), ["projectId", "operatingDate"])
    assert.deepEqual(fieldOf(DISPATCH_DAY_FORM, "projectId")?.relation, ORGANISATION_MODULE)
    const projectId = record.projectIds?.[0] ?? ""
    const at = (name: string, values: Record<string, string>, projectIds = [projectId]): BusinessRecord => ({ ...record, id: `route-${name}`, name, projectIds, submittedValues: { ...record.submittedValues, ...values } })
    const rows = [
      at("RC-1010", { operatingDate: "2026-10-01", status: "planned" }),
      at("RC-1002", { operatingDate: "2026-10-01", status: "planned" }),
      at("RC-1003", { operatingDate: "2026-10-01", status: "ready" }),
      at("RC-1004", { operatingDate: "2026-10-02", status: "planned" }),
      at("RC-1005", { operatingDate: "2026-10-01", status: "planned" }, ["project-elsewhere"]),
    ]
    assert.deepEqual(dispatchDayRows(rows, projectId, "2026-10-01").map((row) => row.name), ["RC-1002", "RC-1010"], "a ready one is dispatched already, another day's and another project's are not this day's")
    assert.deepEqual(dispatchDayRows(rows, undefined, "2026-10-01"), [])
    assert.deepEqual(dispatchDayRows(rows, projectId, ""), [])
  })
})

describe("the routes a route's stops may join (O23 of #290)", () => {
  test("are the project's other routes that have not started, by day and then by number", () => {
    const projectId = record.projectIds?.[0] ?? ""
    const at = (name: string, values: Record<string, string>, projectIds = [projectId]): BusinessRecord => ({ ...record, id: `route-${name}`, name, projectIds, submittedValues: { ...record.submittedValues, ...values } })
    const rows = [
      record,
      at("RC-1010", { operatingDate: "2026-10-01", status: "planned" }),
      at("RC-1002", { operatingDate: "2026-10-02", status: "ready" }),
      at("RC-1003", { operatingDate: "2026-10-01", status: "ready" }),
      at("RC-1004", { operatingDate: "2026-10-01", status: "active" }),
      at("RC-1006", { operatingDate: "2026-10-01", status: "cancelled" }),
      at("RC-1005", { operatingDate: "2026-10-01", status: "planned" }, ["project-elsewhere"]),
    ]
    assert.deepEqual(
      routesToJoin(rows, record).map((row) => row.name),
      ["RC-1003", "RC-1010", "RC-1002"],
      "never itself, one that runs or ended, or another project's",
    )
    assert.deepEqual(routesToJoin(rows, { ...record, projectIds: undefined }), [])
  })
})

describe("the stop's dialogs", () => {
  const pickup: Pickup = { id: "01a0d2a4-a280-7033-8000-000000000001", ...STAMPS, projectId: route.projectId, routeId: route.id, containerId: "01a0d2a4-a280-7014-8000-000000000009", position: 1, status: "completed", origin: "generation", service: "empty", reason: null, contaminantCodeId: null, note: null, propertyId: null, sharedCollectionPointId: "01a0d2a4-a280-7019-8000-000000000001", wasteFractionId: "01a0d2a4-a280-7005-8000-000000000001", subscriptionId: null, warehouseId: null, replacementContainerId: null, bulkyBookingId: null, movedFromPickupId: null, arrivedAt: null, outcomeAt: "2026-10-01T05:00:00.000Z" }
  const stop = pickupAdapter.toRecord(pickup, context)

  test("remove asks why", () => {
    const form = PICKUP_COMMAND_FORMS[REMOVE_PICKUP]
    assert.deepEqual(fieldIdsOf(form), ["reason"])
    assert.deepEqual(requiredOf(form), ["reason"])
    assert.ok(PickupRemove.safeParse(pickupAdapter.commands?.[REMOVE_PICKUP]?.toBody?.({ reason: "Blocked" }, stop, context)).success)
  })

  test("a correction offers the three outcomes, a reason only with a miss, why, and the contaminant code the stop is tagged with", () => {
    const form = PICKUP_COMMAND_FORMS[CORRECT_PICKUP]
    assert.deepEqual(fieldIdsOf(form), ["outcome", "reason", "note", "contaminantCodeId"])
    assert.deepEqual(requiredOf(form), ["outcome", "note"])
    // M5 of #293: the code is picked from the master data, optional, None untagging it.
    assert.deepEqual(fieldOf(form, "contaminantCodeId")?.relation, MASTER_DATA_MODULE)
    assert.deepEqual(fieldOf(form, "outcome")?.options?.map((option) => option.value), [...PICKUP_OUTCOMES])
    assert.deepEqual(fieldOf(form, "reason")?.visibleWhen, { fieldId: "outcome", oneOf: ["skipped", "failed"] })
    assert.deepEqual(fieldOf(form, "reason")?.requiredWhen, { fieldId: "outcome", oneOf: ["skipped", "failed"] })
    // The reasons in the Driver App's words (lib/driver/route-view.ts), the system's four spelled out.
    const reasons = new Map(fieldOf(form, "reason")?.options?.map((option) => [option.value, option.label]))
    assert.equal(reasons.get("capacity"), "Over capacity")
    assert.equal(reasons.get("not-presented"), "Not presented")
    assert.equal(reasons.get("route-cancelled"), "Route cancelled")
    const body = pickupAdapter.commands?.[CORRECT_PICKUP]?.toBody?.({ outcome: "failed", reason: "inaccessible", note: "Gate locked" }, stop, context)
    assert.deepEqual(body, { outcome: "failed", reason: "inaccessible", note: "Gate locked" })
    assert.ok(PickupCorrection.safeParse(body).success)
  })
})
