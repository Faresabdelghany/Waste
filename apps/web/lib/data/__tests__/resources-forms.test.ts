// The fleet and places forms name the master module's rows by id (#180,
// slice 5a of #81, the plan's "relations by id"): a vehicle's compatible
// fractions and a station's accepted fractions are multiselects over
// `configure.master`, kept through enhanceField's static-key rule, which
// still turns a single select at the module into its static keys; a
// vehicle's fuel is a select over the wire's fuels, read off the vocabulary
// and spelled nowhere else. The fixtures carry nothing under the retired
// free-text field or the static key, so a browser that still holds either
// reads as no selection.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { FUEL_TYPES, VEHICLE_STATUSES, WAREHOUSE_STATUSES } from "@waste/domain/resources/vocabulary"

import { getBusinessFormSchema } from "../business-form-schemas"
import { getModuleDefinition, type WorkspaceId } from "../business-modules"
import { masterDataKindForField } from "../master-data-kinds"

const fieldsOf = (workspaceId: WorkspaceId, moduleId: string) => {
  const schema = getBusinessFormSchema(workspaceId, moduleId)
  assert.ok(schema, `${workspaceId}.${moduleId} has no form schema`)
  return schema.sections.flatMap((section) => section.fields)
}
const fieldOf = (fields: ReturnType<typeof fieldsOf>, id: string) => {
  const found = fields.find((field) => field.id === id)
  assert.ok(found, `${id} is not a field of the form`)
  return found
}
const MASTER = { workspaceId: "configure", moduleId: "master" }

describe("the vehicle form", () => {
  const fields = fieldsOf("fleet", "vehicles")

  test("wasteFractionIds is a multiselect over the master module, filtered to the waste fractions; the free-text wasteFractions is gone", () => {
    const field = fieldOf(fields, "wasteFractionIds")
    assert.equal(field.type, "multiselect")
    assert.deepEqual(field.relation, MASTER)
    assert.equal(field.options, undefined)
    assert.equal(masterDataKindForField(field.id), "waste-fraction")
    assert.ok(!fields.some((candidate) => candidate.id === "wasteFractions"))
  })

  test("fuelOrEnergyType is a select over the wire's fuels, no longer a master-data relation", () => {
    const field = fieldOf(fields, "fuelOrEnergyType")
    assert.equal(field.type, "select")
    assert.equal(field.relation, undefined)
    assert.deepEqual(
      (field.options ?? []).map((option) => option.value),
      [...FUEL_TYPES],
    )
    assert.equal(field.options?.find((option) => option.value === "hvo")?.label, "HVO")
  })

  test("status is a select over the wire's four statuses, so a retired or unavailable vehicle opens in the edit dialog", () => {
    const field = fieldOf(fields, "status")
    assert.deepEqual(
      (field.options ?? []).map((option) => option.value),
      [...VEHICLE_STATUSES],
    )
    assert.equal(field.defaultValue, "active")
  })
})

describe("the warehouse form", () => {
  test("status is a select over the wire's four statuses, closed included", () => {
    const field = fieldOf(fieldsOf("resources", "warehouses"), "status")
    assert.deepEqual(
      (field.options ?? []).map((option) => option.value),
      [...WAREHOUSE_STATUSES],
    )
    assert.equal(field.defaultValue, "draft")
  })
})

describe("the location form", () => {
  const fields = fieldsOf("resources", "depots")

  test("acceptedFractionIds is a multiselect over the master module, asked of an unloading station and not of a depot, and not required, as the API registers a station before it accepts anything; the single static select is gone", () => {
    const field = fieldOf(fields, "acceptedFractionIds")
    assert.equal(field.type, "multiselect")
    assert.deepEqual(field.relation, MASTER)
    assert.equal(field.options, undefined)
    assert.deepEqual(field.visibleWhen, { fieldId: "locationType", equals: "unloading" })
    assert.equal(field.requiredWhen, undefined)
    assert.notEqual(field.required, true)
    assert.equal(masterDataKindForField(field.id), "waste-fraction")
    assert.ok(!fields.some((candidate) => candidate.id === "acceptedFractionId"))
  })
})

describe("enhanceField's static keys for a fraction at the master module", () => {
  test("still stand in for a single select, which has no master rows of its kind in fixture mode", () => {
    const field = fieldOf(fieldsOf("route-studio", "weights"), "materialFraction")
    assert.equal(field.type, "select")
    assert.equal(field.relation, undefined)
    assert.deepEqual(
      (field.options ?? []).map((option) => option.value),
      ["residual", "organic", "cardboard", "mixed-recycling"],
    )
  })

  test("leave a multiselect on the module, so the picker offers the rows the store loaded", () => {
    for (const [workspaceId, moduleId, id] of [
      ["fleet", "vehicles", "wasteFractionIds"],
      ["resources", "depots", "acceptedFractionIds"],
    ] as const) {
      const field = fieldOf(fieldsOf(workspaceId, moduleId), id)
      assert.deepEqual(field.relation, MASTER, `${workspaceId}.${moduleId}.${id} keeps its relation`)
    }
  })
})

describe("what the four forms require", () => {
  test("is what the wire requires: a field the API does not carry, or takes as null, is optional, so a seeded row saves as it stands", () => {
    const required = (workspaceId: WorkspaceId, moduleId: string) => fieldsOf(workspaceId, moduleId).filter((field) => field.required).map((field) => field.id)
    assert.deepEqual(required("fleet", "vehicles"), ["registrationNumber", "resourceKind", "vehicleType", "ownershipType", "status", "requiredLicenceClass", "projectId"])
    // The licence class stays required by the form (issue #37), though the wire takes a new hire without one.
    assert.deepEqual(required("fleet", "drivers"), ["driverName", "employmentType", "projectId", "licenceClass"])
    assert.deepEqual(required("resources", "depots"), ["projectId", "source", "locationType", "name", "code", "address", "latitude", "longitude", "ownership"])
    assert.deepEqual(required("resources", "warehouses"), ["projectId", "source", "name", "code", "status", "address"])
  })
})

describe("the fixtures", () => {
  test("no fixture vehicle or location carries a typed value under the retired fields or the new ones: the pickers open on no selection", () => {
    for (const [workspaceId, moduleId] of [
      ["fleet", "vehicles"],
      ["resources", "depots"],
    ] as const) {
      const module = getModuleDefinition({ workspaceId, moduleId })
      assert.ok(module)
      for (const record of module.records) {
        for (const key of ["wasteFractions", "wasteFractionIds", "acceptedFractionId", "acceptedFractionIds"]) {
          assert.equal(record.submittedValues?.[key], undefined, `${record.id} carries ${key}`)
        }
      }
    }
  })
})
