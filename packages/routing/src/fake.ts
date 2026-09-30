// The deterministic fake provider (#131: CI runs only this; no
// OpenRouteService credential exists on the public repository). Same request,
// same bytes, every time: a leg is the straight line between its two points,
// measured by haversine and driven at a fixed speed; optimisation is
// nearest-neighbour from the depot, ties to the lowest index, so an optimised
// sequence differs visibly from the baseline in demos and in the e2e.
//
// It keeps the provider's rules that shape a caller — fifty waypoints a
// directions request, fifty locations an optimisation — and answers a
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
 * fifty stops an optimisation, as the domain's OPTIMISER_MAX_STOPS reads the
 * provider's fifty locations — whether its depot and station count against
 * them is unverified (#118), so the fake counts the stops alone.
 */
const MAX_WAYPOINTS = 50
const MAX_STOPS = 50

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
        if (request.stops.length > MAX_STOPS) return { refused: `the request has ${request.stops.length} stops; one optimisation takes at most ${MAX_STOPS}` }
        const remaining = request.stops.map((stop, index) => ({ stop, index }))
        const order: number[] = []
        let at = request.depot
        while (remaining.length > 0) {
          let nearest = 0
          let best = haversine(at, remaining[0].stop)
          for (let candidate = 1; candidate < remaining.length; candidate += 1) {
            const distance = haversine(at, remaining[candidate].stop)
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
        return { result: { order, legs: legsAlong(distinctConsecutive(trip)), provenance: PROVENANCE } }
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
