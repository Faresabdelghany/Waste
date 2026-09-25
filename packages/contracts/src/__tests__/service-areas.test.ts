import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  EACH_FRACTION_ONCE,
  EACH_PLANNING_AREA_ONCE,
  PROVIDER_NEEDS_A_DAY,
  SERVICE_AREA_CODE_MAX,
  ServiceArea,
  ServiceAreaAssignment,
  ServiceAreaAssignmentCreate,
  ServiceAreaAssignmentListQuery,
  ServiceAreaAssignmentPatch,
  ServiceAreaCreate,
  ServiceAreaCreated,
  ServiceAreaDetail,
  ServiceAreaListQuery,
  ServiceAreaPatch,
  ServiceAreaPlanningAreasSet,
  ServiceAreaWasteFractionsSet,
} from "../service-areas"
import { ENDS_AFTER_IT_STARTS } from "../validity"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-25T09:00:00.000Z", updatedAt: "2026-09-25T09:00:00.000Z" }
const BACKWARDS = { path: "validTo", message: ENDS_AFTER_IT_STARTS }

const assignment = {
  id: THIRD,
  projectId: OTHER,
  serviceAreaId: ID,
  serviceProviderId: OTHER,
  notes: null,
  validFrom: "2026-01-01",
  validTo: null,
  ...STAMPS,
}

const area = {
  id: ID,
  projectId: OTHER,
  code: "CA-Ø-2",
  name: "Østerbro",
  boundaryText: "Østerbro as the 2026 contract draws it",
  notes: null,
  planningAreaIds: [THIRD, OTHER],
  wasteFractionIds: [ID],
  validFrom: "2026-01-01",
  validTo: null,
  ...STAMPS,
}

describe("ServiceArea", () => {
  test("is the award on the wire: the code as the contract spells it, the legal boundary text, the two sets, and the period; no polygon, no products, no provider", () => {
    assert.deepEqual(ServiceArea.parse(area), area)
    const bare = { ...area, planningAreaIds: [], wasteFractionIds: [], notes: "Municipal facilities excluded", validTo: "2028-01-01" }
    assert.deepEqual(ServiceArea.parse(bare), bare)
    for (const notHere of ["boundary", "serviceProviderId", "productIds", "status"]) assert.equal(notHere in ServiceArea.shape, false, notHere)
  })

  test("holds the code to forty characters and a letter allowed — it is not a slug — and the period to running forwards", () => {
    assert.equal(SERVICE_AREA_CODE_MAX, 40)
    assert.equal(ServiceArea.parse({ ...area, code: "CA-Ø-2 / Nord" }).code, "CA-Ø-2 / Nord")
    assert.deepEqual(refusal(ServiceArea.safeParse({ ...area, code: "C".repeat(41) })).map((issue) => issue.path), ["code"])
    assert.deepEqual(refusal(ServiceArea.safeParse({ ...area, code: "  " })).map((issue) => issue.path), ["code"])
    assert.deepEqual(refusal(ServiceArea.safeParse({ ...area, validTo: "2026-01-01" })), [BACKWARDS])
  })

  test("ServiceAreaDetail is the area with its assignments by start, and ServiceAreaCreated the area with the first assignment or null", () => {
    const detail = { ...area, assignments: [assignment, { ...assignment, id: OTHER, validFrom: "2027-01-01" }] }
    assert.deepEqual(ServiceAreaDetail.parse(detail), detail)
    assert.deepEqual(ServiceAreaCreated.parse({ ...area, assignment }), { ...area, assignment })
    assert.deepEqual(ServiceAreaCreated.parse({ ...area, assignment: null }), { ...area, assignment: null })
    assert.deepEqual(refusal(ServiceAreaCreated.safeParse({ ...area, assignment, validTo: "2025-01-01" })), [BACKWARDS], "the rule travels with the fields")
  })
})

describe("ServiceAreaCreate", () => {
  const body = { projectId: OTHER, code: "CA-Ø-2", name: "Østerbro", boundaryText: "Østerbro as the 2026 contract draws it", validFrom: "2026-01-01" }

  test("takes the award with its sets defaulting to none, and the first assignment when the award is made to someone straight away", () => {
    assert.deepEqual(ServiceAreaCreate.parse(body), { ...body, planningAreaIds: [], wasteFractionIds: [] })
    const awarded = { ...body, planningAreaIds: [THIRD, OTHER], wasteFractionIds: [ID], notes: null, validTo: "2028-01-01", assignment: { serviceProviderId: OTHER } }
    assert.deepEqual(ServiceAreaCreate.parse(awarded), awarded)
    const dated = { ...body, planningAreaIds: [], wasteFractionIds: [], assignment: { serviceProviderId: OTHER, validFrom: "2026-03-01", validTo: null } }
    assert.deepEqual(ServiceAreaCreate.parse(dated), dated)
    assert.match(ServiceAreaCreate.shape.planningAreaIds.description ?? "", /none when absent/)
  })

  test("needs the project, the code, the name, the text and a first day, and mints nothing", () => {
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(ServiceAreaCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
    refusesWhatTheServerOwns(ServiceAreaCreate, body)
    assert.match(refusal(ServiceAreaCreate.safeParse({ ...body, serviceProviderId: OTHER }))[0].message, /serviceProviderId/, "the provider is the assignment's, not the area's")
  })

  test("names each planning area and each fraction once, holds both sets to two hundred, and the two periods to running forwards", () => {
    assert.deepEqual(refusal(ServiceAreaCreate.safeParse({ ...body, planningAreaIds: [THIRD, THIRD] })), [{ path: "planningAreaIds", message: EACH_PLANNING_AREA_ONCE }])
    assert.deepEqual(refusal(ServiceAreaCreate.safeParse({ ...body, wasteFractionIds: [ID, ID] })), [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
    assert.deepEqual(refusal(ServiceAreaCreate.safeParse({ ...body, planningAreaIds: Array.from({ length: 201 }, (_, i) => `01a0d3a5-e5e0-7000-8000-${String(i).padStart(12, "0")}`) })).map((issue) => issue.path), ["planningAreaIds"])
    assert.deepEqual(refusal(ServiceAreaCreate.safeParse({ ...body, validTo: "2025-12-31" })), [BACKWARDS])
    assert.deepEqual(refusal(ServiceAreaCreate.safeParse({ ...body, assignment: { serviceProviderId: OTHER, validFrom: "2026-03-01", validTo: "2026-03-01" } })), [{ path: "assignment.validTo", message: ENDS_AFTER_IT_STARTS }])
    assert.deepEqual(refusal(ServiceAreaCreate.safeParse({ ...body, assignment: { serviceProviderId: OTHER, notes: "x" } })).map((issue) => issue.path), ["assignment"], "the first assignment says the provider and its period, nothing else")
  })
})

describe("ServiceAreaPatch and the two sets", () => {
  test("patch the name, the text, the notes and the period, refuse an empty patch, and never the code or the sets", () => {
    assert.deepEqual(ServiceAreaPatch.parse({ name: "Østerbro, north" }), { name: "Østerbro, north" })
    assert.deepEqual(ServiceAreaPatch.parse({ validTo: "2028-01-01", notes: null }), { validTo: "2028-01-01", notes: null })
    refusesAnEmptyPatch(ServiceAreaPatch)
    for (const key of ["code", "planningAreaIds", "wasteFractionIds", "projectId"]) assert.match(refusal(ServiceAreaPatch.safeParse({ name: "x", [key]: "y" }))[0].message, new RegExp(key), key)
    assert.deepEqual(refusal(ServiceAreaPatch.safeParse({ validFrom: "2026-02-01", validTo: "2026-01-01" })), [BACKWARDS])
  })

  test("a set replaces the whole, each id once, at most two hundred, and may be empty", () => {
    assert.deepEqual(ServiceAreaPlanningAreasSet.parse({ ids: [ID, OTHER] }), { ids: [ID, OTHER] })
    assert.deepEqual(ServiceAreaPlanningAreasSet.parse({ ids: [] }), { ids: [] })
    assert.deepEqual(refusal(ServiceAreaPlanningAreasSet.safeParse({ ids: [ID, ID] })), [{ path: "ids", message: EACH_PLANNING_AREA_ONCE }])
    assert.deepEqual(refusal(ServiceAreaWasteFractionsSet.safeParse({ ids: [ID, ID] })), [{ path: "ids", message: EACH_FRACTION_ONCE }])
    assert.deepEqual(refusal(ServiceAreaWasteFractionsSet.safeParse({ ids: [ID], planningAreaIds: [] })).map((issue) => issue.path), [""])
    assert.deepEqual(refusal(ServiceAreaPlanningAreasSet.safeParse({})).map((issue) => issue.path), ["ids"])
  })
})

describe("ServiceAreaAssignment", () => {
  test("is the relationship on the wire: who holds the area over the period", () => {
    assert.deepEqual(ServiceAreaAssignment.parse(assignment), assignment)
    const ended = { ...assignment, notes: "Transferred to CityHaul", validTo: "2026-07-01" }
    assert.deepEqual(ServiceAreaAssignment.parse(ended), ended)
    assert.deepEqual(refusal(ServiceAreaAssignment.safeParse({ ...assignment, validTo: "2025-01-01" })), [BACKWARDS])
  })

  test("the create takes the provider, the notes and the period — the area is the path's — and the patch the notes and the end alone: a transfer is a new assignment", () => {
    assert.deepEqual(ServiceAreaAssignmentCreate.parse({ serviceProviderId: OTHER, validFrom: "2026-01-01" }), { serviceProviderId: OTHER, validFrom: "2026-01-01" })
    assert.deepEqual(ServiceAreaAssignmentCreate.parse({ serviceProviderId: OTHER, validFrom: "2026-01-01", validTo: null, notes: null }), { serviceProviderId: OTHER, validFrom: "2026-01-01", validTo: null, notes: null })
    refusesWhatTheServerOwns(ServiceAreaAssignmentCreate, { serviceProviderId: OTHER, validFrom: "2026-01-01" })
    for (const key of ["serviceAreaId", "projectId"]) assert.match(refusal(ServiceAreaAssignmentCreate.safeParse({ serviceProviderId: OTHER, validFrom: "2026-01-01", [key]: ID }))[0].message, new RegExp(key), key)
    assert.deepEqual(refusal(ServiceAreaAssignmentCreate.safeParse({ serviceProviderId: OTHER, validFrom: "2026-01-01", validTo: "2026-01-01" })), [BACKWARDS])
    assert.deepEqual(ServiceAreaAssignmentPatch.parse({ validTo: "2026-07-01" }), { validTo: "2026-07-01" })
    refusesAnEmptyPatch(ServiceAreaAssignmentPatch)
    for (const key of ["serviceProviderId", "serviceAreaId", "validFrom"]) assert.match(refusal(ServiceAreaAssignmentPatch.safeParse({ notes: "x", [key]: "y" }))[0].message, new RegExp(key), key)
  })
})

describe("the list queries", () => {
  test("ServiceAreaListQuery pages by project, day and planning area, and by provider only with a day", () => {
    assert.deepEqual(ServiceAreaListQuery.parse({}), { limit: 50 })
    assert.deepEqual(ServiceAreaListQuery.parse({ projectId: OTHER, validOn: "2026-06-01", planningAreaId: THIRD }), { limit: 50, projectId: OTHER, validOn: "2026-06-01", planningAreaId: THIRD })
    assert.deepEqual(ServiceAreaListQuery.parse({ serviceProviderId: OTHER, validOn: "2026-06-01" }), { limit: 50, serviceProviderId: OTHER, validOn: "2026-06-01" })
    assert.deepEqual(refusal(ServiceAreaListQuery.safeParse({ serviceProviderId: OTHER })), [{ path: "validOn", message: PROVIDER_NEEDS_A_DAY }])
  })

  test("ServiceAreaAssignmentListQuery pages by project, area, provider and day", () => {
    assert.deepEqual(ServiceAreaAssignmentListQuery.parse({}), { limit: 50 })
    assert.deepEqual(ServiceAreaAssignmentListQuery.parse({ serviceAreaId: ID, serviceProviderId: OTHER, validOn: "2026-06-01", limit: "10" }), { limit: 10, serviceAreaId: ID, serviceProviderId: OTHER, validOn: "2026-06-01" })
    assert.deepEqual(refusal(ServiceAreaAssignmentListQuery.safeParse({ serviceAreaId: "area-1" })).map((issue) => issue.path), ["serviceAreaId"])
  })
})
