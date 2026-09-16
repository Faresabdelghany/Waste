import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { ROUTE_BUCKET_COLORS, routesInSelection, routesInWindow } from "../routes"

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
  record(
    "route-day-1044",
    { Area: "Nørrebro", Vehicle: "WH-24", Driver: "Mads Jensen", "Time window": "06:10–14:18" },
    { name: "RC-1044", status: "Completed", value: "42 stops" },
  ),
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

describe("route colours", () => {
  test("a route is coloured by its status bucket, not its position in the list", () => {
    const summary = routesInSelection(containers.slice(0, 3), routes, pickups, containers)
    const byId = new Map(summary.routes.map((route) => [route.id, route]))
    assert.equal(byId.get("route-gen-1")!.color, ROUTE_BUCKET_COLORS.awaiting)
    assert.equal(byId.get("route-day-1048")!.color, ROUTE_BUCKET_COLORS["in-progress"])
    assert.equal(byId.get("route-day-1044")!.color, ROUTE_BUCKET_COLORS.completed)
  })
})

describe("route details", () => {
  test("a route carries vehicle, driver, time window, its stop count, and a Route Studio link", () => {
    const summary = routesInSelection(containers.slice(0, 3), routes, pickups, containers)
    const fixture = summary.routes.find((route) => route.id === "route-day-1044")!
    assert.equal(fixture.vehicle, "WH-24")
    assert.equal(fixture.driver, "Mads Jensen")
    assert.equal(fixture.timeWindow, "06:10–14:18")
    assert.equal(fixture.stopCount, 42, "the record's own stop count wins over the partial fixture pickups")
    assert.equal(fixture.href, "/route-studio?module=routes&record=route-day-1044")
    const generated = summary.routes.find((route) => route.id === "route-gen-1")!
    assert.equal(generated.vehicle, null)
    assert.equal(generated.stopCount, 3, "a generated route counts its pickups")
  })
})

describe("routesInWindow", () => {
  test("without a window every drawable route is returned, selected or not", () => {
    const rows = routesInWindow(routes, pickups, containers, null)
    assert.deepEqual(
      rows.map((route) => route.name),
      ["RC-7001", "RC-7002", "RC-1044"],
      "awaiting, then in progress, then completed; RC-1048 has no stops, RC-7003 is cancelled, RC-7004 stops at an unknown container",
    )
    assert.ok(rows.every((route) => route.stops.length > 0))
  })

  test("with a window only routes dated inside it remain; the actual date wins; dateless routes drop out", () => {
    const seventeenth = routesInWindow(routes, pickups, containers, { from: "2026-09-17", to: "2026-09-17" })
    assert.deepEqual(seventeenth.map((route) => route.name), ["RC-7002"])
    const later = routesInWindow(routes, pickups, containers, { from: "2026-09-18", to: "2026-09-30" })
    assert.deepEqual(later.map((route) => route.name), ["RC-7001"])
    const sixteenth = routesInWindow(routes, pickups, containers, { from: "2026-09-16", to: "2026-09-16" })
    assert.deepEqual(sixteenth, [], "RC-7002 moved to the 17th; RC-1044 has no date")
  })
})

describe("route stops", () => {
  test("each located stop carries its order, kind, label, planned and actual time, and status", () => {
    const depot = record(
      "p0",
      { Type: "Depot", Address: "Sundkrogsgade 21, 2100 København Ø", Stop: "1", Scheduled: "06:10", "Completed at": "06:10" },
      { name: "Stop 1 · Nordhavn Depot", status: "Completed", submittedValues: { routeId: "route-gen-2" } },
    )
    const collected = record(
      "p4b",
      { Stop: "2", Scheduled: "06:32", "Completed at": "06:41" },
      { name: "Stop 2 · Amagerbrogade 5", status: "Completed", submittedValues: { routeId: "route-gen-2", containerId: "d" } },
    )
    const planned = record(
      "p4c",
      { Stop: "3" },
      { name: "Stop 3 · Ryesgade 12", status: "Planned", value: "06:50 · Scheduled", submittedValues: { routeId: "route-gen-2", containerId: "a" } },
    )
    const [route] = routesInWindow([routes[1]], [depot, collected, planned], containers, null)
    assert.deepEqual(
      route.stops.map((stop) => [stop.index, stop.kind, stop.containerId, stop.label, stop.planned, stop.actual, stop.status]),
      [
        [1, "depot", null, "Nordhavn Depot", "06:10", "06:10", "Completed"],
        [2, "container", "d", "Amagerbrogade 5", "06:32", "06:41", "Completed"],
        [3, "container", "a", "Ryesgade 12", "06:50", null, "Planned"],
      ],
    )
    assert.deepEqual(route.containerIds, ["d", "a"], "depot stops are not containers")
    assert.equal(route.stopCount, 3)
    assert.ok(route.stops.every((stop) => Number.isFinite(stop.lngLat.lng) && Number.isFinite(stop.lngLat.lat)))
  })

  test("a pickup at an unknown container with no address has no place on the map and is skipped", () => {
    const lost = record("p9", { Stop: "1" }, { status: "Planned", submittedValues: { routeId: "route-gen-1", containerId: "zzz" } })
    const kept = record("p10", { Stop: "2" }, { status: "Planned", submittedValues: { routeId: "route-gen-1", containerId: "a" } })
    const [route] = routesInWindow([routes[0]], [lost, kept], containers, null)
    assert.deepEqual(route.stops.map((stop) => stop.containerId), ["a"])
    assert.equal(route.stopCount, 2, "the record still counts both pickups")
  })
})

describe("address-only stops", () => {
  test("a pickup at no container is placed by its address only when the street is in the gazetteer", () => {
    const known = record(
      "p11",
      { Type: "Depot", Address: "Ryesgade 60, 2200 København N", Stop: "1" },
      { name: "Stop 1 · Ryesgade Depot", status: "Planned", submittedValues: { routeId: "route-gen-1" } },
    )
    const unknown = record(
      "p12",
      { Address: "Nowhere Lane 3, 9999 Elsewhere", Stop: "2" },
      { name: "Stop 2 · Nowhere Lane 3", status: "Planned", submittedValues: { routeId: "route-gen-1" } },
    )
    const served = record("p13", { Stop: "3" }, { status: "Planned", submittedValues: { routeId: "route-gen-1", containerId: "a" } })
    const [route] = routesInWindow([routes[0]], [known, unknown, served], containers, null)
    assert.deepEqual(
      route.stops.map((stop) => [stop.index, stop.kind, stop.label]),
      [
        [1, "depot", "Ryesgade Depot"],
        [3, "container", "Ryesgade 12"],
      ],
      "the unknown street has no honest place on the map, so it is left out rather than scattered",
    )
  })
})
