// The map's Service Area seed is typed in the domain; the field ids it lands
// under belong to the web form schema, which the domain cannot see, and the
// dialog silently drops any value whose id the schema does not declare.
// serviceAreaFormValues is the web's mapping, and this test is the bridge —
// in both directions, since the domain reads some of those fields back
// (coverage.ts reads the planning areas a service area covers).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { serviceAreasForSelection } from "@waste/domain/map-planning/coverage"
import {
  SERVICE_AREA_POLYGON_KEY,
  serviceAreaPolygon,
  serviceAreaSeedFromSelection,
  type ServiceAreaSeed,
} from "@waste/domain/map-planning/service-areas"

import { getBusinessFormSchema } from "../business-form-schemas"
import type { BusinessRecord } from "../business-modules"
import { SERVICE_AREAS_MODULE, SERVICE_AREA_SEED_FIELDS, serviceAreaFormValues } from "../service-areas"
import { FIXTURE_GAZETTEER } from "../street-gazetteer"

const square = [
  { lng: 12.5, lat: 55.6 },
  { lng: 12.6, lat: 55.6 },
  { lng: 12.6, lat: 55.7 },
  { lng: 12.5, lat: 55.7 },
]

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

const planningAreas = [record("area-x", "Indre By"), record("area-y", "Østerbro Zone 2")]
const container = record("container-1", "C-1", {
  submittedValues: { projectId: "project-copenhagen", planningAreaId: "area-x" },
})

/** The seed the domain really produces for a drawn selection around the container. */
const drawnSeed: ServiceAreaSeed = serviceAreaSeedFromSelection({
  selected: [container, record("container-2", "C-2", { submittedValues: { projectId: "project-copenhagen", planningAreaId: "area-y" } })],
  shape: { kind: "rectangle", polygon: square },
  planningAreas,
  properties: 2,
})

/** Every value the mapping wrote, as the record store would keep it. */
const asStored = (values: Record<string, string | boolean>) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]))

describe("serviceAreaFormValues against the Service Area form", () => {
  test("writes only field ids the form declares, and every field the seed has", () => {
    const schema = getBusinessFormSchema(SERVICE_AREAS_MODULE.workspaceId, SERVICE_AREAS_MODULE.moduleId)
    assert.ok(schema, "the Service Area form schema exists")
    const declared = new Set(schema.sections.flatMap((section) => section.fields.map((field) => field.id)))

    const { initialValues, extraValues } = serviceAreaFormValues(drawnSeed)
    const formFields = Object.entries(SERVICE_AREA_SEED_FIELDS)
      .filter(([field]) => field !== "polygon")
      .map(([, id]) => id)
      .sort()
    assert.deepEqual(Object.keys(initialValues).sort(), formFields, "a full seed fills every form field the map names")
    const undeclared = Object.keys(initialValues).filter((key) => !declared.has(key))
    assert.deepEqual(undeclared, [], `the form would drop: ${undeclared.join(", ")}`)
    assert.deepEqual(Object.keys(extraValues), [SERVICE_AREA_POLYGON_KEY], "the polygon is stored, not shown")
  })

  test("maps the typed seed onto the form's values", () => {
    assert.deepEqual(serviceAreaFormValues(drawnSeed).initialValues, {
      projectId: "project-copenhagen",
      zoneIds: "area-x,area-y",
      boundary: "Drawn on Map Planning · 2 containers across 2 properties",
    })
  })

  test("leaves an unknown project and empty planning areas unset — the workspace's project scope then applies", () => {
    const { initialValues } = serviceAreaFormValues({ ...drawnSeed, projectId: null, planningAreaIds: [] })
    assert.deepEqual(Object.keys(initialValues), ["boundary"])
  })

  test("what the mapping stores, the domain reads back: the polygon, and the planning areas the area covers", () => {
    const { initialValues, extraValues } = serviceAreaFormValues(drawnSeed)
    const created = record("sa-new", "New area", { submittedValues: asStored({ ...initialValues, ...extraValues }) })
    assert.deepEqual(serviceAreaPolygon(created), square)

    // A hand-picked selection stores no polygon, so coverage rests on the planning-area field alone.
    const handPicked = serviceAreaFormValues({ ...drawnSeed, polygon: null })
    assert.deepEqual(handPicked.extraValues, {})
    const byAreas = record("sa-areas", "Areas only", { submittedValues: asStored(handPicked.initialValues) })
    const [coverage] = serviceAreasForSelection([container], [byAreas], FIXTURE_GAZETTEER)
    assert.equal(coverage?.containers, 1, "the domain reads the planning areas under the id the web wrote")
  })
})
