// The map's readers of where a container lies and whether it serves (#232): a
// container the API holds names the areas its placement serving today lies
// in, by id and by name (`containerAreaRefs`), and is in service by that
// placement (`containerInService`), not by one stored area id and the
// fixtures' status. Each reader below meets one in two overlapping areas, one
// whose placement starts later, and one in an area whose name holds " · ".
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { containerAreaRefs, containerServesAhead, SERVING_KEY } from "../../route-schemes/matching"
import { planningAreaLayers } from "../areas"
import { serviceAreasForSelection } from "../coverage"
import { needsService } from "../coverage-gaps"
import { MAP_FILTER_READERS, mapFilterReaders } from "../filters"
import type { MapPoint } from "../points"
import { routeSchemeIndex } from "../schedule"
import { schemeDraftFromSelection } from "../selection"
import { serviceAreaSeedFromSelection } from "../service-areas"
import { TEST_GAZETTEER } from "./gazetteer-fixture"

function record(id: string, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return { id, name: id, context: "", status: "No stock record", owner: "", value: "", updated: "", description: "", facts: {}, related: [], source: "", freshness: "", ...extra }
}

const ASOF = "2026-10-24"
type Period = { from: string; until?: string | null; areaIds: string[]; areaNames: string[]; shown?: true }
/** A container the API holds at Parkvej, its serving read today. */
function held(id: string, periods: Period[], located = true): BusinessRecord {
  return record(id, {
    facts: located ? { "Planning area": "for a person to read", Agreement: "AGR-2408 · active" } : {},
    submittedValues: {
      ...(located ? { latitude: "55.7012", longitude: "12.5709" } : {}),
      [SERVING_KEY]: JSON.stringify({ asOf: ASOF, periods: periods.map((period) => ({ until: null, fractions: ["Residual"], ...period })) }),
    },
  })
}
const BOTH: Period = { from: "2026-01-01", areaIds: ["area-osterbro", "area-block"], areaNames: ["Østerbro Zone 2", "Parkvej Block"], shown: true }
const today = () => held("bin-1", [BOTH])
const later = () => held("bin-3", [{ from: "2026-11-02", areaIds: ["area-osterbro"], areaNames: ["Østerbro Zone 2"], shown: true }], false)
const osterbro = record("area-osterbro", { name: "Østerbro Zone 2" })
const block = record("area-block", { name: "Parkvej Block" })

describe("a container the API holds, on the map", () => {
  test("lies in the areas of the placement the record shows, where that one serves today", () => {
    assert.deepEqual(containerAreaRefs(today()), { ids: ["area-osterbro", "area-block"], names: ["Østerbro Zone 2", "Parkvej Block"] })
    const handover = held("bin-6", [{ from: "2026-01-01", areaIds: ["area-osterbro"], areaNames: ["Østerbro Zone 2"], shown: true }, { from: "2026-10-01", areaIds: ["area-amager"], areaNames: ["Amager Zone 1"] }])
    assert.deepEqual(containerAreaRefs(handover).ids, ["area-osterbro"], "where its marker stands")
    assert.deepEqual(containerAreaRefs(later()), { ids: [], names: [] }, "in no area today")
  })

  test("counts in every planning area's layer it lies in today, not only the first", () => {
    const layers = planningAreaLayers([osterbro, block], [today()], TEST_GAZETTEER)
    assert.deepEqual(layers.map((layer) => [layer.name, layer.containerCount]), [["Østerbro Zone 2", 1], ["Parkvej Block", 1]])
  })

  test("is covered by a service area awarding the second of its areas", () => {
    const awarded = record("sa-block", { name: "CA-Block", status: "Active", submittedValues: { zoneIds: "area-block" } })
    assert.deepEqual(serviceAreasForSelection([today()], [awarded], TEST_GAZETTEER).map((row) => [row.id, row.containers]), [["sa-block", 1]])
  })

  test("seeds a service area with every area it lies in", () => {
    assert.deepEqual(serviceAreaSeedFromSelection({ selected: [today()], shape: null, planningAreas: [osterbro, block], properties: 1 }).planningAreaIds, ["area-osterbro", "area-block"])
  })

  test("seeds a scheme with the one area every selected container shares, and none where they share two", () => {
    const point = (container: BusinessRecord): MapPoint => ({ id: container.id, lngLat: { lng: 12.5709, lat: 55.7012 }, fractions: ["Residual"], label: container.id, sublabel: "", propertyKey: "parkvej", containerIds: [container.id], record: container })
    const fixture = record("bin-2", { status: "Available", submittedValues: { planningAreaId: "area-osterbro" } })
    assert.equal(schemeDraftFromSelection([point(today()), point(fixture)], new Set(["bin-1", "bin-2"])).planningAreaId, "area-osterbro")
    assert.equal(schemeDraftFromSelection([point(today())], new Set(["bin-1"])).planningAreaId, undefined, "two areas: no one to prefill")
  })

  test("needs service while a placement serves it today, whatever its asset state; one serving only later still serves ahead", () => {
    assert.equal(needsService(today()), true)
    assert.equal(needsService(later()), false)
    assert.deepEqual([containerServesAhead(later()), containerServesAhead(held("bin-7", []))], [true, false], "a later stop is no unservable one; none at all is")
  })

  test("is filtered by each of its areas, a name holding ' · ' kept whole", () => {
    assert.deepEqual(MAP_FILTER_READERS.planningAreas?.(today()), ["Østerbro Zone 2", "Parkvej Block"])
    const nord = held("bin-8", [{ from: "2026-01-01", areaIds: ["area-nord"], areaNames: ["Østerbro · Nord"], shown: true }])
    assert.deepEqual(MAP_FILTER_READERS.planningAreas?.(nord), ["Østerbro · Nord"])
    const fixture = record("bin-9", { status: "Available", facts: { "Planning area": "Indre By Operations" }, submittedValues: { planningAreaId: "—" } })
    assert.deepEqual(containerAreaRefs(fixture), { ids: [], names: ["Indre By Operations"] }, "a fixture's placeholder id is none: its fact names it")
  })

  test("is filtered by each scheme whose routes stop at it from today on, by the scheme's own name kept whole; a fixture's by its own", () => {
    const route = (id: string, schemeId: string, date: string, status = "Planned") => record(id, { status, submittedValues: { schemeId, serviceDate: date } })
    const stop = (id: string, routeId: string, containerId: string) => record(id, { status: "Planned", submittedValues: { routeId, containerId } })
    const routes = [route("route-1", "scheme-a", "2026-10-26"), route("route-2", "scheme-b", "2026-10-27"), route("route-3", "scheme-c", "2026-10-26", "Cancelled"), route("route-4", "scheme-d", "2026-10-20", "Completed"), route("route-5", "scheme-e", "2026-10-28")]
    const stops = ["route-1", "route-2", "route-3", "route-4", "route-5", "route-1"].map((routeId, index) => stop(`stop-${index}`, routeId, "bin-1"))
    const names = new Map([["scheme-a", "RS-Central · Week A"], ["scheme-b", "RS-Østerbro · Organic B"], ["scheme-c", "RS-Gone"], ["scheme-d", "RS-Last month"]])
    const index = routeSchemeIndex(routes, stops, [today()], { today: ASOF, nameOf: (id) => names.get(id) })
    assert.deepEqual(index.get("bin-1"), ["RS-Central · Week A", "RS-Østerbro · Organic B"], "once each; a cancelled, a completed and an unknown scheme's left out")
    const readers = mapFilterReaders(index)
    assert.deepEqual(readers.routeSchemes?.(today()), ["RS-Central · Week A", "RS-Østerbro · Organic B"])
    assert.deepEqual(readers.routeSchemes?.(record("bin-1", { facts: { "Route scheme": "RS-Fixture · Week B" } })), ["RS-Fixture · Week B"], "a fixture's own fact, whole")
  })
})
