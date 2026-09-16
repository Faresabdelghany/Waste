import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { routesInSelection } from "../routes"

function record(id: string, facts: Record<string, string> = {}, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id,
    name: id,
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

const bin = (id: string, address: string, area: string) =>
  record(id, { "Container ID": id.toUpperCase(), Address: address, Property: address.split(",")[0], "Planning area": area })

const containers = [
  bin("a", "Ryesgade 12, 2200 København N", "Østerbro Zone 2"),
  bin("b", "Ryesgade 40, 2200 København N", "Østerbro Zone 2"),
  bin("c", "Jagtvej 10, 2200 København N", "Indre By Operations"),
  bin("d", "Amagerbrogade 5, 2300 København S", "Amager Zone 1"),
]

const routes = [
  // Generated: linked through typed pickups.
  record("route-gen-1", { Area: "Elsewhere" }, { name: "RC-7001", status: "Planned", submittedValues: { serviceDate: "2026-09-18" } }),
  record("route-gen-2", {}, { name: "RC-7002", status: "Active", submittedValues: { serviceDate: "2026-09-16", actualDate: "2026-09-17" } }),
  // Fixture-shaped: pickups name it by display facts.
  record("route-day-1044", { Area: "Nørrebro" }, { name: "RC-1044", status: "Completed" }),
  // Fixture-shaped with no pickups at all: linked by the Area fact prefix.
  record("route-day-1048", { Area: "Østerbro" }, { name: "RC-1048", status: "Active" }),
  // Cancelled — never counted.
  record("route-gen-3", {}, { name: "RC-7003", status: "Cancelled" }),
  // Touches nothing selected.
  record("route-gen-4", { Area: "Valby" }, { name: "RC-7004", status: "Planned" }),
]

const pickups = [
  record("p1", { Stop: "2" }, { status: "Planned", submittedValues: { routeId: "route-gen-1", containerId: "a" } }),
  record("p2", { Stop: "1" }, { status: "Planned", submittedValues: { routeId: "route-gen-1", containerId: "c" } }),
  record("p3", { Stop: "3" }, { status: "Planned", submittedValues: { routeId: "route-gen-1", containerId: "b" } }),
  record("p4", {}, { status: "Planned", submittedValues: { routeId: "route-gen-2", containerId: "d" } }),
  record("p5", { Route: "RC-1044", "Container ID": "B", Stop: "1" }, { status: "Completed" }),
  record("p6", {}, { status: "Planned", submittedValues: { routeId: "route-gen-3", containerId: "a" } }),
  record("p7", {}, { status: "Planned", submittedValues: { routeId: "route-gen-4", containerId: "zzz" } }),
]

describe("routesInSelection", () => {
  test("counts the routes whose stops touch the selection by status bucket", () => {
    const summary = routesInSelection(containers.slice(0, 3), routes, pickups, containers)
    assert.equal(summary.total, 3, "RC-7001 (pickups), RC-1044 (display pickup), RC-1048 (area fact)")
    assert.equal(summary.awaiting, 1)
    assert.equal(summary.inProgress, 1)
    assert.equal(summary.completed, 1)
    assert.deepEqual(summary.routes.map((route) => route.name), ["RC-7001", "RC-1048", "RC-1044"])
  })

  test("a route carries its date, bucket, colour, and its located stops in stop order", () => {
    const summary = routesInSelection(containers.slice(0, 3), routes, pickups, containers)
    const gen = summary.routes.find((route) => route.id === "route-gen-1")!
    assert.equal(gen.bucket, "awaiting")
    assert.equal(gen.date, "2026-09-18")
    assert.deepEqual(gen.containerIds, ["c", "a", "b"], "ordered by the Stop fact")
    assert.equal(gen.stops.length, 3)
    assert.ok(gen.color.startsWith("#"))
    const byArea = summary.routes.find((route) => route.id === "route-day-1048")!
    assert.equal(byArea.bucket, "in-progress")
    assert.equal(byArea.date, null)
    assert.deepEqual(byArea.stops, [], "no pickups, nothing to draw")
  })

  test("the actual date wins over the service date; nothing selected means no routes", () => {
    const summary = routesInSelection([containers[3]], routes, pickups, containers)
    assert.deepEqual(summary.routes.map((route) => [route.name, route.date]), [["RC-7002", "2026-09-17"]])
    assert.deepEqual(routesInSelection([], routes, pickups, containers).total, 0)
  })
})
