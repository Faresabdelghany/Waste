import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import {
  collectionWindowRange,
  inCollectionWindow,
  nextCollectionDate,
  routeStopIndex,
} from "../schedule"

function stub(extra: Partial<BusinessRecord>): BusinessRecord {
  return {
    id: "r",
    name: "",
    context: "",
    status: "Planned",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {},
    related: [],
    source: "",
    freshness: "",
    ...extra,
  }
}

const TODAY = "2026-09-16"

describe("collectionWindowRange", () => {
  test("any date has no range; the others are inclusive from today", () => {
    assert.equal(collectionWindowRange("any", TODAY), null)
    assert.deepEqual(collectionWindowRange("today", TODAY), { from: TODAY, to: TODAY })
    assert.deepEqual(collectionWindowRange("next-7", TODAY), { from: TODAY, to: "2026-09-23" })
    assert.deepEqual(collectionWindowRange("next-30", TODAY), { from: TODAY, to: "2026-10-16" })
  })
})

describe("routeStopIndex", () => {
  const routes = [
    stub({ id: "route-1", submittedValues: { serviceDate: "2026-09-18", actualDate: "2026-09-18" } }),
    // A shifted collection: the truck comes on the actual date.
    stub({ id: "route-2", submittedValues: { serviceDate: "2026-09-25", actualDate: "2026-09-28" } }),
    stub({ id: "route-x", status: "Cancelled", submittedValues: { serviceDate: "2026-09-17" } }),
  ]
  const pickups = [
    stub({ id: "p1", submittedValues: { routeId: "route-1", containerId: "bin-a", serviceDate: "2026-09-18" } }),
    stub({ id: "p2", submittedValues: { routeId: "route-2", containerId: "bin-a", serviceDate: "2026-09-25" } }),
    stub({ id: "p3", submittedValues: { routeId: "route-x", containerId: "bin-b", serviceDate: "2026-09-17" } }),
    stub({ id: "p4", status: "Skipped", submittedValues: { routeId: "route-1", containerId: "bin-c", serviceDate: "2026-09-18" } }),
  ]

  test("maps containers to the sorted dates their routes actually run", () => {
    const index = routeStopIndex(routes, pickups)
    assert.deepEqual(index.get("bin-a"), ["2026-09-18", "2026-09-28"])
    assert.equal(index.has("bin-b"), false, "cancelled routes count for nothing")
    assert.equal(index.has("bin-c"), false, "skipped pickups count for nothing")
  })

  test("a stop that names its container by the Container ID label — an API stop over the fixture containers (#179) — counts for the container carrying that label, as the routes link it", () => {
    const stops = [stub({ id: "p5", facts: { "Container ID": "BIN-91001" }, submittedValues: { routeId: "route-1", containerId: "asset-0193" } })]
    const containers = [stub({ id: "asset-seed-91001", facts: { "Container ID": "bin-91001" } }), stub({ id: "asset-seed-91002", facts: { "Container ID": "BIN-91002" } })]
    const index = routeStopIndex(routes, stops, containers)
    assert.deepEqual(index.get("asset-seed-91001"), ["2026-09-18"], "by label, whatever the case")
    assert.deepEqual(index.get("asset-0193"), ["2026-09-18"], "and under the id it names")
    assert.equal(index.has("asset-seed-91002"), false)
    assert.equal(routeStopIndex(routes, stops).has("asset-seed-91001"), false, "without the containers, the id alone")
  })
})

describe("nextCollectionDate", () => {
  const index = new Map([["bin-a", ["2026-09-10", "2026-09-18", "2026-09-28"]]])

  test("the earliest generated date on or after today wins", () => {
    assert.equal(nextCollectionDate(stub({ id: "bin-a" }), index, TODAY), "2026-09-18")
  })

  test("without generated routes the Next collection fact is read, when it is not in the past", () => {
    assert.equal(
      nextCollectionDate(stub({ id: "bin-z", facts: { "Next collection": "28 Sep 2026" } }), index, TODAY),
      "2026-09-28",
    )
    assert.equal(
      nextCollectionDate(stub({ id: "bin-z", facts: { "Next collection": "28 Aug 2026" } }), index, TODAY),
      null,
    )
    assert.equal(
      nextCollectionDate(stub({ id: "bin-z", facts: { "Next collection": "Not scheduled" } }), index, TODAY),
      null,
    )
  })
})

describe("inCollectionWindow", () => {
  test("any admits everything; a window needs a date inside it", () => {
    assert.equal(inCollectionWindow(null, "any", TODAY), true)
    assert.equal(inCollectionWindow(null, "next-7", TODAY), false)
    assert.equal(inCollectionWindow("2026-09-23", "next-7", TODAY), true)
    assert.equal(inCollectionWindow("2026-09-24", "next-7", TODAY), false)
    assert.equal(inCollectionWindow(TODAY, "today", TODAY), true)
  })
})
