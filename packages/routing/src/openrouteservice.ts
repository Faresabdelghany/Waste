// OpenRouteService behind the adapter (#171, over #118's research): HeiGIT's
// hosted directions and its VROOM optimisation, on `api.heigit.org` — the
// old `api.openrouteservice.org` was switched off on 2026-09-28 — with the
// key in the `Authorization` header and nowhere else. The key belongs to one
// person and never leaves the server (HeiGIT's terms), so this module is the
// only place it is read, from a private field no log line or error prints;
// bodies carry coordinates and opaque job numbers only, never a customer's
// name or address (the terms forbid personal data).
//
// Directions: `POST /openrouteservice/v2/directions/{profile}/geojson` with
// the points and instructions on — the provider answers a segment per pair
// of waypoints only with its instructions (its RouteResultBuilder drops the
// segments otherwise) — as one LineString with the index of every waypoint
// on it (`way_points`), so it splits exactly into one leg per pair, metres
// and seconds rounded from the segments; the instructions themselves are not
// read. The engine's version and graph date are the Plan's provenance.
//
// Optimisation: `POST /vroom/v0`, one vehicle starting and ending at the
// depot, a job per stop numbered from one, `g` for geometry. VROOM answers
// the order as steps, each with the cumulative travel time and road distance
// on arrival, and the whole route as one encoded polyline; the legs are cut
// from it at each step (split.ts) and measured by the steps' own
// differences — travel, never the waiting a time window adds. A Route with
// an unloading station has it visited after every stop (#124 §3) in the
// same request: the station is a job whose time window opens a week in,
// when every stop's has closed, so one optimisation call orders the whole
// trip and spends no directions call (#132's cost). An answer that leaves a
// stop unassigned or visits the station early is a refusal in so many
// words, never a Plan.
//
// Every response's `x-ratelimit-*` headers are its family's reading (the
// reset in Unix seconds, per HeiGIT's own answer); a 403 carrying them is
// the day's quota, one without them the key (#132 §4). A 5xx, a failed
// connection or a body that is not JSON — a connection cut short — is
// thrown, for pg-boss to retry; a well-formed success that does not fit the
// request is a refusal, final, since asking again would pay for the same
// answer. A body the answer does not read is let go, so the pooled
// connection is free for the next call.
import type { Position2D } from "@waste/contracts/geojson"

import { samePosition } from "./geodesy"
import { decodePolyline } from "./polyline"
import type { MeasureRequest, MeasureResult, OptimiseRequest, OptimiseResult, Provenance, ProviderAnswer, QuotaReading, RoutingProvider } from "./provider"
import { legsBetween, waypointIndices, type Waypoint } from "./split"

/** HeiGIT's API host (#118): every service at `/<service>/<version>/`. */
export const OPENROUTESERVICE_HOST = "https://api.heigit.org"

/** One directions request takes at most fifty waypoints (openrouteservice.org/restrictions). */
const MAX_WAYPOINTS = 50

/** A provider call gets a minute; the job's ten minutes hold a chunked trip's five calls and a 429's wait. */
const REQUEST_TIMEOUT_MS = 60_000

/** A week in seconds: every stop's time window closes before it and the station's opens at it. */
const STATION_OPENS = 604_800
const DAY_SECONDS = 86_400

const NO_READING: QuotaReading = { remaining: null, limit: null, resetAt: null }

export type OpenRouteServiceOptions = {
  /** The account's key (`OPENROUTESERVICE_API_KEY`), server-side only. */
  apiKey: string
  /** The one door to the network; a test hands a recording one. */
  fetch?: typeof globalThis.fetch
  host?: string
  timeoutMs?: number
}

/** A response the provider sent that this module cannot read: thrown, so pg-boss retries rather than a leg being invented. */
const unreadable = (what: string): Error => new Error(`openrouteservice: ${what}`)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

const position = (value: unknown, what: string): Position2D => {
  if (!Array.isArray(value) || typeof value[0] !== "number" || typeof value[1] !== "number") throw unreadable(`${what} is not a position`)
  return [value[0], value[1]]
}

const wholeNumber = (value: string | null): number | null => (value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null)

/** Lets go of a body the answer does not read: undici holds a pooled connection until its body is consumed or cancelled. */
const discard = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined)
}

/** The family's reading off a response's headers; null when it sent none of them. */
function quotaOf(headers: Headers): QuotaReading | null {
  const remaining = headers.get("x-ratelimit-remaining")
  const limit = headers.get("x-ratelimit-limit")
  const reset = headers.get("x-ratelimit-reset")
  if (remaining === null && limit === null && reset === null) return null
  const resetSeconds = wholeNumber(reset)
  return { remaining: wholeNumber(remaining), limit: wholeNumber(limit), resetAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString() }
}

/** The provider's own sentence for a refusal, whichever shape its error takes: directions' `{ error: { message } }` or VROOM's `{ error }`. */
async function sentenceOf(response: Response): Promise<string> {
  const fallback = `the routing provider refused the request (HTTP ${response.status})`
  try {
    const body: unknown = await response.json()
    if (!isRecord(body)) return fallback
    if (typeof body.error === "string" && body.error.trim() !== "") return body.error
    if (isRecord(body.error) && typeof body.error.message === "string" && body.error.message.trim() !== "") return body.error.message
    return fallback
  } catch {
    return fallback
  }
}

function provenanceOf(body: Record<string, unknown>): Provenance {
  const engine = isRecord(body.metadata) && isRecord(body.metadata.engine) ? body.metadata.engine : {}
  const graphDate = typeof engine.graph_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(engine.graph_date) ? engine.graph_date.slice(0, 10) : null
  return { engineVersion: typeof engine.version === "string" ? engine.version : null, graphDate }
}

/** One directions answer as legs over the points asked for. */
function directionsResult(body: unknown, points: readonly Position2D[]): MeasureResult {
  if (!isRecord(body) || !Array.isArray(body.features) || !isRecord(body.features[0])) throw unreadable("the directions answer holds no route")
  const feature = body.features[0]
  const geometry = isRecord(feature.geometry) ? feature.geometry.coordinates : undefined
  const properties = isRecord(feature.properties) ? feature.properties : {}
  if (!Array.isArray(geometry)) throw unreadable("the directions answer's route has no line")
  const line = geometry.map((vertex, index) => position(vertex, `vertex ${index + 1} of the line`))
  const wayPoints = properties.way_points
  if (!Array.isArray(wayPoints) || wayPoints.length !== points.length || !wayPoints.every((index) => Number.isInteger(index) && index >= 0 && index < line.length)) {
    throw unreadable(`the directions answer's way_points do not place the ${points.length} points asked for on its line`)
  }
  const segments = properties.segments
  if (!Array.isArray(segments) || segments.length !== points.length - 1) throw unreadable(`the directions answer has no segment for each of its ${points.length - 1} legs`)
  const measures = segments.map((segment, index) => {
    if (!isRecord(segment) || typeof segment.distance !== "number" || typeof segment.duration !== "number") throw unreadable(`segment ${index + 1} has no distance or duration`)
    return { metres: Math.round(segment.distance), seconds: Math.round(segment.duration) }
  })
  return { legs: legsBetween(line, wayPoints as number[], points, measures), provenance: provenanceOf(body) }
}

/** The optimisation request: a job per stop, the station held last by its window, one vehicle from and back to the depot. */
function vroomRequest({ profile, depot, stops, station }: OptimiseRequest) {
  const held = station ? { time_windows: [[0, STATION_OPENS - 1]] } : {}
  const jobs: Record<string, unknown>[] = stops.map((location, index) => ({ id: index + 1, location, ...held }))
  if (station) jobs.push({ id: stops.length + 1, location: station, time_windows: [[STATION_OPENS, STATION_OPENS + DAY_SECONDS]] })
  const vehicle = { id: 1, profile, start: depot, end: depot, ...(station ? { time_window: [0, STATION_OPENS + 2 * DAY_SECONDS] } : {}) }
  return { jobs, vehicles: [vehicle], options: { g: true } }
}

type Step = Waypoint & { seconds: number }

/** VROOM's answer as the order over the stops and the closed trip's legs; a refusal where it did not order every stop with the station last. */
function vroomResult(body: unknown, { stops, station }: OptimiseRequest): OptimiseResult | { refused: string } {
  if (!isRecord(body)) throw unreadable("the optimisation answer is not an object")
  if (typeof body.code === "number" && body.code !== 0) return { refused: typeof body.error === "string" ? body.error : `the optimiser answered code ${body.code}` }
  const unassigned = Array.isArray(body.unassigned) ? body.unassigned.length : 0
  if (unassigned > 0) return { refused: `the optimiser left ${unassigned} ${unassigned === 1 ? "stop" : "stops"} unassigned` }
  if (!Array.isArray(body.routes) || body.routes.length !== 1 || !isRecord(body.routes[0])) throw unreadable("the optimisation answer does not hold one route")
  const route = body.routes[0]
  if (typeof route.geometry !== "string" || !Array.isArray(route.steps)) throw unreadable("the optimised route has no geometry or no steps; the request asks for g")
  const steps = route.steps.filter((step): step is Record<string, unknown> => isRecord(step) && (step.type === "start" || step.type === "job" || step.type === "end"))
  const stationId = stops.length + 1
  const jobIds = steps.filter((step) => step.type === "job").map((step) => step.id ?? step.job)
  const order = jobIds.filter((id) => id !== stationId).map((id) => (typeof id === "number" ? id - 1 : -1))
  if (order.length !== stops.length || new Set(order).size !== stops.length || order.some((index) => index < 0 || index >= stops.length)) {
    throw unreadable(`the optimised route does not visit each of the ${stops.length} stops once`)
  }
  if (station && jobIds.at(-1) !== stationId) return { refused: "the optimiser visited the unloading station before the last stop" }
  const visited: Step[] = steps.map((step, index) => {
    if (typeof step.distance !== "number" || typeof step.duration !== "number") throw unreadable(`step ${index + 1} has no distance or duration; the request asks for g`)
    return { at: position(step.location, `step ${index + 1}`), metres: step.distance, seconds: step.duration }
  })
  // Two stops at one address are one point of the trip, spanning no leg.
  const points = visited.filter((step, index) => index === 0 || !samePosition(step.at, visited[index - 1].at))
  const line = decodePolyline(route.geometry)
  if (line.length < 2) throw unreadable("the optimised route's geometry has fewer than two vertices")
  const measures = points.slice(1).map((step, index) => ({ metres: step.metres - points[index].metres, seconds: step.seconds - points[index].seconds }))
  const legs = legsBetween(
    line,
    waypointIndices(line, points),
    points.map((step) => step.at),
    measures,
  )
  return { order, legs, provenance: { engineVersion: null, graphDate: null } }
}

export class OpenRouteServiceProvider implements RoutingProvider {
  readonly name = "openrouteservice"
  readonly maxWaypoints = MAX_WAYPOINTS
  readonly #apiKey: string
  readonly #fetch: typeof globalThis.fetch
  readonly #host: string
  readonly #timeoutMs: number

  constructor({ apiKey, fetch = globalThis.fetch, host = OPENROUTESERVICE_HOST, timeoutMs = REQUEST_TIMEOUT_MS }: OpenRouteServiceOptions) {
    if (apiKey.trim() === "") throw new Error("openrouteservice: the provider needs its key")
    this.#apiKey = apiKey
    this.#fetch = fetch
    this.#host = host
    this.#timeoutMs = timeoutMs
  }

  measure(request: MeasureRequest): Promise<ProviderAnswer<MeasureResult>> {
    // Instructions on: the per-leg segments come with them and not without.
    return this.#call(`/openrouteservice/v2/directions/${encodeURIComponent(request.profile)}/geojson`, { coordinates: request.points, instructions: true }, (body) => directionsResult(body, request.points))
  }

  optimise(request: OptimiseRequest): Promise<ProviderAnswer<OptimiseResult>> {
    return this.#call("/vroom/v0", vroomRequest(request), (body) => vroomResult(body, request))
  }

  /** One POST, its answer read as #132 §4 tells the statuses apart. */
  async #call<Result>(path: string, body: unknown, read: (body: unknown) => Result | { refused: string }): Promise<ProviderAnswer<Result>> {
    const response = await this.#fetch(`${this.#host}${path}`, {
      method: "POST",
      headers: { Authorization: this.#apiKey, "Content-Type": "application/json", Accept: "application/json, application/geo+json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.#timeoutMs),
    })
    const quota = quotaOf(response.headers)
    if (response.status === 429 || response.status === 403 || response.status === 401 || (!response.ok && response.status >= 500)) await discard(response)
    if (response.status === 429) return { kind: "rate-limited", retryAfterSeconds: wholeNumber(response.headers.get("retry-after")), quota }
    if (response.status === 403) return quota === null ? { kind: "key-refused", status: 403 } : { kind: "quota-exhausted", quota }
    if (response.status === 401) return { kind: "key-refused", status: 401 }
    if (response.status >= 400 && response.status < 500) return { kind: "refused", status: response.status, sentence: await sentenceOf(response), quota }
    if (!response.ok) throw unreadable(`HTTP ${response.status} from ${path}`)
    // Not JSON at all is a body cut short: thrown, and retried.
    const parsed: unknown = await response.json()
    let outcome: Result | { refused: string }
    try {
      outcome = read(parsed)
    } catch (error) {
      // Well-formed, and not an answer to what was asked: final.
      return { kind: "refused", status: response.status, sentence: `the routing provider's answer could not be used (${error instanceof Error ? error.message : String(error)})`, quota }
    }
    if (isRecord(outcome) && "refused" in outcome && typeof outcome.refused === "string") return { kind: "refused", status: response.status, sentence: outcome.refused, quota }
    return { kind: "answered", result: outcome as Result, quota: quota ?? NO_READING }
  }
}
