// The guided setup's route map (Issue #39, 2026-09-25): where a drafted
// route's stops are, so the wizard can draw it on the planning map and ask a
// routing engine for the road through them instead of a polyline through
// hashed pins. A stop is a matched container placed by containerLocation —
// the address on a gazetteer street, typed coordinates first, the hashed
// fallback for an address the gazetteer misses, like every container marker
// on the planning map — in the order generation writes them, never an
// optimised sequence (ADR-0002). The route starts at the scheme's departure
// depot and ends at its unloading station when the draft names them and the
// registry places them (placeLocation: typed coordinates or a gazetteer
// street, never hashed); a route with neither is drawn between its stops
// alone and the preview says so. Pure data logic — no map library, no store;
// the gazetteer is the caller's (Issue #58).

import type { BusinessRecord } from "../prototype-record"
import { boundsFromPolygon, type LngLat, type LngLatBounds } from "./geo"
import { containerLocation, placeLocation, type Gazetteer } from "./positions"

export type PreviewStopKind = "depot" | "container" | "station"

export type PreviewStop = {
  kind: PreviewStopKind
  /** The container served, when the stop is one. */
  containerId: string | null
  /** The container's name (BIN-91001), the depot's or the station's. */
  label: string
  lngLat: LngLat
}

export type RoutePreview = {
  /** Depot first and station last when placed; the located containers between, in generation's order. */
  stops: PreviewStop[]
  /** Containers of the route the registry cannot place — out of service, or without an address. */
  unplaced: number
  /** The depot stands at the start of the line. */
  fromDepot: boolean
  /** The station stands at its end. */
  toStation: boolean
  /** Around every drawn stop; null when nothing is drawn. */
  bounds: LngLatBounds | null
}

export type RoutePreviewInput = {
  /** The route's container ids in stop order. */
  containerIds: readonly string[]
  containers: readonly BusinessRecord[]
  depot: BusinessRecord | null | undefined
  station: BusinessRecord | null | undefined
  gazetteer: Gazetteer
}

/** The drawable stops of one drafted route, depot to station. */
export function routePreview(input: RoutePreviewInput): RoutePreview {
  const byId = new Map(input.containers.map((record) => [record.id, record]))
  const depotAt = input.depot ? placeLocation(input.depot, input.gazetteer) : null
  const stationAt = input.station ? placeLocation(input.station, input.gazetteer) : null
  const stops: PreviewStop[] = []
  if (input.depot && depotAt) {
    stops.push({ kind: "depot", containerId: null, label: input.depot.name, lngLat: depotAt })
  }
  let unplaced = 0
  for (const containerId of input.containerIds) {
    const record = byId.get(containerId)
    const lngLat = record ? containerLocation(record, input.gazetteer) : null
    if (!record || !lngLat) {
      unplaced += 1
      continue
    }
    stops.push({ kind: "container", containerId, label: record.name, lngLat })
  }
  if (input.station && stationAt) {
    stops.push({ kind: "station", containerId: null, label: input.station.name, lngLat: stationAt })
  }
  return {
    stops,
    unplaced,
    fromDepot: Boolean(input.depot && depotAt),
    toStation: Boolean(input.station && stationAt),
    bounds: stops.length > 0 ? boundsFromPolygon(stops.map((stop) => stop.lngLat)) : null,
  }
}

/** The bounds around several previews together — the day's routes in one frame; null when none draws. */
export function previewsBounds(previews: readonly RoutePreview[]): LngLatBounds | null {
  const points = previews.flatMap((preview) => preview.stops.map((stop) => stop.lngLat))
  return points.length > 0 ? boundsFromPolygon(points) : null
}
