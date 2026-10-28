// The planning areas' GeoJSON file read into the import's rows (O30 of #290,
// row 1.18): each feature a row from 2, its properties matched to the
// columns as a CSV header is, its polygon the boundary.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NOT_A_FEATURE_COLLECTION, planningAreaRows } from "../geojson"

const RING = [
  [12.5, 55.7],
  [12.6, 55.7],
  [12.6, 55.8],
  [12.5, 55.7],
]

const collection = (...features: unknown[]) => JSON.stringify({ type: "FeatureCollection", features })
const feature = (properties: Record<string, unknown>, geometry: unknown = { type: "Polygon", coordinates: [RING] }) => ({ type: "Feature", properties, geometry })

describe("planningAreaRows", () => {
  test("reads each feature as a row from 2, its properties by the columns' headers in any spelling, its polygon the boundary", () => {
    const file = planningAreaRows(collection(feature({ Code: "CPH-N", NAME: "Copenhagen North", purpose: "route-planning", valid_from: "2027-01-01", OBJECTID: 7 }), feature({ code: "CPH-S", name: "Copenhagen South", purpose: "notification" }, null)))
    assert.ok("rows" in file)
    assert.deepEqual(file.rows, [
      { row: 2, values: { code: "CPH-N", name: "Copenhagen North", purpose: "route-planning", "valid from": "2027-01-01", boundary: JSON.stringify({ type: "Polygon", coordinates: [RING] }) } },
      { row: 3, values: { code: "CPH-S", name: "Copenhagen South", purpose: "notification" } },
    ])
    assert.deepEqual(file.issues, { unknown: [], missing: [], repeated: [], unclosedQuote: null }, "a property the kind does not know is left out, not refused")
  })

  test("a MultiPolygon of one polygon is that polygon; any other geometry is no boundary", () => {
    const multi = planningAreaRows(collection(feature({ code: "A", name: "A", purpose: "route-planning" }, { type: "MultiPolygon", coordinates: [[RING]] })))
    assert.ok("rows" in multi)
    assert.equal(multi.rows[0]!.values.boundary, JSON.stringify({ type: "Polygon", coordinates: [RING] }))
    const point = planningAreaRows(collection(feature({ code: "B", name: "B", purpose: "route-planning" }, { type: "Point", coordinates: [12.5, 55.7] })))
    assert.ok("rows" in point)
    assert.equal(point.rows[0]!.values.boundary, undefined)
  })

  test("names the required columns no feature gives, and refuses a file that is not a FeatureCollection", () => {
    const file = planningAreaRows(collection(feature({ name: "No code" })))
    assert.ok("rows" in file)
    assert.deepEqual(file.issues.missing, ["code", "purpose"])
    assert.deepEqual(planningAreaRows("code,name\nA,B"), { problem: NOT_A_FEATURE_COLLECTION })
    assert.deepEqual(planningAreaRows(JSON.stringify({ type: "Feature" })), { problem: NOT_A_FEATURE_COLLECTION })
    assert.ok("rows" in planningAreaRows(`﻿${collection()}`), "a byte-order mark is read past")
  })
})
