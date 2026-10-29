// A vehicle's pre-trip checks and defects on the Pilot (O13 of #290): the
// reads by vehicle, open defects first and the newest check first; the resolve
// action's request through the real client, which the vehicle's adapter
// offers beside its periods out of use; and the lines a defect and a check
// read as.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PreTripCheck, VehicleDefect, VehicleDefectResolve } from "@waste/contracts/pre-trip"

import type { BusinessRecord } from "../../data/business-modules"
import type { MappingContext } from "../records/adapter"
import { vehicleAdapter } from "../records/fleet"
import { checkLine, defectLine, RESOLVE_DEFECT, VEHICLE_DEFECT_ACTIONS, vehicleChecks, vehicleDefects } from "../records/pre-trip"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const nr12 = { id: "vehicle-01a0d2a4-a280-7042-8000-000000000020", name: "NR-12 · CK 74 305" } as BusinessRecord
const context = {} as MappingContext
const vehicleId = "01a0d2a4-a280-7042-8000-000000000020"
const projectId = "01a0d2a4-a280-7042-8000-000000000001"
const checkId = "01a0d2a4-a280-7042-8000-000000000050"
const stamps = { createdAt: "2026-10-05T06:20:00.000Z", updatedAt: "2026-10-05T06:20:00.000Z" }

const defect = (id: string, status: "open" | "resolved", foundAt: string, over: Partial<VehicleDefect> = {}): VehicleDefect =>
  VehicleDefect.parse({ id, ...stamps, projectId, vehicleId, preTripCheckId: checkId, label: "Brakes", critical: true, note: "Pulls left", foundAt, status, ticketId: null, resolvedAt: status === "resolved" ? foundAt : null, resolutionNote: null, ...over })
const check = (id: string, occurredAt: string, over: Partial<PreTripCheck> = {}): PreTripCheck =>
  PreTripCheck.parse({ id, recordedAt: occurredAt, projectId, routeId: checkId, vehicleId, driverId: checkId, occurredAt, items: [], defectCount: 0, odometerKm: null, engineHours: null, location: null, locationAccuracyM: null, ...over })

describe("the reads", () => {
  test("ask by vehicle, the open defects first and each kind newest first, and the checks newest first", async () => {
    const older = defect("01a0d2a4-a280-7042-8000-000000000061", "open", "2026-10-01T06:00:00.000Z")
    const newer = defect("01a0d2a4-a280-7042-8000-000000000062", "open", "2026-10-05T06:00:00.000Z")
    const done = defect("01a0d2a4-a280-7042-8000-000000000063", "resolved", "2026-10-06T06:00:00.000Z")
    const monday = check("01a0d2a4-a280-7042-8000-000000000071", "2026-10-05T06:00:00.000Z")
    const tuesday = check("01a0d2a4-a280-7042-8000-000000000072", "2026-10-06T06:00:00.000Z")
    const { fetch, calls } = scripted([() => json({ items: [done, older, newer], nextCursor: null }), () => json({ items: [monday, tuesday], nextCursor: null })])
    const client = clientOver(fetch)
    assert.deepEqual(
      (await vehicleDefects(client, vehicleId)).map((row) => row.id),
      [newer.id, older.id, done.id],
    )
    assert.equal(calls[0].url, `http://api.test/vehicle-defects?limit=200&vehicleId=${vehicleId}`)
    assert.deepEqual(
      (await vehicleChecks(client, vehicleId)).map((row) => row.id),
      [tuesday.id, monday.id],
    )
    assert.equal(calls[1].url, `http://api.test/pre-trip-checks?limit=200&vehicleId=${vehicleId}`)
  })
})

describe("the resolve action", () => {
  test("is the vehicle's, beside its periods out of use, and posts the note the contract takes to the defect", async () => {
    assert.ok(vehicleAdapter.actions?.[RESOLVE_DEFECT] !== undefined)
    const action = VEHICLE_DEFECT_ACTIONS[RESOLVE_DEFECT]
    const target = defect("01a0d2a4-a280-7042-8000-000000000064", "open", "2026-10-05T06:00:00.000Z")
    const { fetch, calls } = scripted([() => json({ ...target, status: "resolved", resolvedAt: "2026-10-05T10:00:00.000Z" })])
    const body = action.toBody?.({ defectId: target.id, note: " Pads replaced " }, nr12, context)
    await action.run(clientOver(fetch), vehicleId, body)
    assert.equal(calls[0].url, `http://api.test/vehicle-defects/${target.id}/resolve`)
    assert.deepEqual(bodyOf(calls[0]), { note: "Pads replaced" })
    assert.ok(VehicleDefectResolve.safeParse(bodyOf(calls[0])).success)
    assert.deepEqual(action.toBody?.({ note: "x" }, nr12, context), { path: "defectId", message: "Name the defect to resolve" })
    assert.equal(action.refused(nr12), "The defect on NR-12 · CK 74 305 was not resolved")
  })
})

describe("the lines", () => {
  test("a defect reads its item, its weight and what was seen; a check what it found and the readings", () => {
    assert.equal(defectLine({ label: "Brakes", critical: true, note: "Pulls left" }), "Brakes · critical · Pulls left")
    assert.equal(defectLine({ label: "Lights", critical: false, note: null }), "Lights")
    assert.equal(checkLine({ defectCount: 0, odometerKm: 182_400, engineHours: null }), "No defects · 182,400 km")
    assert.equal(checkLine({ defectCount: 2, odometerKm: null, engineHours: 6_120 }), "2 defects · 6,120 h")
  })
})
