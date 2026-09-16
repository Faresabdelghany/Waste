import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { clusterPoints } from "../clusters"
import { FALLBACK_FRACTION_PALETTE, fractionColor } from "../colors"
import { offsetMetres } from "../geo"
import { containerPoints, propertyPoints, type MapPoint } from "../points"

function container(
  id: string,
  facts: Record<string, string>,
  extra: Partial<BusinessRecord> = {},
): BusinessRecord {
  return {
    id,
    name: id.toUpperCase(),
    context: "",
    status: "Available",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts,
    related: [],
    source: "",
    freshness: "",
    ...extra,
  }
}

const ryesgade = { Address: "Ryesgade 45, 2200 København N", Property: "Ryesgade 45" }
const jagtvej = { Address: "Jagtvej 10, 2200 København N", Property: "Jagtvej 10" }

function point(id: string, lng: number, lat: number, fractions: string[]): MapPoint {
  return {
    id,
    kind: "container",
    lngLat: { lng, lat },
    fractions,
    label: id,
    sublabel: "",
    propertyKey: id,
    containerIds: [id],
    record: container(id, {}),
  }
}

describe("containerPoints", () => {
  test("only located, in-service, visible containers become points", () => {
    const points = containerPoints([
      container("a", { ...ryesgade, "Waste fractions": "Organic" }),
      container("b", { ...ryesgade, "Waste fractions": "Residual · Mixed" }),
      container("stored", { Address: "Warehouse West", Property: "—" }, { status: "In storage" }),
      container("gone", ryesgade, { facts: { ...ryesgade, "Registry visibility": "Soft deleted" } }),
    ])
    assert.deepEqual(points.map((p) => p.id), ["a", "b"])
    assert.deepEqual(points[1].fractions, ["Residual", "Mixed"])
    assert.equal(points[0].propertyKey, "Ryesgade 45")
    assert.deepEqual(points[0].lngLat, points[1].lngLat)
  })
})

describe("propertyPoints", () => {
  test("one point per property, carrying its containers and distinct fractions", () => {
    const points = propertyPoints(
      [
        container("a", { ...ryesgade, "Waste fractions": "Organic" }),
        container("b", { ...ryesgade, "Waste fractions": "Organic" }),
        container("c", { ...ryesgade, "Waste fractions": "Paper" }),
        container("d", { ...jagtvej, "Waste fractions": "Glass" }),
      ],
      [container("property-1", { ServiceAddress: "Ryesgade 45, 2200 København N" }, { name: "Ryesgade 45" })],
    )
    assert.equal(points.length, 2)
    const ryes = points.find((p) => p.propertyKey === "Ryesgade 45")
    assert.ok(ryes)
    assert.equal(ryes.kind, "property")
    assert.equal(ryes.record.id, "property-1", "the property record is attached when it exists")
    assert.deepEqual(ryes.containerIds, ["a", "b", "c"])
    assert.deepEqual(ryes.fractions, ["Organic", "Paper"])
    const jagt = points.find((p) => p.propertyKey === "Jagtvej 10")
    assert.ok(jagt)
    assert.equal(jagt.record.id, "d", "without a property record the first container stands in")
  })
})

describe("clusterPoints", () => {
  const base = { lng: 12.56, lat: 55.69 }
  const near = offsetMetres(base, 5, 0)
  const far = offsetMetres(base, 3000, 0)

  test("neighbours merge at a city zoom and split when zoomed in", () => {
    const points = [
      point("a", base.lng, base.lat, ["Organic"]),
      point("b", near.lng, near.lat, ["Residual"]),
      point("c", far.lng, far.lat, ["Glass"]),
    ]
    const city = clusterPoints(points, 12)
    assert.equal(city.length, 2)
    const pair = city.find((c) => c.count === 2)
    assert.ok(pair)
    assert.deepEqual(pair.points.map((p) => p.id), ["a", "b"])
    assert.equal(pair.singleLocation, false)

    const street = clusterPoints(points, 20)
    assert.equal(street.length, 3)
  })

  test("distinct fractions are listed most frequent first; identical spots are singleLocation", () => {
    const stack = [
      point("a", base.lng, base.lat, ["Paper"]),
      point("b", base.lng, base.lat, ["Organic"]),
      point("c", base.lng, base.lat, ["Organic"]),
    ]
    const [cluster] = clusterPoints(stack, 22)
    assert.equal(cluster.count, 3)
    assert.equal(cluster.singleLocation, true)
    assert.deepEqual(cluster.fractions, ["Organic", "Paper"])
    assert.deepEqual(cluster.lngLat, base)
  })

  test("the result is deterministic regardless of input order", () => {
    const points = [
      point("b", near.lng, near.lat, ["Residual"]),
      point("a", base.lng, base.lat, ["Organic"]),
    ]
    const forward = clusterPoints(points, 12)
    const backward = clusterPoints([...points].reverse(), 12)
    assert.deepEqual(forward.map((c) => c.id), backward.map((c) => c.id))
  })
})

describe("fractionColor", () => {
  const configured = [
    { name: "Organic", color: "#16a34a" },
    { name: "Residual", color: "#64748b" },
  ]

  test("a configured fraction uses its Settings colour, case-insensitively", () => {
    assert.equal(fractionColor("organic", configured), "#16a34a")
  })

  test("unknown fractions get a stable fallback, distinct from each other", () => {
    const plastic = fractionColor("Plastic", configured)
    assert.equal(fractionColor("Plastic", configured), plastic)
    assert.ok(FALLBACK_FRACTION_PALETTE.includes(plastic))
    assert.notEqual(fractionColor("Metal", configured), plastic)
  })
})
