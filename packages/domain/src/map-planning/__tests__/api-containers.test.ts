// The map's readers of where a container lies and whether it serves (#232): a
// container the API holds names every area the placement serving it today
// lies in (`containerAreaIds`) and is in service by that placement
// (`containerInService`), not by one stored area id and the fixtures' status.
// Each reader below meets one in two overlapping areas, and one whose
// placement starts later.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { SERVING_KEY } from "../../route-schemes/matching"
import { planningAreaLayers } from "../areas"
import { serviceAreasForSelection } from "../coverage"
import { needsService } from "../coverage-gaps"
import { MAP_FILTER_READERS, withRouteSchemeNames } from "../filters"
import type { MapPoint } from "../points"
import { routeSchemeIndex } from "../schedule"
import { schemeDraftFromSelection } from "../selection"
import { serviceAreaSeedFromSelection } from "../service-areas"
import { TEST_GAZETTEER } from "./gazetteer-fixture"

function record(id: string, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return { id, name: id, context: "", status: "No stock record", owner: "", value: "", updated: "", description: "", facts: {}, related: [], source: "", freshness: "", ...extra }
}

const ASOF = "2026-10-24"
/** A container the API holds at Parkvej, its serving read today: in both Østerbro areas, or (`later`) serving from November only. */
function held(id: string, later = false): BusinessRecord {
  const period = later ? { from: "2026-11-02", until: null, areaIds: ["area-osterbro", "area-block"], fractions: ["Residual"] } : { from: "2026-01-01", until: null, areaIds: ["area-osterbro", "area-block"], fractions: ["Residual"] }
  return record(id, {
    facts: later ? {} : { "Planning area": "Østerbro Zone 2 · Parkvej Block", Agreement: "AGR-2408 · active" },
    submittedValues: { ...(later ? {} : { latitude: "55.7012", longitude: "12.5709", planningAreaId: "area-osterbro" }), [SERVING_KEY]: JSON.stringify({ asOf: ASOF, periods: [period] }) },
  })
}
const osterbro = record("area-osterbro", { name: "Østerbro Zone 2" })
const block = record("area-block", { name: "Parkvej Block" })

describe("a container the API holds, on the map", () => {
  test("counts in every planning area's layer it lies in today, not only the first", () => {
    const layers = planningAreaLayers([osterbro, block], [held("bin-1")], TEST_GAZETTEER)
    assert.deepEqual(layers.map((layer) => [layer.name, layer.containerCount]), [["Østerbro Zone 2", 1], ["Parkvej Block", 1]])
  })

  test("is covered by a service area awarding the second of its areas", () => {
    const awarded = record("sa-block", { name: "CA-Block", status: "Active", submittedValues: { zoneIds: "area-block" } })
    assert.deepEqual(serviceAreasForSelection([held("bin-1")], [awarded], TEST_GAZETTEER).map((row) => [row.id, row.containers]), [["sa-block", 1]])
  })

  test("seeds a service area with every area it lies in", () => {
    assert.deepEqual(serviceAreaSeedFromSelection({ selected: [held("bin-1")], shape: null, planningAreas: [osterbro, block], properties: 1 }).planningAreaIds, ["area-osterbro", "area-block"])
  })

  test("seeds a scheme with the one area every selected container shares, and none where they share two", () => {
    const point = (container: BusinessRecord): MapPoint => ({ id: container.id, lngLat: { lng: 12.5709, lat: 55.7012 }, fractions: ["Residual"], label: container.id, sublabel: "", propertyKey: "parkvej", containerIds: [container.id], record: container })
    const fixture = record("bin-2", { status: "Available", submittedValues: { planningAreaId: "area-osterbro" } })
    assert.equal(schemeDraftFromSelection([point(held("bin-1")), point(fixture)], new Set(["bin-1", "bin-2"])).planningAreaId, "area-osterbro")
    assert.equal(schemeDraftFromSelection([point(held("bin-1"))], new Set(["bin-1"])).planningAreaId, undefined, "two areas: no one to prefill")
  })

  test("needs service while a placement serves it today, whatever its asset state; not before its placement starts", () => {
    assert.equal(needsService(held("bin-1")), true)
    assert.equal(needsService(held("bin-3", true)), false)
  })

  test("is filtered by each of its areas", () => {
    assert.deepEqual(MAP_FILTER_READERS.planningAreas?.(held("bin-1")), ["Østerbro Zone 2", "Parkvej Block"])
  })

  test("is filtered by each scheme whose live routes stop at it, a name holding ' · ' kept whole; a fixture's by its own", () => {
    const route = (id: string, scheme: string, status = "Planned") => record(id, { status, facts: { "Route scheme": scheme }, submittedValues: { serviceDate: "2026-10-26" } })
    const stop = (id: string, routeId: string, containerId: string) => record(id, { status: "Planned", submittedValues: { routeId, containerId } })
    const routes = [route("route-1", "RS-Central · Week A"), route("route-2", "RS-Østerbro · Organic B"), route("route-3", "RS-Gone", "Cancelled")]
    const stops = [stop("stop-1", "route-1", "bin-1"), stop("stop-2", "route-2", "bin-1"), stop("stop-3", "route-1", "bin-1"), stop("stop-4", "route-3", "bin-1")]
    const index = routeSchemeIndex(routes, stops, [held("bin-1")])
    assert.deepEqual(index.get("bin-1"), ["RS-Central · Week A", "RS-Østerbro · Organic B"], "once each, a cancelled route's left out")
    const fixture = record("bin-5", { facts: { "Route scheme": "RS-Central · Week A" } })
    const [mapped, kept] = withRouteSchemeNames([held("bin-1"), fixture], new Map([["bin-1", index.get("bin-1") ?? []], ["bin-5", ["Another"]]]))
    assert.deepEqual(MAP_FILTER_READERS.routeSchemes?.(mapped), ["RS-Central · Week A", "RS-Østerbro · Organic B"])
    assert.deepEqual(MAP_FILTER_READERS.routeSchemes?.(kept), ["RS-Central · Week A"], "a fixture's own fact, whole")
  })
})
