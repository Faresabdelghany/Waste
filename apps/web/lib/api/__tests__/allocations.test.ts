// Vehicle allocations on the adapter (#181, slice 5b of #81): the current
// reservation of a vehicle as the records of `fleet.vehicle-planning`, in the
// shape the scheme-save conflict check reads (Issue #11); `allocate` is the
// create, `change` the edit, `confirm` and `release` the row's commands, and
// the history is the events read. Every body is held against the contracts'
// own zod schemas, and the writes go out through the store's seam over a
// scripted `fetch`.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { VehicleAllocationChange, VehicleAllocationConfirm, VehicleAllocationCreate, VehicleAllocationRelease, type VehicleAllocation, type VehicleAllocationEvent } from "@waste/contracts/allocations"
import type { WasteFraction } from "@waste/contracts/catalogue"
import type { Project } from "@waste/contracts/organisation"
import { allocationConflictSourceFromValues } from "@waste/domain/route-schemes/validation"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext, type Resolver } from "../records/adapter"
import { allocationAdapter, allocationEvents, CONFIRM_ALLOCATION, RELEASE_ALLOCATION, VEHICLE_PLANNING_MODULE, vehiclePlanningModule } from "../records/allocations"
import { wasteFractionAdapter } from "../records/master-data"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { commandRecord, loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }

const fixtures = getModuleDefinition(VEHICLE_PLANNING_MODULE)?.records ?? []
const organisationFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? []
const masterFixtures = getModuleDefinition({ workspaceId: "configure", moduleId: "master" })?.records ?? []

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const residual: WasteFraction = { id: "01a0d2a4-a280-7007-8000-000000000001", ...STAMPS, key: "residual", name: "Residual" }
const wh24 = "01a0d2a4-a280-7019-8000-000000000001"
const wh31 = "01a0d2a4-a280-7019-8000-000000000002"
const mads = "01a0d2a4-a280-7020-8000-000000000001"
const nordhavnDepot = "01a0d2a4-a280-7023-8000-000000000001"

const planned: VehicleAllocation = {
  id: "01a0d2a4-a280-7024-8000-000000000001",
  ...STAMPS,
  projectId: copenhagen.id,
  vehicleId: wh24,
  driverId: mads,
  trailerId: null,
  depotId: nordhavnDepot,
  wasteFractionId: residual.id,
  requiredCapacityKg: 18000,
  // 05:30–16:00 on Copenhagen's clock, summer time.
  plannedFrom: "2026-10-01T03:30:00.000Z",
  plannedTo: "2026-10-01T14:00:00.000Z",
  status: "planned",
  note: "Central residual",
}

// What the store has loaded when allocations load: the organisation, master
// data, and the fleet as 5a's modules answer it (a vehicle and a driver by
// their web ids); the depot is not loaded, so it stays an id chip.
const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: organisationFixtures, resolve: NOTHING_RESOLVED, now: NOW })
const residualRecord = wasteFractionAdapter.toRecord(residual, { fixtures: masterFixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const fleetRecord = (id: string, name: string): BusinessRecord => ({ ...projectRecord, id, name, recordKind: undefined, submittedValues: {} })
const wh24Record = fleetRecord("vehicle-wh24", "WH-24")
const wh31Record = fleetRecord("vehicle-wh31", "WH-31")
const madsRecord = fleetRecord("driver-mads", "Mads Jensen")
const state: ServerRecordsState = new Map([
  ["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)],
  ["configure.master", loaded({ records: [residualRecord], serverIds: new Map([[residualRecord.id, residual.id]]) }, 1)],
  ["fleet.vehicles", loaded({ records: [wh24Record, wh31Record], serverIds: new Map([[wh24Record.id, wh24], [wh31Record.id, wh31]]) }, 1)],
  ["fleet.drivers", loaded({ records: [madsRecord], serverIds: new Map([[madsRecord.id, mads]]) }, 1)],
])
const resolve = resolverOver(state)
const context = (resolver: Resolver = resolve): MappingContext => ({ fixtures, resolve: resolver, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const pageOf = (items: unknown[]) => json({ items, nextCursor: null })
const options = { fixtures, state, now: NOW }

/** A record the allocate dialog makes: the generic create path's id and kind, its values by the form's field ids. */
const allocateRecord = (values: Record<string, string>): BusinessRecord => ({
  ...projectRecord,
  id: "fleet-vehicle-allocation-1759230000000",
  name: "New allocation",
  status: "Planned",
  recordKind: "Vehicle allocation",
  projectIds: values.projectId ? [values.projectId] : [],
  submittedValues: values,
})

describe("the vehicle planning module", () => {
  test("is switched, after the organisation and the master data its rows name", () => {
    assert.ok(isServerBacked("fleet", "vehicle-planning"))
    assert.ok(SERVER_MODULE_KEYS.indexOf("fleet.vehicle-planning") > SERVER_MODULE_KEYS.indexOf("configure.master"))
  })

  test("lists the allocations, every row allocation-<uuid>", async () => {
    const { fetch, calls } = scripted([() => pageOf([planned])])
    const result = await loadModule(clientOver(fetch), vehiclePlanningModule, { fixtures, state, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/vehicle-allocations?limit=200"])
    assert.deepEqual(result.records.map((record) => record.id), [`allocation-${planned.id}`])
  })
})

describe("an allocation", () => {
  const record = allocationAdapter.toRecord(planned, context())

  test("is its day and its vehicle, its driver and window on the project's clock, and the wire's status", () => {
    assert.equal(record.name, "1 Oct · WH-24")
    assert.equal(record.context, "Mads Jensen · 05:30–16:00")
    assert.equal(record.status, "Planned")
    assert.equal(record.value, "18,000 kg")
    assert.equal(record.recordKind, "Vehicle allocation")
    assert.deepEqual(record.projectIds, [projectRecord.id])
    assert.equal(allocationAdapter.statuses, undefined, "the status moves only by confirm and release")
    assert.ok(allocationAdapter.owns(record))
  })

  test("names what it reserves by label where the module is loaded, and by id chip where it is not", () => {
    assert.equal(record.facts.Vehicle, "WH-24")
    assert.equal(record.facts.Driver, "Mads Jensen")
    assert.equal(record.facts.Depot, `depot-${nordhavnDepot}`)
    assert.equal(record.facts["Waste fraction"], "Residual")
    assert.equal(record.facts.Window, "2026-10-01 05:30 – 2026-10-01 16:00")
    assert.equal(record.facts.Note, "Central residual")
  })

  test("carries the typed values the scheme-save conflict check reads, and the form's", () => {
    assert.deepEqual(record.submittedValues, {
      projectId: projectRecord.id,
      vehicleId: "vehicle-wh24",
      driverId: "driver-mads",
      trailerId: "",
      depotId: `depot-${nordhavnDepot}`,
      plannedFraction: residualRecord.id,
      requiredCapacity: "18000",
      plannedStart: "2026-10-01T05:30",
      plannedEnd: "2026-10-01T16:00",
      allocationStatus: "planned",
      note: "Central residual",
      changeReason: "",
    })
    const source = allocationConflictSourceFromValues(record.name, record.status, record.submittedValues)
    assert.equal(source?.vehicleId, "vehicle-wh24")
    assert.equal(source?.plannedStart, "2026-10-01T05:30")
  })

  test("the record the allocate dialog makes becomes the create body the contract accepts, the window read on the project's clock", () => {
    const made = allocateRecord({ projectId: projectRecord.id, vehicleId: "vehicle-wh31", driverId: "driver-mads", depotId: `depot-${nordhavnDepot}`, plannedFraction: residualRecord.id, requiredCapacity: "12000", plannedStart: "2026-11-02T05:30", plannedEnd: "2026-11-02T13:00", allocationStatus: "confirmed", note: "Cover for WH-24" })
    assert.ok(allocationAdapter.owns(made))
    const body = allocationAdapter.toCreateBody?.(made, context())
    assert.deepEqual(body, {
      projectId: copenhagen.id,
      vehicleId: wh31,
      driverId: mads,
      depotId: nordhavnDepot,
      wasteFractionId: residual.id,
      requiredCapacityKg: 12000,
      // Winter time: Copenhagen is an hour ahead of UTC on 2 November.
      plannedFrom: "2026-11-02T04:30:00.000Z",
      plannedTo: "2026-11-02T12:00:00.000Z",
      status: "confirmed",
      note: "Cover for WH-24",
    })
    assert.ok(VehicleAllocationCreate.safeParse(body).success)
    const draft = allocationAdapter.toCreateBody?.(allocateRecord({ projectId: projectRecord.id, vehicleId: "vehicle-wh31", plannedStart: "2026-11-02T05:30", plannedEnd: "2026-11-02T13:00", allocationStatus: "draft" }), context())
    assert.equal((draft as { status?: string }).status, undefined, "the prototype's Draft and Allocated are the wire's planned, its default")
  })

  test("a create is refused here, naming the field", () => {
    const base = { projectId: projectRecord.id, vehicleId: "vehicle-wh31", plannedStart: "2026-11-02T05:30", plannedEnd: "2026-11-02T13:00" }
    assert.deepEqual(allocationAdapter.toCreateBody?.(allocateRecord({ ...base, vehicleId: "" }), context()), { path: "vehicleId", message: "Pick a vehicle the API holds" })
    assert.deepEqual(allocationAdapter.toCreateBody?.(allocateRecord({ ...base, driverId: "driver-freja" }), context()), { path: "driverId", message: "Pick a driver the API holds" })
    assert.deepEqual(allocationAdapter.toCreateBody?.(allocateRecord({ ...base, plannedEnd: "2026-11-02T05:30" }), context()), { path: "plannedEnd", message: "The planned end comes after the planned start" })
    assert.deepEqual(allocationAdapter.toCreateBody?.(allocateRecord({ ...base, plannedStart: "" }), context()), { path: "plannedStart", message: "Give the planned start" })
    assert.deepEqual(allocationAdapter.toCreateBody?.(allocateRecord({ ...base, requiredCapacity: "12.5" }), context()), { path: "requiredCapacity", message: "Required capacity is whole kilograms, 1 or more" })
    assert.deepEqual(allocationAdapter.toCreateBody?.(allocateRecord({ ...base, allocationStatus: "released" }), context()), { path: "allocationStatus", message: "An allocation is released by its release command" })
  })

  test("an edit is the change command: what moved, and the reason, which is the event's", () => {
    const edited: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, vehicleId: "vehicle-wh31", driverId: "", plannedEnd: "2026-10-01T17:00", changeReason: "WH-24 to the workshop" } }
    const body = allocationAdapter.toPatchBody(record, edited, context())
    assert.deepEqual(body, { vehicleId: wh31, driverId: null, plannedTo: "2026-10-01T15:00:00.000Z", reason: "WH-24 to the workshop" })
    assert.ok(VehicleAllocationChange.safeParse(body).success)
    assert.deepEqual(allocationAdapter.toPatchBody(record, { ...edited, submittedValues: { ...edited.submittedValues, changeReason: "" } }, context()), { path: "changeReason", message: "Say why it changes" })
    assert.equal(allocationAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, changeReason: "Nothing" } }, context()), null, "a reason alone changes nothing")
    const moved: BusinessRecord = { ...record, projectIds: ["project-harbor"], submittedValues: { ...record.submittedValues, projectId: "project-harbor", changeReason: "x" } }
    assert.deepEqual(allocationAdapter.toPatchBody(record, moved, context()), { path: "projectId", message: "An allocation stays in its project" })
  })

  test("a change posts to its command path and the answer replaces the row", async () => {
    const edited: BusinessRecord = { ...record, submittedValues: { ...record.submittedValues, note: "Central residual, early", changeReason: "Earlier tipping slot" } }
    const { fetch, calls } = scripted([() => json({ ...planned, note: "Central residual, early" })])
    const current = loaded({ records: [record], serverIds: new Map([[record.id, planned.id]]) }, 1)
    const outcome = await writeRecord(clientOver(fetch), vehiclePlanningModule, current, edited, options)
    assert.equal(calls[0].url, `http://api.test/vehicle-allocations/${planned.id}/change`)
    assert.equal(calls[0].init.method, "POST")
    assert.deepEqual(bodyOf(calls[0]), { note: "Central residual, early", reason: "Earlier tipping slot" })
    assert.equal(outcome.kind, "updated")
    if (outcome.kind !== "updated") return
    assert.equal(outcome.record.facts.Note, "Central residual, early")
  })

  test("a status moved through an edit is refused before the API: confirm and release are commands", async () => {
    const { fetch, calls } = scripted([])
    const current = loaded({ records: [record], serverIds: new Map([[record.id, planned.id]]) }, 1)
    const outcome = await writeRecord(clientOver(fetch), vehiclePlanningModule, current, { ...record, status: "Confirmed" }, options)
    assert.equal(outcome.kind, "refused")
    assert.equal(calls.length, 0)
  })
})

describe("the allocation's commands", () => {
  const record = allocationAdapter.toRecord(planned, context())
  const current = loaded({ records: [record], serverIds: new Map([[record.id, planned.id]]) }, 1)

  test("confirm posts an empty body and the row is confirmed", async () => {
    const { fetch, calls } = scripted([() => json({ ...planned, status: "confirmed" })])
    const outcome = await commandRecord(clientOver(fetch), vehiclePlanningModule, current, record, CONFIRM_ALLOCATION, undefined, options)
    assert.equal(calls[0].url, `http://api.test/vehicle-allocations/${planned.id}/confirm`)
    assert.deepEqual(bodyOf(calls[0]), {})
    assert.ok(VehicleAllocationConfirm.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Confirmed")
  })

  test("release carries its reason; without one it is refused here", async () => {
    const { fetch, calls } = scripted([() => json({ ...planned, status: "released" })])
    const outcome = await commandRecord(clientOver(fetch), vehiclePlanningModule, current, record, RELEASE_ALLOCATION, { reason: "Route cancelled" }, options)
    assert.equal(calls[0].url, `http://api.test/vehicle-allocations/${planned.id}/release`)
    assert.deepEqual(bodyOf(calls[0]), { reason: "Route cancelled" })
    assert.ok(VehicleAllocationRelease.safeParse(bodyOf(calls[0])).success)
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.status, "Released")
    assert.deepEqual(allocationAdapter.commands?.[RELEASE_ALLOCATION]?.toBody?.({ reason: "" }, record, context()), { path: "reason", message: "Say why it is released" })
  })

  test("the API's 409 on a released allocation comes back as its sentence", async () => {
    const detail = "A released allocation does not change; allocate the vehicle again"
    const { fetch } = scripted([() => problem(409, detail)])
    const outcome = await commandRecord(clientOver(fetch), vehiclePlanningModule, current, record, CONFIRM_ALLOCATION, undefined, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(problemSentence(outcome.problem), detail)
    assert.equal(outcome.what, "1 Oct · WH-24 was not confirmed")
  })

  test("the history is the events read, oldest first", async () => {
    const event: VehicleAllocationEvent = { id: "01a0d2a4-a280-7025-8000-000000000001", recordedAt: STAMPS.createdAt, projectId: copenhagen.id, vehicleAllocationId: planned.id, action: "allocate", status: "planned", vehicleId: wh24, driverId: mads, trailerId: null, depotId: nordhavnDepot, plannedFrom: planned.plannedFrom, plannedTo: planned.plannedTo, reason: null, recordedBy: "01a0d2a4-a280-7005-8000-000000000001" }
    const { fetch, calls } = scripted([() => pageOf([event])])
    assert.deepEqual(await allocationEvents(clientOver(fetch), planned.id), [event])
    assert.equal(calls[0].url, `http://api.test/vehicle-allocations/${planned.id}/events?limit=200`)
  })
})
