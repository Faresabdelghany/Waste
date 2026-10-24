import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { DropOffPointsQuery, type PublicDropOffPoint } from "@waste/contracts/public"

import { boundsOf, dropOffHrefOf, FRACTION_KEY_MAX, fractionKeyOf, mapPointsOf, openingTextOf, pointsCollectionOf, shortDayOf } from "../drop-off-points"

const point = (id: string, coordinates: [number, number]): PublicDropOffPoint => ({
  id,
  name: `Point ${id}`,
  kind: "bring-bank",
  address: "Vej 1",
  location: { type: "Point", coordinates },
  fractions: ["Glas"],
  publicNote: null,
  week: [],
})

describe("the fraction key's bound", () => {
  test("is the door's, spelled again: the web imports the contracts as types only", () => {
    assert.equal(DropOffPointsQuery.safeParse({ fraction: "a".repeat(FRACTION_KEY_MAX) }).success, true)
    assert.equal(DropOffPointsQuery.safeParse({ fraction: "a".repeat(FRACTION_KEY_MAX + 1) }).success, false)
  })
})

describe("fractionKeyOf and dropOffHrefOf", () => {
  test("a fraction is asked by the guide's key, a lowercase slug; anything else asks for every point", () => {
    assert.equal(fractionKeyOf("glass"), "glass")
    assert.equal(fractionKeyOf(["hard-plastic", "x"]), "hard-plastic")
    assert.equal(fractionKeyOf(" glass "), "glass")
    assert.equal(fractionKeyOf("Glass jars"), null)
    assert.equal(fractionKeyOf(undefined), null)
    assert.equal(fractionKeyOf(""), null)
    assert.equal(fractionKeyOf("a".repeat(FRACTION_KEY_MAX + 1)), null, "a key the door would refuse asks for every point, never an outage")
  })

  test("the map's address, with the fraction where one is asked", () => {
    assert.equal(dropOffHrefOf("kystbyen"), "/p/kystbyen/drop-off")
    assert.equal(dropOffHrefOf("kystbyen", "glass"), "/p/kystbyen/drop-off?fraction=glass")
    assert.equal(dropOffHrefOf("kystbyen", null), "/p/kystbyen/drop-off")
  })
})

describe("openingTextOf and shortDayOf", () => {
  test("a day's opening in words: all day, closed, or its windows", () => {
    assert.equal(openingTextOf({ date: "2026-12-21", windows: [], allDay: true, note: null }), "Open all day")
    assert.equal(openingTextOf({ date: "2026-12-22", windows: [], allDay: false, note: null }), "Closed")
    assert.equal(openingTextOf({ date: "2026-12-21", windows: [{ opensAt: "10:00", closesAt: "18:00" }], allDay: false, note: null }), "10:00–18:00")
    assert.equal(
      openingTextOf({
        date: "2026-12-26",
        windows: [
          { opensAt: "08:00", closesAt: "11:00" },
          { opensAt: "13:00", closesAt: "17:00" },
        ],
        allDay: false,
        note: null,
      }),
      "08:00–11:00 and 13:00–17:00",
    )
  })

  test("a day as a short label, on the date's own calendar", () => {
    assert.equal(shortDayOf("2026-12-21"), "Mon 21 Dec")
  })
})

describe("mapPointsOf and boundsOf", () => {
  test("each point at its place, and the box that holds them all; none for no point", () => {
    const points = [point("a", [12.6, 55.65]), point("b", [12.55, 55.7])]
    assert.deepEqual(mapPointsOf(points), [
      { id: "a", name: "Point a", kind: "bring-bank", lng: 12.6, lat: 55.65 },
      { id: "b", name: "Point b", kind: "bring-bank", lng: 12.55, lat: 55.7 },
    ])
    assert.deepEqual(boundsOf(mapPointsOf(points)), { west: 12.55, south: 55.65, east: 12.6, north: 55.7 })
    assert.equal(boundsOf([]), null)
    assert.deepEqual(pointsCollectionOf(mapPointsOf(points)).features[0], { type: "Feature", properties: { id: "a", name: "Point a", kind: "bring-bank" }, geometry: { type: "Point", coordinates: [12.6, 55.65] } })
  })
})
