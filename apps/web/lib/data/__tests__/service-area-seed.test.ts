// The map's Service Area seed is typed in the domain; the field ids it lands
// under belong to the web form schema, which the domain cannot see, and the
// dialog silently drops any value whose id the schema does not declare.
// serviceAreaFormValues is the web's mapping, and this test is the bridge.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { SERVICE_AREA_POLYGON_KEY, serviceAreaPolygon, type ServiceAreaSeed } from "@waste/domain/map-planning/service-areas"

import { getBusinessFormSchema } from "../business-form-schemas"
import type { BusinessRecord } from "../business-modules"
import { SERVICE_AREAS_MODULE, serviceAreaFormValues } from "../service-areas"

const square = [
  { lng: 12.5, lat: 55.6 },
  { lng: 12.6, lat: 55.6 },
  { lng: 12.6, lat: 55.7 },
  { lng: 12.5, lat: 55.7 },
]

const fullSeed: ServiceAreaSeed = {
  projectId: "project-copenhagen",
  planningAreaIds: ["area-x", "area-y"],
  boundary: "Drawn on Map Planning · 3 containers across 2 properties",
  polygon: square,
}

describe("serviceAreaFormValues against the Service Area form", () => {
  test("writes only field ids the form declares, and every one the seed can fill", () => {
    const schema = getBusinessFormSchema(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId)
    assert.ok(schema, "the Service Area form schema exists")
    const declared = new Set(schema.sections.flatMap((section) => section.fields.map((field) => field.id)))

    const { initialValues } = serviceAreaFormValues(fullSeed)
    const written = Object.keys(initialValues).sort()
    assert.deepEqual(written, ["boundary", "projectId", "zoneIds"], "the seed exercised every key it can write")
    const undeclared = written.filter((key) => !declared.has(key))
    assert.deepEqual(undeclared, [], `the form would drop: ${undeclared.join(", ")}`)
  })

  test("maps the typed seed onto the form's values", () => {
    const { initialValues } = serviceAreaFormValues(fullSeed)
    assert.deepEqual(initialValues, {
      projectId: "project-copenhagen",
      zoneIds: "area-x,area-y",
      boundary: "Drawn on Map Planning · 3 containers across 2 properties",
    })
  })

  test("leaves an unknown project and empty planning areas unset so the form shows its placeholders", () => {
    const { initialValues } = serviceAreaFormValues({ ...fullSeed, projectId: null, planningAreaIds: [] })
    assert.deepEqual(Object.keys(initialValues), ["boundary"])
  })

  test("stores the drawn polygon where the domain reads it back, and nothing for a hand-picked selection", () => {
    const drawn = serviceAreaFormValues(fullSeed).extraValues
    assert.deepEqual(Object.keys(drawn), [SERVICE_AREA_POLYGON_KEY])
    const created: BusinessRecord = {
      id: "sa-new",
      name: "New area",
      context: "",
      status: "Active",
      owner: "",
      value: "",
      updated: "",
      description: "",
      facts: {},
      related: [],
      source: "",
      freshness: "",
      submittedValues: Object.fromEntries(Object.entries(drawn).map(([key, value]) => [key, String(value)])),
    }
    assert.deepEqual(serviceAreaPolygon(created), square)
    assert.deepEqual(serviceAreaFormValues({ ...fullSeed, polygon: null }).extraValues, {})
  })
})
