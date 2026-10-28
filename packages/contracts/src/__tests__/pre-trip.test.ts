// Pre-trip inspection on the wire (O13 of #290): a type's checklist set, a
// check's answers, the check and the defect as the API answers them.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DriverCommand } from "../driver-commands"
import { CHECKLIST_MAX, EACH_ANSWER_ONCE, EACH_ITEM_ONCE, PreTripCheck, VehicleDefect, VehicleDefectListQuery, VehicleDefectResolve, VehicleTypeChecklistSet } from "../pre-trip"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const WHEN = "2026-10-05T06:20:00.000Z"

describe("VehicleTypeChecklistSet", () => {
  test("is the whole list in order, each item critical unless it says otherwise", () => {
    assert.deepEqual(VehicleTypeChecklistSet.parse({ items: [{ label: "Brakes" }, { label: "Lights", critical: false }] }), {
      items: [
        { label: "Brakes", critical: true },
        { label: "Lights", critical: false },
      ],
    })
    assert.deepEqual(VehicleTypeChecklistSet.parse({ items: [] }), { items: [] })
  })

  test("names each item once, whatever its case, and at most the domain's cap; an id is the server's", () => {
    assert.deepEqual(refusal(VehicleTypeChecklistSet.safeParse({ items: [{ label: "Brakes" }, { label: "brakes" }] })), [{ path: "items", message: EACH_ITEM_ONCE }])
    const many = Array.from({ length: CHECKLIST_MAX + 1 }, (_, index) => ({ label: `Item ${index}` }))
    assert.equal(VehicleTypeChecklistSet.safeParse({ items: many }).success, false)
    assert.equal(VehicleTypeChecklistSet.safeParse({ items: [{ id: ID, label: "Brakes" }] }).success, false)
  })
})

describe("the pre-trip-check command", () => {
  const command = (body: object) => ({ id: ID, routeId: OTHER, occurredAt: WHEN, deviceId: "device-7", kind: "pre-trip-check", body })

  test("names the vehicle and answers items, each once; the readings are whole and not negative", () => {
    assert.equal(DriverCommand.safeParse(command({ vehicleId: THIRD, items: [] })).success, true, "a type with no checklist")
    assert.deepEqual(
      refusal(
        DriverCommand.safeParse(
          command({
            vehicleId: THIRD,
            items: [
              { itemId: ID, passed: true },
              { itemId: ID, passed: false },
            ],
          }),
        ),
      ).map((issue) => issue.message),
      [EACH_ANSWER_ONCE],
    )
    assert.equal(DriverCommand.safeParse(command({ vehicleId: THIRD, items: [], odometerKm: -1 })).success, false)
    assert.equal(DriverCommand.safeParse(command({ vehicleId: THIRD, items: [], engineHours: 1.5 })).success, false)
    assert.equal(DriverCommand.safeParse(command({ vehicleId: THIRD, items: [{ itemId: ID, passed: "no" }] })).success, false)
  })
})

describe("the check and the defect", () => {
  test("read back as the ledger row and the defect the API answers", () => {
    const check = {
      id: ID,
      recordedAt: WHEN,
      projectId: OTHER,
      routeId: THIRD,
      vehicleId: OTHER,
      driverId: THIRD,
      occurredAt: WHEN,
      items: [{ itemId: OTHER, label: "Brakes", critical: true, passed: false, note: "Pulls left" }],
      defectCount: 1,
      odometerKm: 182_400,
      engineHours: null,
      location: null,
      locationAccuracyM: null,
    }
    assert.deepEqual(PreTripCheck.parse(check), check)
    const defect = {
      id: THIRD,
      createdAt: WHEN,
      updatedAt: WHEN,
      projectId: OTHER,
      vehicleId: OTHER,
      preTripCheckId: ID,
      label: "Brakes",
      critical: true,
      note: "Pulls left",
      foundAt: WHEN,
      status: "open",
      ticketId: null,
      resolvedAt: null,
      resolutionNote: null,
    }
    assert.deepEqual(VehicleDefect.parse(defect), defect)
    assert.equal(VehicleDefect.safeParse({ ...defect, status: "mended" }).success, false)
  })

  test("a resolve may say what was done; a list narrows by vehicle and status", () => {
    assert.deepEqual(VehicleDefectResolve.parse({}), {})
    assert.equal(VehicleDefectResolve.safeParse({ note: "Pads replaced", status: "resolved" }).success, false)
    assert.equal(VehicleDefectListQuery.safeParse({ vehicleId: ID, status: "open" }).success, true)
  })
})
