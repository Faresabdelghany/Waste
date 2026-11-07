// The licence rule reads typed fields (issue #37): a driver record's
// licenceClass and optional licenceExpiry, a vehicle record's
// requiredLicenceClass. The domain cannot see a form field id, so this test
// is the bridge: the two fleet forms offer exactly LICENCE_CLASSES on those
// fields, and the quick form's driver select says what Guided Setup step 3
// says.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { LICENCE_CLASSES, NO_LICENCE_ON_RECORD, type FleetRecord } from "@/lib/prototype/route-schemes/fleet-profiles"

import { getBusinessFormSchema } from "../business-form-schemas"
import { driverFormOptions } from "../driver-form-options"

const fieldsOf = (workspaceId: "fleet", moduleId: string) => {
  const schema = getBusinessFormSchema(workspaceId, moduleId)
  assert.ok(schema, `${workspaceId}.${moduleId} has no form schema`)
  return schema.sections.flatMap((section) => section.fields)
}
const fieldOf = (fields: ReturnType<typeof fieldsOf>, id: string) => {
  const found = fields.find((field) => field.id === id)
  assert.ok(found, `${id} is not a field of the form`)
  return found
}

describe("the driver form", () => {
  const fields = fieldsOf("fleet", "drivers")

  test("licenceClass is a required select over LICENCE_CLASSES, no longer a master-data relation", () => {
    const field = fieldOf(fields, "licenceClass")
    assert.equal(field.type, "select")
    assert.equal(field.required, true)
    assert.equal(field.relation, undefined)
    assert.deepEqual(
      (field.options ?? []).map((option) => option.value),
      [...LICENCE_CLASSES],
    )
  })

  test("licenceExpiry is an optional date", () => {
    const field = fieldOf(fields, "licenceExpiry")
    assert.equal(field.type, "date")
    assert.notEqual(field.required, true)
  })
})

describe("the vehicle form", () => {
  test("requiredLicenceClass is a required select over LICENCE_CLASSES", () => {
    const field = fieldOf(fieldsOf("fleet", "vehicles"), "requiredLicenceClass")
    assert.equal(field.type, "select")
    assert.equal(field.required, true)
    assert.equal(field.relation, undefined)
    assert.deepEqual(
      (field.options ?? []).map((option) => option.value),
      [...LICENCE_CLASSES],
    )
  })
})

describe("the quick form's driver select", () => {
  const vehicle = (id: string, name: string, requiredLicenceClass: string, resourceKind = "powered-vehicle"): FleetRecord => ({ id, name, context: "", facts: {}, submittedValues: { requiredLicenceClass, resourceKind } })
  const driver = (id: string, name: string, licenceClass: string, licenceExpiry: string): FleetRecord => ({ id, name, context: "", facts: {}, submittedValues: { licenceClass, licenceExpiry } })
  const vehicles = [vehicle("vehicle-wh31", "WH-31 · CN 42 031", "C"), vehicle("trailer-wh12", "WH-T12 · TR 12 012", "CE", "trailer")]
  const drivers = [
    driver("driver-mads", "Mads Jensen", "CE", "2028-12-31"),
    driver("driver-freja", "Freja Nielsen", "CE", "2029-03-31"),
    driver("driver-lars", "Lars Møller", "C", "2026-09-05"),
    driver("driver-jonas", "Jonas Lind", "", ""),
  ]

  test("lists every driver against the planned vehicle, one who may not take it disabled with the reason, as Guided Setup step 3 does", () => {
    const options = driverFormOptions({ plannedVehicleId: "vehicle-wh31" }, drivers, vehicles)
    const byValue = new Map(options.map((option) => [option.value, option]))
    assert.deepEqual(byValue.get("driver-freja"), { value: "driver-freja", label: "Freja Nielsen · CE" })
    assert.deepEqual(byValue.get("driver-jonas"), {
      value: "driver-jonas",
      label: `Jonas Lind · ${NO_LICENCE_ON_RECORD}`,
      disabled: true,
    })
    assert.equal(byValue.get("driver-lars")?.disabled, undefined)
    // The trailer needs CE: Lars, holding C, is disabled there.
    const trailerOptions = driverFormOptions({ plannedVehicleId: "trailer-wh12" }, drivers, vehicles)
    assert.equal(trailerOptions.find((option) => option.value === "driver-lars")?.disabled, true)
    assert.equal(trailerOptions.find((option) => option.value === "driver-mads")?.disabled, undefined)
  })
})
