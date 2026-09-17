// The domain seeds the Service Area create dialog with field ids it cannot
// see: the form schema is web-only, and the dialog silently drops any value
// whose id the schema does not declare. This test is the bridge.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { serviceAreaSeedFromSelection } from "@waste/domain/map-planning/service-areas"

import { getBusinessFormSchema } from "../business-form-schemas"
import type { BusinessRecord } from "../business-modules"
import { SERVICE_AREAS_MODULE } from "../service-areas"

const record = (id: string, name: string, overrides: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id,
  name,
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
  ...overrides,
})

describe("serviceAreaSeedFromSelection against the Service Area form", () => {
  test("writes only field ids the form declares", () => {
    const schema = getBusinessFormSchema(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId)
    assert.ok(schema, "the Service Area form schema exists")
    const declared = new Set(schema.sections.flatMap((section) => section.fields.map((field) => field.id)))

    const area = record("area-x", "Indre By")
    const container = record("container-1", "C-1", {
      submittedValues: { projectId: "project-copenhagen", planningAreaId: "area-x" },
    })
    const seed = serviceAreaSeedFromSelection({
      selected: [container],
      shape: null,
      planningAreas: [area],
      properties: 1,
    })

    const written = Object.keys(seed.initialValues).sort()
    assert.deepEqual(written, ["boundary", "projectId", "zoneIds"], "the seed exercised every key it can write")
    const undeclared = written.filter((key) => !declared.has(key))
    assert.deepEqual(undeclared, [], `the form would drop: ${undeclared.join(", ")}`)
  })
})
