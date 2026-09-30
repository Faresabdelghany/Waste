// The provider interface every routing call goes through (#39 S1, decided on
// #124 §4): the worker's measurement and optimisation jobs and, from S5, the
// API's preview all speak this shape, so swapping the fake for
// OpenRouteService (#171) changes a constructor and nothing else. No call
// here is ever made inside a database transaction; that rule lives with the
// callers and #124 spells it.
//
// A call is one request to the provider, and answers what the provider said
// (#132 §4) rather than throwing it: the result with the family's quota
// reading, the minute's limit (429), the day's quota (a 403 with rate-limit
// headers), the key refused (401, or a 403 without them), or a semantic
// refusal with the provider's own sentence (400, 404). What a call throws is
// transient — the network, the provider's own 5xx, a response it could not
// read — and is pg-boss's to retry. The quota engine (quota.ts) sits above
// this and decides what each answer means for the job.
import type { LineString, Position2D } from "@waste/contracts/geojson"
import type { RoutingQuotaFamily } from "@waste/domain/routing/vocabulary"

/** The routing profile every trip here drives, until something needs another: OpenRouteService's heavy-goods profile. */
export const DEFAULT_PROFILE = "driving-hgv"

/** One routed leg between two consecutive points: the geometry and its measure. */
export type RoutedLeg = {
  geometry: LineString
  /** Whole metres; a Plan's totals are the sum of its legs. */
  metres: number
  /** Whole seconds of driving, stop time excluded. */
  seconds: number
}

/** The response-side facts #132 §6 keeps off the fingerprint: recorded on the Plan as provenance. */
export type Provenance = {
  engineVersion: string | null
  /** The provider's graph date, an ISO day, where it reports one. */
  graphDate: string | null
}

/** Measure a known sequence in one request: one leg per consecutive pair of points, in order. */
export type MeasureRequest = {
  /** The routing profile, `driving-hgv` unless a caller says otherwise. */
  profile: string
  /** Two to `maxWaypoints` points, `[longitude, latitude]` each, in the order driven, no two consecutive ones the same. */
  points: readonly Position2D[]
}

export type MeasureResult = {
  legs: RoutedLeg[]
  provenance: Provenance
}

/** Order a stop set from a depot, and measure the trip it chose. */
export type OptimiseRequest = {
  profile: string
  depot: Position2D
  stops: readonly Position2D[]
  /** The unloading station, visited after every stop and before the return (#124 §3), when the Route names one. */
  station?: Position2D | null
}

export type OptimiseResult = {
  /** Indices into the request's `stops`, in the order the solver chose; every stop, once. */
  order: number[]
  /** The closed trip's legs — depot, the stops in `order`, the station where given, back to the depot — one per consecutive pair of distinct points, so two stops at one address span no leg. */
  legs: RoutedLeg[]
  provenance: Provenance
}

/** The provider's two request families, each with its own quota (#132 §1). */
export type QuotaFamily = RoutingQuotaFamily

/** What the provider said about a family's quota on one response; nulls where it enforces none (the fake's default) or sent no header. */
export type QuotaReading = {
  remaining: number | null
  limit: number | null
  /** When the daily window resets, ISO instant, where the provider reports one. */
  resetAt: string | null
}

/** One call's answer. */
export type ProviderAnswer<Result> =
  | { kind: "answered"; result: Result; quota: QuotaReading }
  /** The minute's window is full (429): wait and try again, `retryAfterSeconds` where the provider said. */
  | { kind: "rate-limited"; retryAfterSeconds: number | null; quota: QuotaReading | null }
  /** The day's quota is spent (a 403 with rate-limit headers): refused, never retried before the reset (#118). */
  | { kind: "quota-exhausted"; quota: QuotaReading }
  /** The key itself is refused (401, or a 403 without rate-limit headers): final. */
  | { kind: "key-refused"; status: number }
  /** A request the provider cannot answer (a point it cannot reach, too many locations, an answer that does not fit the request): final, in its own words, with the reading where it sent one. */
  | { kind: "refused"; status: number; sentence: string; quota: QuotaReading | null }

/** What a process that calls no provider needs of it: the name its fingerprints and quota rows are kept under. */
export type RoutingIdentity = { name: string }

export type RoutingProvider = {
  /** The name the fingerprint carries and the quota rows are kept under: `fake`, `openrouteservice`. */
  name: string
  /** The most points one directions request takes; longer trips are measured in chunks (chunk.ts). */
  maxWaypoints: number
  measure(request: MeasureRequest): Promise<ProviderAnswer<MeasureResult>>
  optimise(request: OptimiseRequest): Promise<ProviderAnswer<OptimiseResult>>
}
