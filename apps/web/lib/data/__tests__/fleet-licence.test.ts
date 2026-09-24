// The licence rule reads typed fields (issue #37): a driver record's
// licenceClass and optional licenceExpiry, a vehicle record's
// requiredLicenceClass. The domain cannot see a form field id or the fixture
// registry, so this test is the bridge: the two fleet forms offer exactly
// LICENCE_CLASSES on those fields, every fixture vehicle carries its class,
// every fixture driver but the new hire carries a class and a calendar-day
// expiry, and the quick form's driver select over the fixture fleet says what
// Guided Setup step 3 says.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  LICENCE_CLASSES,
  NO_LICENCE_ON_RECORD,
  driverProfile,
  isLicenceClass,
  vehicleProfile,
} from "@waste/domain/route-schemes/fleet-profiles"
import { isIsoDate } from "@waste/domain/route-schemes/recurrence"

import { getBusinessFormSchema } from "../business-form-schemas"
import { getModuleDefinition } from "../business-modules"
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
const recordsOf = (moduleId: string) => {
  const module = getModuleDefinition({ workspaceId: "fleet", moduleId })
  assert.ok(module, `fleet.${moduleId} is not a module`)
  return module.records
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

describe("the fixture fleet", () => {
  const vehicles = recordsOf("vehicles")
  const drivers = recordsOf("drivers")

  test("every fixture vehicle carries a typed required licence class the profile reads", () => {
    assert.ok(vehicles.length > 0)
    for (const vehicle of vehicles) {
      const typed = vehicle.submittedValues?.requiredLicenceClass
      assert.ok(isLicenceClass(typed), `${vehicle.id} carries no licence class`)
      assert.equal(vehicleProfile(vehicle).licenceClass, typed)
    }
  })

  test("the trailer needs CE, the powered vehicles C", () => {
    const byId = new Map(vehicles.map((vehicle) => [vehicle.id, vehicleProfile(vehicle)]))
    assert.equal(byId.get("trailer-wh12")?.licenceClass, "CE")
    for (const id of ["vehicle-wh24", "vehicle-wh31", "vehicle-nr08", "vehicle-nr12"]) {
      assert.equal(byId.get(id)?.licenceClass, "C", id)
    }
  })

  test("every fixture driver but the new hire carries a typed class and a calendar-day expiry", () => {
    const withLicence = drivers.filter((driver) => driver.id !== "driver-jonas")
    assert.ok(withLicence.length >= 3)
    for (const driver of withLicence) {
      const profile = driverProfile(driver)
      assert.ok(isLicenceClass(profile.licenceClass), `${driver.id} carries no licence class`)
      assert.ok(
        profile.licenceExpiry !== null && isIsoDate(profile.licenceExpiry),
        `${driver.id} carries no calendar-day expiry`,
      )
      assert.equal(profile.licenceClass, driver.submittedValues?.licenceClass)
      assert.equal(profile.licenceExpiry, driver.submittedValues?.licenceExpiry)
    }
    const byId = new Map(withLicence.map((driver) => [driver.id, driverProfile(driver)]))
    assert.equal(byId.get("driver-mads")?.licenceClass, "CE")
    assert.equal(byId.get("driver-freja")?.licenceClass, "CE")
    assert.equal(byId.get("driver-lars")?.licenceClass, "C")
    assert.equal(byId.get("driver-lars")?.licenceExpiry, "2026-09-05")
  })

  test("the new hire has no licence on record and is never eligible", () => {
    const jonas = drivers.find((driver) => driver.id === "driver-jonas")
    assert.ok(jonas)
    assert.equal(driverProfile(jonas).licenceClass, null)
    assert.equal(driverProfile(jonas).licenceExpiry, null)
  })

  test("the quick form's driver select over the fixture fleet says what Guided Setup step 3 says", () => {
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
