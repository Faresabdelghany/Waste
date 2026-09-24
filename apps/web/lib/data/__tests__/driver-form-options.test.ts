// The quick form's driver choices are the domain's quickDriverOptions
// (issue #37) turned into form options: every driver listed, an ineligible
// one disabled with the reason beside the name, judged by the vehicle the
// form's plannedVehicleId names.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { driverFormOptions } from "../driver-form-options"

const record = (
  id: string,
  name: string,
  context: string,
  facts: Record<string, string>,
  submittedValues?: Record<string, string | boolean>,
) => ({ id, name, context, facts, submittedValues })

const wh24 = record(
  "vehicle-wh24",
  "WH-24 · CN 42 018",
  "Rear loader 18 t · Nordhavn",
  { Capacity: "18 t" },
  { requiredLicenceClass: "C" },
)
const unclassed = record("vehicle-old", "WH-40 · AA 11 222", "Rear loader 18 t · Nordhavn", {})
const vehicles = [wh24, unclassed]

describe("driverFormOptions", () => {
  const madsRecord = record("driver-mads", "Mads Jensen", "Kystbyen", {}, { licenceClass: "CE" })
  const emilRecord = record("driver-emil", "Emil Kristensen", "Kystbyen", {}, { licenceClass: "B" })
  const unknownRecord = record("driver-new", "New Driver", "Kystbyen", {})
  const drivers = [madsRecord, emilRecord, unknownRecord]

  test("lists every driver; an ineligible one is disabled with the reason, unknown ⇒ ineligible", () => {
    assert.deepEqual(driverFormOptions({ plannedVehicleId: "vehicle-wh24" }, drivers, vehicles), [
      { value: "driver-mads", label: "Mads Jensen · CE" },
      { value: "driver-emil", label: "Emil Kristensen · B · Needs C licence", disabled: true },
      { value: "driver-new", label: "New Driver · No licence on record", disabled: true },
    ])
  })

  test("without a planned vehicle nothing is judged", () => {
    assert.deepEqual(driverFormOptions({}, [emilRecord, unknownRecord], vehicles), [
      { value: "driver-emil", label: "Emil Kristensen · B" },
      { value: "driver-new", label: "New Driver" },
    ])
  })

  test("a vehicle without a class on record disables every driver with the vehicle's reason", () => {
    assert.deepEqual(driverFormOptions({ plannedVehicleId: "vehicle-old" }, [madsRecord], vehicles), [
      {
        value: "driver-mads",
        label: "Mads Jensen · CE · Vehicle has no licence class on record",
        disabled: true,
      },
    ])
  })
})
