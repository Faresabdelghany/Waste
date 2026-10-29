// A driver's absences and a vehicle's unavailability on the Pilot (O6 of
// #290): the record form's values to the contracts' create bodies, the last
// day away to the first day back; the actions' requests through the real
// client, the removal a DELETE answering nothing; the reads by owner,
// earliest first; the line a period reads as; and the fleet's surfaces, which
// keep the generic Edit.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DriverAbsence, DriverAbsenceCreate, VehicleUnavailability, VehicleUnavailabilityCreate } from "@waste/contracts/availability"
import { DRIVER_ABSENCE_REASONS, VEHICLE_UNAVAILABILITY_REASONS } from "@waste/domain/resources/vocabulary"

import { COMMAND_SURFACES } from "@/components/waste/commands/command-surfaces"
import { ABSENCE_FORM, UNAVAILABILITY_FORM } from "../../data/availability"
import type { BusinessRecord } from "../../data/business-modules"
import { remove } from "../client"
import type { MappingContext } from "../records/adapter"
import {
  awayLine,
  DRIVER_AVAILABILITY_ACTIONS,
  driverAbsences,
  LAST_DAY_ON_OR_AFTER,
  periodBody,
  RECORD_ABSENCE,
  RECORD_UNAVAILABILITY,
  recordDriverAbsence,
  REMOVE_ABSENCE,
  REMOVE_UNAVAILABILITY,
  removeVehicleUnavailability,
  VEHICLE_AVAILABILITY_ACTIONS,
  vehicleUnavailability,
} from "../records/availability"
import { driverAdapter, vehicleAdapter } from "../records/fleet"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const mads = { id: "driver-01a0d2a4-a280-7042-8000-000000000010", name: "Mads Jensen" } as BusinessRecord
const nr12 = { id: "vehicle-01a0d2a4-a280-7042-8000-000000000020", name: "NR-12 · CK 74 305" } as BusinessRecord
const context = {} as MappingContext
const driverId = "01a0d2a4-a280-7042-8000-000000000010"
const vehicleId = "01a0d2a4-a280-7042-8000-000000000020"
const stamps = { createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-01T09:00:00.000Z" }
const projectId = "01a0d2a4-a280-7042-8000-000000000001"

const holiday: DriverAbsence = { id: "01a0d2a4-a280-7042-8000-000000000031", projectId, driverId, validFrom: "2026-10-12", validTo: "2026-10-15", reason: "holiday", note: "Autumn break", ...stamps }
const sick: DriverAbsence = { id: "01a0d2a4-a280-7042-8000-000000000030", projectId, driverId, validFrom: "2026-10-05", validTo: "2026-10-06", reason: "sick", note: null, ...stamps }
const workshop: VehicleUnavailability = { id: "01a0d2a4-a280-7042-8000-000000000040", projectId, vehicleId, validFrom: "2026-11-02", validTo: null, reason: "repair", note: null, ...stamps }

describe("the record form's values", () => {
  test("map to the contracts' create body, the last day away to the first day back and a blank one to a return not known", () => {
    const body = periodBody({ validFrom: "2026-10-12", lastDay: "2026-10-14", reason: "holiday", note: " Autumn break " }, DRIVER_ABSENCE_REASONS)
    assert.deepEqual(body, { validFrom: "2026-10-12", validTo: "2026-10-15", reason: "holiday", note: "Autumn break" })
    assert.ok(DriverAbsenceCreate.safeParse({ ...(body as object), driverId }).success)
    const open = periodBody({ validFrom: "2026-11-02", lastDay: "", reason: "repair", note: "" }, VEHICLE_UNAVAILABILITY_REASONS)
    assert.deepEqual(open, { validFrom: "2026-11-02", validTo: null, reason: "repair" })
    assert.ok(VehicleUnavailabilityCreate.safeParse({ ...(open as object), vehicleId }).success)
    assert.deepEqual(periodBody({ validFrom: "2026-10-05", lastDay: "2026-10-05", reason: "sick" }, DRIVER_ABSENCE_REASONS), { validFrom: "2026-10-05", validTo: "2026-10-06", reason: "sick" }, "one day away")
  })

  test("refuse before the API sees them, naming the field", () => {
    assert.deepEqual(periodBody({ lastDay: "2026-10-14", reason: "holiday" }, DRIVER_ABSENCE_REASONS), { path: "validFrom", message: "Give the first day away" })
    assert.deepEqual(periodBody({ validFrom: "2026-10-14", lastDay: "2026-10-13", reason: "holiday" }, DRIVER_ABSENCE_REASONS), { path: "lastDay", message: LAST_DAY_ON_OR_AFTER })
    assert.equal((periodBody({ validFrom: "2026-10-14", reason: "maintenance" }, DRIVER_ABSENCE_REASONS) as { path: string }).path, "reason", "a vehicle's reason is not a driver's")
  })

  test("the forms offer the domain's reasons, and end on or after their first day", () => {
    const reasonsOf = (form: typeof ABSENCE_FORM) => form.sections.flatMap((section) => section.fields).find((field) => field.id === "reason")?.options?.map((option) => option.value)
    assert.deepEqual(reasonsOf(ABSENCE_FORM), [...DRIVER_ABSENCE_REASONS])
    assert.deepEqual(reasonsOf(UNAVAILABILITY_FORM), [...VEHICLE_UNAVAILABILITY_REASONS])
    for (const form of [ABSENCE_FORM, UNAVAILABILITY_FORM]) {
      assert.deepEqual(form.validationRules, [{ type: "date-order", startField: "validFrom", endField: "lastDay", message: LAST_DAY_ON_OR_AFTER, allowSame: true }])
      assert.deepEqual(form.sections.flatMap((section) => section.fields).map((field) => field.id), ["validFrom", "lastDay", "reason", "note"])
    }
  })
})

describe("the actions and the reads", () => {
  test("the driver's and the vehicle's adapters carry their two actions, the vehicle's beside its defects' resolve (O13 of #290)", () => {
    assert.equal(driverAdapter.actions, DRIVER_AVAILABILITY_ACTIONS)
    for (const [name, action] of Object.entries(VEHICLE_AVAILABILITY_ACTIONS)) assert.equal(vehicleAdapter.actions?.[name], action, name)
    assert.deepEqual(Object.keys(DRIVER_AVAILABILITY_ACTIONS), [RECORD_ABSENCE, REMOVE_ABSENCE])
    assert.deepEqual(Object.keys(VEHICLE_AVAILABILITY_ACTIONS), [RECORD_UNAVAILABILITY, REMOVE_UNAVAILABILITY])
  })

  test("recording posts the period under its owner and answers it; removing deletes it by id and answers nothing", async () => {
    const record = DRIVER_AVAILABILITY_ACTIONS[RECORD_ABSENCE]
    const body = record.toBody?.({ validFrom: "2026-10-12", lastDay: "2026-10-14", reason: "holiday", note: "Autumn break" }, mads, context)
    const { fetch, calls } = scripted([() => json(holiday, 201, { location: `/driver-absences/${holiday.id}` }), () => new Response(null, { status: 204 })])
    const client = clientOver(fetch)
    assert.deepEqual(await record.run(client, driverId, body), holiday)
    assert.deepEqual([calls[0].url, calls[0].init.method], ["http://api.test/driver-absences", "POST"])
    assert.deepEqual(bodyOf(calls[0]), { validFrom: "2026-10-12", validTo: "2026-10-15", reason: "holiday", note: "Autumn break", driverId })
    assert.ok(DriverAbsenceCreate.safeParse(bodyOf(calls[0])).success)

    const removal = DRIVER_AVAILABILITY_ACTIONS[REMOVE_ABSENCE]
    assert.deepEqual(removal.toBody?.({}, mads, context), { path: "periodId", message: "Name the period to remove" })
    assert.equal(await removal.run(client, driverId, removal.toBody?.({ periodId: holiday.id }, mads, context)), null)
    assert.deepEqual([calls[1].url, calls[1].init.method, calls[1].init.body], [`http://api.test/driver-absences/${holiday.id}`, "DELETE", undefined])
    assert.equal(record.refused(mads), "The absence of Mads Jensen was not recorded")
    assert.equal(VEHICLE_AVAILABILITY_ACTIONS[REMOVE_UNAVAILABILITY].refused(nr12), "The time NR-12 · CK 74 305 is out of use was not removed")
  })

  test("a vehicle's period is posted under the vehicle, and a refused removal is the API's problem", async () => {
    const record = VEHICLE_AVAILABILITY_ACTIONS[RECORD_UNAVAILABILITY]
    const { fetch, calls } = scripted([() => json(workshop, 201), () => problem(404, `No vehicle unavailability ${workshop.id} in the projects this account works in`)])
    const client = clientOver(fetch)
    await record.run(client, vehicleId, record.toBody?.({ validFrom: "2026-11-02", reason: "repair" }, nr12, context))
    assert.deepEqual(bodyOf(calls[0]), { validFrom: "2026-11-02", validTo: null, reason: "repair", vehicleId })
    await assert.rejects(remove(client, `/vehicle-unavailability/${workshop.id}`), (error: unknown) => error instanceof Error)
  })

  test("the reads ask by owner and answer the periods earliest first", async () => {
    const { fetch, calls } = scripted([() => json({ items: [holiday, sick], nextCursor: null }), () => json({ items: [workshop], nextCursor: null })])
    const client = clientOver(fetch)
    assert.deepEqual((await driverAbsences(client, driverId)).map((period) => period.id), [sick.id, holiday.id])
    assert.equal(calls[0].url, `http://api.test/driver-absences?limit=200&driverId=${driverId}`)
    assert.deepEqual(await vehicleUnavailability(client, vehicleId), [workshop])
    assert.equal(calls[1].url, `http://api.test/vehicle-unavailability?limit=200&vehicleId=${vehicleId}`)
  })

  test("the typed wrappers send through the store's sendAction, by name", async () => {
    const sent: unknown[] = []
    const sendAction = async (...args: unknown[]) => {
      sent.push(args)
      return { kind: "done" as const, answer: null }
    }
    await recordDriverAbsence(sendAction, mads.id, { validFrom: "2026-10-12", lastDay: "", reason: "holiday", note: "" })
    await removeVehicleUnavailability(sendAction, nr12.id, workshop.id)
    assert.deepEqual(sent, [
      ["fleet", "drivers", mads.id, RECORD_ABSENCE, { validFrom: "2026-10-12", lastDay: "", reason: "holiday", note: "" }],
      ["fleet", "vehicles", nr12.id, REMOVE_UNAVAILABILITY, { periodId: workshop.id }],
    ])
  })
})

describe("a period's line and the fleet's surfaces", () => {
  test("a period reads by its last day in, its reason and its note", () => {
    assert.equal(awayLine(holiday), "Mon 12 Oct – Wed 14 Oct · Holiday · Autumn break")
    assert.equal(awayLine(sick), "On Mon 5 Oct · Sick")
    assert.equal(awayLine(workshop), "From Mon 2 Nov · Repair")
  })

  test("the drivers, the vehicles and the customers keep their own form and the generic Edit beside the surface", () => {
    // A customer's surface is its statement (#291 C6): it reads, and changes nothing the form holds.
    // A warehouse's surface is its stock against its minimums (O30 of #290): it keeps its form and its Edit.
    for (const key of ["fleet.drivers", "fleet.vehicles", "customers.contacts", "resources.warehouses"]) {
      const surface = COMMAND_SURFACES[key]
      assert.equal(surface.primary, "form", key)
      assert.equal(surface.genericEdit, true, key)
      assert.ok(surface.rowActions !== undefined, key)
    }
    // M7 of #293: an Application is corrected by its form while undecided, beside its commands; a customer keeps its Edit beside its statement (#291 C6).
    assert.deepEqual(Object.keys(COMMAND_SURFACES).filter((key) => COMMAND_SURFACES[key].genericEdit).sort(), ["customers.applications", "customers.contacts", "fleet.drivers", "fleet.vehicles", "resources.warehouses"], "no other surface keeps it")
  })
})
