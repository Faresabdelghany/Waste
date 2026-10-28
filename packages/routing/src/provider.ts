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
import type { Reload } from "@waste/domain/routing/reloads"
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
  /**
   * Each stop's seconds at the kerb, by its index into `stops` (O10 of #290),
   * where the caller knows them. The solver's cost is the drive, so they never
   * change the order; they are its arrival times', and a leg is still the drive.
   */
  serviceSeconds?: readonly number[]
  /**
   * Each stop's window (O14 of #290), by its index into `stops`: the seconds
   * from the operating date's midnight its service may start between, or null
   * for a stop any time serves. Hard: a stop no order can reach inside its
   * window is left unassigned, and the answer says which (`unassigned`).
   */
  timeWindows?: readonly (readonly [number, number] | null)[]
  /** When the vehicle leaves the depot, seconds from the operating date's midnight; the solver's own clock from zero where absent. */
  departure?: number | null
  /** The driver's breaks (O14 of #290): so many seconds taken inside a window of the day. The shift's end is never a bound, so a route too long for it is still ordered. */
  breaks?: readonly { seconds: number; window: readonly [number, number] }[]
  /** The unloading station, visited after every stop and before the return (#124 §3), when the Route names one. */
  station?: Position2D | null
  /**
   * The payload and each stop's load, by its index into `stops`, where the
   * stops outweigh the vehicle (O15 of #290, `reloadOf` of
   * @waste/domain/routing/reloads): the solver then visits the station on the
   * way whenever the vehicle is full, as well as after the last stop. Only
   * with a station; each stop then counts as two of the request's locations.
   */
  reload?: Reload | null
}

export type OptimiseResult = {
  /** Indices into the request's `stops`, in the order the solver chose; every stop once, but those `unassigned`. */
  order: number[]
  /**
   * The stops no order reached inside their windows (O14 of #290), by index,
   * on a request that sent windows; absent or empty, the order holds every
   * stop. A Plan never loses a stop, so the caller asks again with those
   * stops' windows dropped, and `order` and `legs` here cover the rest only.
   */
  unassigned?: number[]
  /**
   * The unload visits on the way (O15 of #290), on a request with a reload:
   * each the count of stops in `order` driven before it, ascending. The visit
   * after the last stop is the trip's own; absent or empty, there is no other.
   */
  unloads?: number[]
  /** The closed trip's legs — depot, the stops in `order` with the station at each of `unloads`, the station where given, back to the depot — one per consecutive pair of distinct points, so two stops at one address span no leg. */
  legs: RoutedLeg[]
  /** Seconds the order waits for a stop's or a break's window to open (O14 of #290), the station's device never counted; 0 where nothing waits. */
  waitingSeconds: number
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
