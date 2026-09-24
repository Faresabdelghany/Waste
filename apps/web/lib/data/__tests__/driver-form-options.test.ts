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

const wh24 = record("vehicle-wh24", "WH-24 · CN 42 018", "Rear loader 18 t · Nordhavn", {
  Capacity: "18 t",
})

describe("driverFormOptions", () => {
  const madsRecord = record("driver-mads", "Mads Jensen", "Kystbyen", { Licence: "C/CE · valid 2028" })
  const emilRecord = record("driver-emil", "Emil Kristensen", "Kystbyen", { Licence: "B · valid 2030" })
  const unknownRecord = record("driver-new", "New Driver", "Kystbyen", {})

  test("lists every driver; an ineligible one is disabled with the reason, unknown ⇒ ineligible", () => {
    assert.deepEqual(driverFormOptions([madsRecord, emilRecord, unknownRecord], wh24), [
      { value: "driver-mads", label: "Mads Jensen · C, CE" },
      { value: "driver-emil", label: "Emil Kristensen · B · Needs C licence", disabled: true },
      { value: "driver-new", label: "New Driver · No licence on record", disabled: true },
    ])
  })

  test("without a vehicle nothing is judged", () => {
    assert.deepEqual(driverFormOptions([emilRecord, unknownRecord], undefined), [
      { value: "driver-emil", label: "Emil Kristensen · B" },
      { value: "driver-new", label: "New Driver" },
    ])
  })
})
