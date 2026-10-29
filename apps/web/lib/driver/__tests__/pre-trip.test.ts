// The Driver App's pre-trip check (O13 of #290): the form's marks become the
// `pre-trip-check` body the door's contract takes, every item answered in the
// list's order, and the confirm says what the check will do.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { COMMAND_BODIES } from "@waste/contracts/driver-commands"

import type { QueueEntry } from "../command-queue"
import { checkOutcome, checkWaiting, preTripBody, wholeReading } from "../pre-trip"

const VEHICLE = "018f7c31-a000-7000-8000-000000000040"
const BRAKES = "018f7c31-a000-7000-8000-000000000070"
const LIGHTS = "018f7c31-a000-7000-8000-000000000071"
const truck = {
  id: VEHICLE,
  label: "WH-24",
  checklist: [
    { id: BRAKES, label: "Brakes", critical: true },
    { id: LIGHTS, label: "Lights", critical: false },
  ],
}
const blank = { marks: {}, odometerKm: "", engineHours: "" }

describe("preTripBody", () => {
  test("answers every item, passed unless marked, with what the driver saw on a defect, and the readings given", () => {
    const body = preTripBody(truck, { marks: { [LIGHTS]: { defect: true, note: " Left indicator out " }, [BRAKES]: { defect: false, note: "ignored" } }, odometerKm: "182400", engineHours: "" })
    assert.deepEqual(body, {
      vehicleId: VEHICLE,
      items: [
        { itemId: BRAKES, passed: true },
        { itemId: LIGHTS, passed: false, note: "Left indicator out" },
      ],
      odometerKm: 182_400,
    })
    assert.equal(COMMAND_BODIES["pre-trip-check"].safeParse(body).success, true, "the door's contract takes it")
  })

  test("a vehicle whose type holds no checklist is checked with no items", () => {
    assert.deepEqual(preTripBody({ id: VEHICLE, checklist: [] }, blank), { vehicleId: VEHICLE, items: [] })
  })

  test("a reading is whole and not negative, or none", () => {
    assert.equal(wholeReading("6120"), 6120)
    assert.equal(wholeReading("0"), 0)
    assert.equal(wholeReading("12.5"), undefined)
    assert.equal(wholeReading("-1"), undefined)
    assert.equal(wholeReading(" "), undefined)
  })
})

describe("checkOutcome", () => {
  test("says the vehicle is fit, stays in service with a minor defect, or goes to maintenance with a critical one", () => {
    assert.equal(checkOutcome(truck, blank), "Every item passed: WH-24 is fit to drive.")
    assert.equal(checkOutcome(truck, { marks: { [LIGHTS]: { defect: true, note: "" } } }), "One defect: the office is told, and WH-24 stays in service.")
    assert.equal(checkOutcome(truck, { marks: { [LIGHTS]: { defect: true, note: "" }, [BRAKES]: { defect: true, note: "" } } }), "2 defects, one of them critical: WH-24 goes to maintenance and the office is told.")
  })
})

describe("checkWaiting", () => {
  test("is a check of that vehicle for that route in the queue", () => {
    const waiting = [{ owner: "o", state: "ready", command: { id: "c", kind: "pre-trip-check", routeId: "r-1", occurredAt: "2026-10-05T06:00:00.000Z", deviceId: "d", body: { vehicleId: VEHICLE, items: [] } } }] as QueueEntry[]
    assert.equal(checkWaiting(waiting, "r-1", VEHICLE), true)
    assert.equal(checkWaiting(waiting, "r-2", VEHICLE), false)
    assert.equal(checkWaiting(waiting, "r-1", "another"), false)
  })
})
