// The allocation's forms on the Pilot (Issue #181): allocate, change and
// release name their fields by the keys the adapter reads, so what a planner
// fills in is the body the contract accepts — held here through the adapter.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { VehicleAllocationChange, VehicleAllocationCreate, VehicleAllocationRelease, type VehicleAllocation } from "@waste/contracts/allocations"
import type { Project } from "@waste/contracts/organisation"

import { NOTHING_RESOLVED, type MappingContext } from "../../api/records/adapter"
import { allocationAdapter, RELEASE_ALLOCATION } from "../../api/records/allocations"
import { projectAdapter } from "../../api/records/organisation"
import { loaded, resolverOver, type ServerRecordsState } from "../../api/records/server-records"
import { ALLOCATE_FORM, allocationChangeForm, allocationFormValues, changedAllocationRecord, createAllocationRecord, RELEASE_FORM } from "../allocations"
import type { BusinessFormSchema } from "../business-form-types"
import { FIXTURE_COMPANY_ID, getModuleDefinition } from "../business-modules"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" }
const wh24 = "01a0d2a4-a280-7019-8000-000000000001"
const projectRecord = projectAdapter.toRecord(copenhagen, { fixtures: getModuleDefinition({ workspaceId: "configure", moduleId: "organization" })?.records ?? [], resolve: NOTHING_RESOLVED, now: NOW })
const state: ServerRecordsState = new Map([["configure.organization", loaded({ records: [projectRecord], serverIds: new Map([[projectRecord.id, copenhagen.id]]) }, 1)]])
const context: MappingContext = { fixtures: [], resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW }
const fieldIdsOf = (schema: BusinessFormSchema) => schema.sections.flatMap((section) => section.fields.map((field) => field.id))

const planned: VehicleAllocation = { id: "01a0d2a4-a280-7024-8000-000000000001", ...STAMPS, projectId: copenhagen.id, vehicleId: wh24, driverId: null, trailerId: null, depotId: null, wasteFractionId: null, requiredCapacityKg: null, plannedFrom: "2026-10-01T03:30:00.000Z", plannedTo: "2026-10-01T14:00:00.000Z", status: "planned", note: null }

describe("the allocation's forms on the Pilot", () => {
  test("allocate names the fields the create reads, and what it makes is the body the contract accepts", () => {
    assert.deepEqual(fieldIdsOf(ALLOCATE_FORM), ["projectId", "vehicleId", "driverId", "trailerId", "depotId", "plannedFraction", "requiredCapacity", "plannedStart", "plannedEnd", "allocationStatus", "note"])
    const record = createAllocationRecord({ projectId: projectRecord.id, vehicleId: `vehicle-${wh24}`, driverId: "", trailerId: "", depotId: "", plannedFraction: "", requiredCapacity: "", plannedStart: "2026-10-02T06:00", plannedEnd: "2026-10-02T14:00", allocationStatus: "planned", note: "Spare run" }, { now: 1 })
    assert.ok(allocationAdapter.owns(record))
    const body = allocationAdapter.toCreateBody?.(record, context)
    assert.deepEqual(body, { projectId: copenhagen.id, vehicleId: wh24, plannedFrom: "2026-10-02T04:00:00.000Z", plannedTo: "2026-10-02T12:00:00.000Z", note: "Spare run" })
    assert.ok(VehicleAllocationCreate.safeParse(body).success)
  })

  test("change opens on the allocation as it stands, holds its project, and asks for the reason", () => {
    const record = allocationAdapter.toRecord(planned, context)
    const form = allocationChangeForm(record)
    assert.ok(fieldIdsOf(form).includes("changeReason"))
    assert.ok(!fieldIdsOf(form).includes("allocationStatus"), "a status moves by confirm and release, never by a change")
    assert.ok(form.sections.flatMap((section) => section.fields).find((field) => field.id === "projectId")?.readOnly)
    const values = allocationFormValues(record)
    assert.equal(values.plannedStart, "2026-10-01T05:30")
    const changed = changedAllocationRecord(record, { ...values, plannedEnd: "2026-10-01T17:00", changeReason: "Longer shift" })
    const body = allocationAdapter.toPatchBody(record, changed, context)
    assert.deepEqual(body, { plannedTo: "2026-10-01T15:00:00.000Z", reason: "Longer shift" })
    assert.ok(VehicleAllocationChange.safeParse(body).success)
  })

  test("release asks for the reason its command reads", () => {
    assert.deepEqual(fieldIdsOf(RELEASE_FORM), ["reason"])
    const body = allocationAdapter.commands?.[RELEASE_ALLOCATION]?.toBody?.({ reason: "Route cancelled" }, allocationAdapter.toRecord(planned, context), context)
    assert.ok(VehicleAllocationRelease.safeParse(body).success)
  })
})
