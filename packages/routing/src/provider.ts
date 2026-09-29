// The provider interface every routing call goes through (#39 S1, decided on
// #124 §4): the worker's measurement and optimisation jobs and, from S2/S5,
// the API's preview all speak this shape, so swapping the fake for
// OpenRouteService (#171) changes a constructor and nothing else. No call
// here is ever made inside a database transaction; that rule lives with the
// callers and #124 spells it.
import type { LineString, Position2D } from "@waste/contracts/geojson"

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

/** Measure a known sequence: one leg per consecutive pair of points, in order. */
export type MeasureRequest = {
  /** The routing profile, `driving-hgv` unless a caller says otherwise. */
  profile: string
  /** At least two points, `[longitude, latitude]` each, in the order driven. */
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
  /** The unloading station before the return, when the Route names one (#124 §3). */
  station?: Position2D | null
}

export type OptimiseResult = {
  /** Indices into the request's `stops`, in the order the solver chose. */
  order: number[]
  /** The whole trip's legs: depot, the stops in `order`, the station where given, back to the depot. */
  legs: RoutedLeg[]
  provenance: Provenance
}

/** The provider's two request families, each with its own quota (#132 §1). */
export type QuotaFamily = "directions" | "optimisation"

/** What the provider last said about a family's quota; nulls where it enforces none (the fake's default). */
export type QuotaReading = {
  remaining: number | null
  limit: number | null
  /** When the daily window resets, ISO instant, where the provider reports one. */
  resetAt: string | null
}

export type RoutingProvider = {
  /** The name the fingerprint carries: `fake`, `openrouteservice`. */
  name: string
  measure(request: MeasureRequest): Promise<MeasureResult>
  optimise(request: OptimiseRequest): Promise<OptimiseResult>
  /** The family's last-seen quota; S3's engine reads it before every call. */
  quota(family: QuotaFamily): QuotaReading
}
