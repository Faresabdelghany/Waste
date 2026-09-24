import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  PlanningArea,
  PlanningAreaBoundary,
  PlanningAreaBoundaryCreate,
  PlanningAreaBoundaryListQuery,
  PlanningAreaBoundaryPatch,
  PlanningAreaCreate,
  PlanningAreaListQuery,
  PlanningAreaPatch,
} from "../planning-areas"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const BACKWARDS = "validTo is the first day out of force, so it comes after validFrom"

/** A square over central Copenhagen, closed on its first position. */
const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [12.5, 55.65],
      [12.65, 55.65],
      [12.65, 55.75],
      [12.5, 55.75],
      [12.5, 55.65],
    ],
  ],
}

const area = { id: ID, projectId: OTHER, code: "OP-CEN-01", name: "Central", purpose: "route-planning", ...STAMPS }
const boundary = { id: ID, projectId: OTHER, planningAreaId: THIRD, boundary: SQUARE, validFrom: "2026-01-01", validTo: null, ...STAMPS }

describe("PlanningArea", () => {
  test("is the identity a scheme names: a code, a name, a purpose, and no status — in force is having a boundary valid that day", () => {
    assert.deepEqual(PlanningArea.parse(area), area)
    assert.equal(Object.keys(PlanningArea.shape).includes("status"), false)
    assert.equal(PlanningArea.safeParse({ ...area, purpose: "billing" }).success, false)
    assert.equal(PlanningArea.safeParse({ ...area, code: "" }).success, false)
  })
})

describe("PlanningAreaCreate and PlanningAreaPatch", () => {
  const body = { projectId: OTHER, code: "OP-CEN-01", name: "Central", purpose: "route-planning" }

  test("take the identity, optionally with the first boundary, and mint nothing", () => {
    assert.deepEqual(PlanningAreaCreate.parse(body), body)
    const drawn = { ...body, boundary: { boundary: SQUARE, validFrom: "2026-01-01" } }
    assert.deepEqual(PlanningAreaCreate.parse(drawn), drawn)
    refusesWhatTheServerOwns(PlanningAreaCreate, body)
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(PlanningAreaCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("hold the first boundary to the ring rule and the period rule, at the nested path", () => {
    const open = { type: "Polygon", coordinates: [SQUARE.coordinates[0].slice(0, 4)] }
    assert.deepEqual(refusal(PlanningAreaCreate.safeParse({ ...body, boundary: { boundary: open, validFrom: "2026-01-01" } })).map((issue) => issue.path), ["boundary.boundary.coordinates.0"])
    assert.deepEqual(refusal(PlanningAreaCreate.safeParse({ ...body, boundary: { boundary: SQUARE, validFrom: "2026-01-01", validTo: "2026-01-01" } })), [
      { path: "boundary.validTo", message: BACKWARDS },
    ])
  })

  test("change the name and the purpose, never the code: it is the reference the rest of the system quotes", () => {
    assert.deepEqual(PlanningAreaPatch.parse({ name: "Central north" }), { name: "Central north" })
    assert.deepEqual(PlanningAreaPatch.parse({ purpose: "notification" }), { purpose: "notification" })
    refusesAnEmptyPatch(PlanningAreaPatch)
    assert.match(refusal(PlanningAreaPatch.safeParse({ name: "x", code: "OP-CEN-02" }))[0].message, /code/)
    assert.match(refusal(PlanningAreaPatch.safeParse({ name: "x", projectId: OTHER }))[0].message, /projectId/)
  })
})

describe("PlanningAreaBoundary", () => {
  test("is one version of the outline: a closed polygon over a half-open period", () => {
    assert.deepEqual(PlanningAreaBoundary.parse(boundary), boundary)
    const ended = { ...boundary, validTo: "2027-01-01" }
    assert.deepEqual(PlanningAreaBoundary.parse(ended), ended)
    assert.deepEqual(refusal(PlanningAreaBoundary.safeParse({ ...boundary, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })

  test("takes the contracts' Polygon and nothing else: an unclosed ring, a point, or the prototype's {lng, lat} objects are refused", () => {
    const unclosed = { type: "Polygon", coordinates: [SQUARE.coordinates[0].slice(0, 4)] }
    assert.equal(PlanningAreaBoundary.safeParse({ ...boundary, boundary: unclosed }).success, false)
    assert.equal(PlanningAreaBoundary.safeParse({ ...boundary, boundary: { type: "Point", coordinates: [12.5, 55.65] } }).success, false)
    assert.equal(PlanningAreaBoundary.safeParse({ ...boundary, boundary: [{ lng: 12.5, lat: 55.65 }] }).success, false)
  })
})

describe("PlanningAreaBoundaryCreate and PlanningAreaBoundaryPatch", () => {
  const body = { boundary: SQUARE, validFrom: "2026-01-01" }

  test("take the polygon and the period, neither the area nor the project: the path carries one and the area the other", () => {
    assert.deepEqual(PlanningAreaBoundaryCreate.parse(body), body)
    assert.deepEqual(PlanningAreaBoundaryCreate.parse({ ...body, validTo: null }), { ...body, validTo: null })
    assert.match(refusal(PlanningAreaBoundaryCreate.safeParse({ ...body, planningAreaId: THIRD }))[0].message, /planningAreaId/)
    assert.match(refusal(PlanningAreaBoundaryCreate.safeParse({ ...body, projectId: OTHER }))[0].message, /projectId/)
    refusesWhatTheServerOwns(PlanningAreaBoundaryCreate, body)
    assert.deepEqual(refusal(PlanningAreaBoundaryCreate.safeParse({ ...body, validTo: "2025-12-31" })), [{ path: "validTo", message: BACKWARDS }])
  })

  test("move the end or redraw the outline, never the start: a version begins where the earlier ended", () => {
    assert.deepEqual(PlanningAreaBoundaryPatch.parse({ validTo: "2027-01-01" }), { validTo: "2027-01-01" })
    assert.deepEqual(PlanningAreaBoundaryPatch.parse({ validTo: null }), { validTo: null })
    assert.deepEqual(PlanningAreaBoundaryPatch.parse({ boundary: SQUARE }), { boundary: SQUARE })
    refusesAnEmptyPatch(PlanningAreaBoundaryPatch)
    assert.match(refusal(PlanningAreaBoundaryPatch.safeParse({ validTo: null, validFrom: "2026-02-01" }))[0].message, /validFrom/)
  })
})

describe("PlanningAreaListQuery and PlanningAreaBoundaryListQuery", () => {
  test("page areas by project and purpose", () => {
    assert.deepEqual(PlanningAreaListQuery.parse({}), { limit: 50 })
    assert.deepEqual(PlanningAreaListQuery.parse({ projectId: OTHER, purpose: "notification", limit: "10" }), { projectId: OTHER, purpose: "notification", limit: 10 })
    assert.equal(PlanningAreaListQuery.safeParse({ purpose: "zoning" }).success, false)
  })

  test("page boundaries by project, area and the day in force: the Layers control's read", () => {
    assert.deepEqual(PlanningAreaBoundaryListQuery.parse({ projectId: OTHER, planningAreaId: THIRD, validOn: "2026-06-01" }), {
      projectId: OTHER,
      planningAreaId: THIRD,
      validOn: "2026-06-01",
      limit: 50,
    })
    assert.equal(PlanningAreaBoundaryListQuery.safeParse({ validOn: "2026-06-01T00:00:00Z" }).success, false)
  })
})
