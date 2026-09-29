// The deterministic fake provider (#131: CI runs only this; no
// OpenRouteService credential exists on the public repository). Same request,
// same bytes, every time: a leg is the straight line between its two points,
// measured by haversine and driven at a fixed speed; optimisation is
// nearest-neighbour from the depot, ties to the lowest index, so an optimised
// sequence differs visibly from the baseline in demos and in the e2e. The
// scripted quota state exists for S3's engine tests (#171): the fake itself
// never refuses a call.
import type { Position2D } from "@waste/contracts/geojson"

import type { MeasureRequest, MeasureResult, OptimiseRequest, OptimiseResult, Provenance, QuotaFamily, QuotaReading, RoutedLeg, RoutingProvider } from "./provider"

/** 36 km/h flat: a leg's seconds are its metres over this, rounded. */
export const FAKE_SPEED_METRES_PER_SECOND = 10

const EARTH_RADIUS_METRES = 6_371_000
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

/** Great-circle distance, whole metres. */
export function haversineMetres([lonA, latA]: Position2D, [lonB, latB]: Position2D): number {
  const dLat = toRadians(latB - latA)
  const dLon = toRadians(lonB - lonA)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(latA)) * Math.cos(toRadians(latB)) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a)))
}

const PROVENANCE: Provenance = { engineVersion: "fake", graphDate: null }

const legBetween = (from: Position2D, to: Position2D): RoutedLeg => {
  const metres = haversineMetres(from, to)
  return {
    geometry: { type: "LineString", coordinates: [from, to] },
    metres,
    seconds: Math.round(metres / FAKE_SPEED_METRES_PER_SECOND),
  }
}

const legsAlong = (points: readonly Position2D[]): RoutedLeg[] => points.slice(1).map((point, index) => legBetween(points[index], point))

/** What a test scripts the fake to report; S3 extends this with refusals. */
export type FakeScript = {
  quota?: Partial<Record<QuotaFamily, QuotaReading>>
}

const NO_LIMIT: QuotaReading = { remaining: null, limit: null, resetAt: null }

export class FakeProvider implements RoutingProvider {
  readonly name = "fake"
  private readonly script: FakeScript

  constructor(script: FakeScript = {}) {
    this.script = script
  }

  measure(request: MeasureRequest): Promise<MeasureResult> {
    if (request.points.length < 2) return Promise.reject(new Error("fake.measure: a measurement takes at least two points"))
    return Promise.resolve({ legs: legsAlong(request.points), provenance: PROVENANCE })
  }

  optimise(request: OptimiseRequest): Promise<OptimiseResult> {
    const remaining = request.stops.map((stop, index) => ({ stop, index }))
    const order: number[] = []
    let at = request.depot
    while (remaining.length > 0) {
      let nearest = 0
      let best = haversineMetres(at, remaining[0].stop)
      for (let candidate = 1; candidate < remaining.length; candidate += 1) {
        const distance = haversineMetres(at, remaining[candidate].stop)
        if (distance < best) {
          nearest = candidate
          best = distance
        }
      }
      const [next] = remaining.splice(nearest, 1)
      order.push(next.index)
      at = next.stop
    }
    const trip: Position2D[] = [request.depot, ...order.map((index) => request.stops[index]), ...(request.station ? [request.station] : []), request.depot]
    return Promise.resolve({ order, legs: legsAlong(trip), provenance: PROVENANCE })
  }

  quota(family: QuotaFamily): QuotaReading {
    return this.script.quota?.[family] ?? NO_LIMIT
  }
}
