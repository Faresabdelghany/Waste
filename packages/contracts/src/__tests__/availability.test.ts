import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DriverAbsence, DriverAbsenceCreate, DriverAbsenceListQuery, DriverAbsencePatch, VehicleUnavailability, VehicleUnavailabilityCreate, VehicleUnavailabilityPatch } from "../availability"
import { ENDS_AFTER_IT_STARTS } from "../validity"
import { refusal, refusesAnEmptyPatch } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMPS = { createdAt: "2026-10-04T22:00:00.000Z", updatedAt: "2026-10-05T06:00:00.000Z" }

describe("a driver's absence and a vehicle's unavailability (O6 of #290)", () => {
  test("carry whose they are, the period half-open over days, why and a note", () => {
    const absence = { id: ID, ...STAMPS, projectId: OTHER, driverId: OTHER, validFrom: "2026-10-05", validTo: "2026-10-10", reason: "holiday", note: null }
    assert.deepEqual(DriverAbsence.parse(absence), absence)
    assert.equal(DriverAbsence.safeParse({ ...absence, validTo: null }).success, true, "a return not known yet")
    assert.equal(DriverAbsence.safeParse({ ...absence, reason: "maintenance" }).success, false, "a vehicle's reason is no driver's")
    const out = { id: ID, ...STAMPS, projectId: OTHER, vehicleId: OTHER, validFrom: "2026-10-06", validTo: "2026-10-07", reason: "maintenance", note: "Brakes" }
    assert.deepEqual(VehicleUnavailability.parse(out), out)
  })

  test("a create names the driver or the vehicle, the first day away, why; the end and the note are optional", () => {
    assert.deepEqual(DriverAbsenceCreate.parse({ driverId: ID, validFrom: "2026-10-05", reason: "sick" }), { driverId: ID, validFrom: "2026-10-05", reason: "sick" })
    assert.deepEqual(refusal(DriverAbsenceCreate.safeParse({ driverId: ID, validFrom: "2026-10-05", validTo: "2026-10-05", reason: "sick" })), [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }], "a period of no day")
    assert.deepEqual(refusal(DriverAbsenceCreate.safeParse({ validFrom: "2026-10-05", reason: "sick" })).map((issue) => issue.path), ["driverId"])
    assert.equal(VehicleUnavailabilityCreate.safeParse({ vehicleId: ID, validFrom: "2026-10-05", reason: "sick" }).success, false, "a driver's reason is no vehicle's")
    assert.match(refusal(DriverAbsenceCreate.safeParse({ driverId: ID, validFrom: "2026-10-05", reason: "sick", status: "approved" }))[0].message, /status/)
  })

  test("a patch moves the period, the reason or the note, never whose it is, and changes something", () => {
    assert.deepEqual(DriverAbsencePatch.parse({ validTo: null }), { validTo: null })
    refusesAnEmptyPatch(DriverAbsencePatch)
    refusesAnEmptyPatch(VehicleUnavailabilityPatch)
    assert.match(refusal(DriverAbsencePatch.safeParse({ driverId: OTHER }))[0].message, /driverId/)
    assert.equal(VehicleUnavailabilityPatch.safeParse({ validFrom: "2026-10-09", validTo: "2026-10-08" }).success, false)
  })

  test("a list is asked over a driver and a window of days, the end on or after the start", () => {
    assert.deepEqual(DriverAbsenceListQuery.parse({ driverId: ID, from: "2026-10-01", to: "2026-10-31" }), { limit: 50, driverId: ID, from: "2026-10-01", to: "2026-10-31" })
    assert.equal(DriverAbsenceListQuery.safeParse({ from: "2026-10-31", to: "2026-10-01" }).success, false)
  })
})
