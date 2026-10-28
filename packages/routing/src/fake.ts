// The deterministic fake provider (#131: CI runs only this; no
// OpenRouteService credential exists on the public repository). Same request,
// same bytes, every time: a leg is the straight line between its two points,
// measured by haversine and driven at a fixed speed; optimisation is
// nearest-neighbour from the depot, ties to the lowest index, so an optimised
// sequence differs visibly from the baseline in demos and in the e2e.
//
// It keeps the provider's rules that shape a caller — fifty waypoints a
// directions request, fifty locations an optimisation, a stop sent with a
// reload two (O15 of #290), whose order goes to the station whenever no
// stop left fits the vehicle — and answers a
// scripted quota state (#132 §7): a reading per family that counts down by
// one per answered call, and responses handed out one per call, in order —
// the minute's 429, the day's 403 with its headers, the key's 403 without
// them or its 401, a semantic 400 or 404 with a sentence, or an answer with
// a reading of its own (the fresh window after a reset) — so the engine's
// and the jobs' tests prove pacing, the reserve, deferral, the reset and the
// key refusal without a credential. `calls` counts every call it was asked,
// so a test can prove one was never made.
import type { Position2D } from "@waste/contracts/geojson"

import { distinctConsecutive, haversine } from "./geodesy"
import type { MeasureRequest, MeasureResult, OptimiseRequest, OptimiseResult, Provenance, ProviderAnswer, QuotaFamily, QuotaReading, RoutedLeg, RoutingProvider } from "./provider"

/** 36 km/h flat: a leg's seconds are its metres over this, rounded. */
export const FAKE_SPEED_METRES_PER_SECOND = 10

/**
 * The provider's own per-request limits (#118), kept so a caller that forgets
 * to chunk is refused here too: fifty waypoints a directions request, and
 * fifty locations an optimisation, counted as vroom-express counts them — a
 * job one, a shipment two, the vehicle's start and end none — so a station
 * held last as a job is one of them (OPTIMISER_MAX_LOCATIONS).
 */
const MAX_WAYPOINTS = 50
const MAX_LOCATIONS = 50

/** Great-circle distance, whole metres. */
export const haversineMetres = (a: Position2D, b: Position2D): number => Math.round(haversine(a, b))

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

/** A response the script hands out in place of the unscripted one. */
export type FakeResponse =
  /** An answer, reporting this reading and counting down from it from here on. */
  | { status: 200; quota: QuotaReading }
  | { status: 429; retryAfterSeconds?: number }
  /** The day's quota: a 403 carrying the rate-limit headers. */
  | { status: 403; quota: true }
  /** The key refused: a 403 without the headers. */
  | { status: 403 }
  | { status: 401 }
  | { status: 400 | 404; sentence: string }

/** What a test scripts the fake to report, per family. */
export type FakeScript = {
  /** The reading an answered call reports, counting down by one per answered call; no limit where unset. */
  quota?: Partial<Record<QuotaFamily, QuotaReading>>
  /** Responses handed out one per call, in order, before the family answers unscripted again. */
  responses?: Partial<Record<QuotaFamily, readonly FakeResponse[]>>
}

const NO_LIMIT: QuotaReading = { remaining: null, limit: null, resetAt: null }

export class FakeProvider implements RoutingProvider {
  readonly name = "fake"
  readonly maxWaypoints = MAX_WAYPOINTS
  /** Every call asked of each family, answered or refused. */
  readonly calls: Record<QuotaFamily, number> = { directions: 0, optimisation: 0 }
  private readonly readings: Record<QuotaFamily, QuotaReading>
  private readonly responses: Record<QuotaFamily, FakeResponse[]>

  constructor(script: FakeScript = {}) {
    this.readings = { directions: { ...(script.quota?.directions ?? NO_LIMIT) }, optimisation: { ...(script.quota?.optimisation ?? NO_LIMIT) } }
    this.responses = { directions: [...(script.responses?.directions ?? [])], optimisation: [...(script.responses?.optimisation ?? [])] }
  }

  measure(request: MeasureRequest): Promise<ProviderAnswer<MeasureResult>> {
    if (request.points.length < 2) return Promise.reject(new Error("fake.measure: a measurement takes at least two points"))
    return Promise.resolve(
      this.call<MeasureResult>("directions", () =>
        request.points.length > MAX_WAYPOINTS
          ? { refused: `the request has ${request.points.length} waypoints; the maximum is ${MAX_WAYPOINTS}` }
          : { result: { legs: legsAlong(request.points), provenance: PROVENANCE } },
      ),
    )
  }

  optimise(request: OptimiseRequest): Promise<ProviderAnswer<OptimiseResult>> {
    return Promise.resolve(
      this.call<OptimiseResult>("optimisation", () => {
        const reload = request.station ? (request.reload ?? null) : null
        // A shipment is two locations, its pickup and its delivery, and a station held last by its window one more, as vroom-express counts them (O15 of #290).
        const locations = request.stops.length * (reload ? 2 : 1) + (request.station && !reload ? 1 : 0)
        if (locations > MAX_LOCATIONS) return { refused: `the request has ${locations} locations; one optimisation takes at most ${MAX_LOCATIONS}` }
        const remaining = request.stops.map((stop, index) => ({ stop, index }))
        const order: number[] = []
        const unloads: number[] = []
        let at = request.depot
        let load = 0
        while (remaining.length > 0) {
          // The nearest stop the vehicle can take on; none, and it unloads at the station first. An empty vehicle takes any.
          const fits = (index: number) => reload === null || load === 0 || load + (reload.amounts[index] ?? 0) <= reload.capacityKg
          let nearest = -1
          let best = Number.POSITIVE_INFINITY
          for (let candidate = 0; candidate < remaining.length; candidate += 1) {
            const distance = haversine(at, remaining[candidate].stop)
            if (fits(remaining[candidate].index) && distance < best) {
              nearest = candidate
              best = distance
            }
          }
          if (nearest < 0) {
            unloads.push(order.length)
            at = request.station as Position2D
            load = 0
            continue
          }
          const [next] = remaining.splice(nearest, 1)
          order.push(next.index)
          load += reload?.amounts[next.index] ?? 0
          at = next.stop
        }
        const station = request.station
        const driven = order.flatMap((index, place) => (station && unloads.includes(place) ? [station, request.stops[index]] : [request.stops[index]]))
        const trip: Position2D[] = [request.depot, ...driven, ...(station ? [station] : []), request.depot]
        return { result: { order, ...(unloads.length > 0 ? { unloads } : {}), legs: legsAlong(distinctConsecutive(trip)), waitingSeconds: 0, provenance: PROVENANCE } }
      }),
    )
  }

  /** One call of the family: the next scripted response if there is one, else the answer, the reading counted down. */
  private call<Result>(family: QuotaFamily, answer: () => { result: Result } | { refused: string }): ProviderAnswer<Result> {
    this.calls[family] += 1
    const scripted = this.responses[family].shift()
    if (scripted?.status === 200) this.readings[family] = { ...scripted.quota }
    const reading = this.readings[family]
    if (scripted !== undefined && scripted.status !== 200) {
      if (scripted.status === 429) return { kind: "rate-limited", retryAfterSeconds: scripted.retryAfterSeconds ?? null, quota: { ...reading } }
      if (scripted.status === 403 && "quota" in scripted) {
        reading.remaining = 0
        return { kind: "quota-exhausted", quota: { ...reading } }
      }
      if (scripted.status === 403 || scripted.status === 401) return { kind: "key-refused", status: scripted.status }
      return { kind: "refused", status: scripted.status, sentence: scripted.sentence, quota: { ...reading } }
    }
    const outcome = answer()
    if ("refused" in outcome) return { kind: "refused", status: 400, sentence: outcome.refused, quota: { ...reading } }
    if (reading.remaining !== null) reading.remaining = Math.max(0, reading.remaining - 1)
    return { kind: "answered", result: outcome.result, quota: { ...reading } }
  }
}
