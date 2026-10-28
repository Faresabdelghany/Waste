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
// words, never a Plan. A Route whose stops outweigh its vehicle (O15 of
// #290) sends them as shipments to the station instead, and the answer's
// station visits before the last stop are its unloads on the way. A stop's window and the driver's breaks (O14 of #290)
// ride the same clock, seconds from the operating date's midnight: the
// windows are hard, so a stop no order reaches inside its own is
// unassigned, and the answer says which for the caller to ask again without
// those windows (a Plan never loses a stop), while the shift's end is never a bound —
// a route too long for its shift is ordered, and the verdict told it. The
// waiting the windows make is read off the steps, the station's week apart.
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
import { UNLOAD_SECONDS } from "@waste/domain/routing/reloads"

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

/** A week in seconds: every stop's time window closes before it and the station's opens at it; a stop's own window (O14 of #290) is a day's. */
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

/** The horizon of the optimiser's clock: past every window of the day and the station's, so nothing a day holds is bounded by it. */
const HORIZON = STATION_OPENS + 2 * DAY_SECONDS

/**
 * The optimisation request: a job per stop with its seconds at the kerb and
 * its window where given, the station held last by its own, and one vehicle
 * from and back to the depot, leaving at its departure and taking its
 * driver's breaks (O14 of #290). Every time is seconds from the operating
 * date's midnight, so a stop's window and a break's are a day's and the
 * station's, a week in, opens after every one of them; a stop without a
 * window on a trip with a station is held to the week before it. The vehicle
 * is bounded by the horizon alone, never by its shift's end.
 *
 * A request with a reload (O15 of #290) sends each stop as a shipment
 * instead: its load picked up at the stop and delivered at the station, the
 * vehicle carrying its payload, so the solver goes to the station whenever
 * the vehicle is full and once more after the last stop, and no window holds
 * the station back. Each visit takes the unload's time once, however many
 * loads it delivers (`setup`, spent on arriving at a new place).
 */
function vroomRequest({ profile, depot, stops, serviceSeconds, timeWindows, departure, breaks, station, reload }: OptimiseRequest) {
  const reloading = station && reload ? reload : null
  const stopTask = (location: Position2D, index: number) => {
    const service = serviceSeconds?.[index]
    const window = timeWindows?.[index] ?? (station && !reloading ? ([0, STATION_OPENS - 1] as const) : null)
    return { id: index + 1, location, ...(service === undefined ? {} : { service }), ...(window === null ? {} : { time_windows: [[window[0], window[1]]] }) }
  }
  const jobs: Record<string, unknown>[] = reloading ? [] : stops.map(stopTask)
  if (station && !reloading) jobs.push({ id: stops.length + 1, location: station, time_windows: [[STATION_OPENS, STATION_OPENS + DAY_SECONDS]] })
  const shipments = reloading
    ? stops.map((location, index) => ({ amount: [reloading.amounts[index] ?? 0], pickup: stopTask(location, index), delivery: { id: index + 1, location: station, setup: UNLOAD_SECONDS } }))
    : []
  const timed = station || (departure ?? null) !== null || (breaks?.length ?? 0) > 0 || (timeWindows?.some((window) => window !== null) ?? false)
  const vehicle = {
    id: 1,
    profile,
    start: depot,
    end: depot,
    ...(reloading ? { capacity: [reloading.capacityKg] } : {}),
    ...(timed ? { time_window: [departure ?? 0, HORIZON] } : {}),
    ...(breaks && breaks.length > 0 ? { breaks: breaks.map((pause, index) => ({ id: index + 1, time_windows: [[pause.window[0], pause.window[1]]], service: pause.seconds })) } : {}),
  }
  return { ...(reloading ? { shipments } : { jobs }), vehicles: [vehicle], options: { g: true } }
}

type Step = Waypoint & { seconds: number }

/** A step's task id: VROOM answers it as `id`, older versions as `job`. */
const taskOf = (step: Record<string, unknown>): unknown => step.id ?? step.job

/** VROOM's answer as the order over the stops and the closed trip's legs; a refusal where it did not order every stop with the station last. */
function vroomResult(body: unknown, request: OptimiseRequest): OptimiseResult | { refused: string } {
  const { stops, station } = request
  const reloading = Boolean(station && request.reload)
  if (!isRecord(body)) throw unreadable("the optimisation answer is not an object")
  if (typeof body.code === "number" && body.code !== 0) return { refused: typeof body.error === "string" ? body.error : `the optimiser answered code ${body.code}` }
  const stationId = stops.length + 1
  // A shipment left is listed as its pickup and its delivery, one stop.
  const left = [...new Set((Array.isArray(body.unassigned) ? body.unassigned : []).map((task) => (isRecord(task) && typeof task.id === "number" ? task.id : -1)))]
  // Only a stop with a window may be left: anything else — the station, a stop without one — is a refusal as it always was.
  const windowedLeft = left.every((id) => id >= 1 && id <= stops.length && (request.timeWindows?.[id - 1] ?? null) !== null)
  if (left.length > 0 && !windowedLeft) return { refused: `the optimiser left ${left.length} ${left.length === 1 ? "stop" : "stops"} unassigned` }
  const missing = new Set(left.map((id) => id - 1))
  if (!Array.isArray(body.routes) || body.routes.length !== 1 || !isRecord(body.routes[0])) throw unreadable("the optimisation answer does not hold one route")
  const route = body.routes[0]
  if (typeof route.geometry !== "string" || !Array.isArray(route.steps)) throw unreadable("the optimised route has no geometry or no steps; the request asks for g")
  const visit = reloading ? "pickup" : "job"
  const steps = route.steps.filter((step): step is Record<string, unknown> => isRecord(step) && (step.type === "start" || step.type === visit || step.type === "delivery" || step.type === "end"))
  // The trip as visits: a stop, or the station — one visit however many loads it takes in a row.
  const visits = steps.filter((step) => step.type === visit || step.type === "delivery").map((step) => (step.type === "delivery" || taskOf(step) === stationId ? "station" : taskOf(step)))
  const trip = visits.filter((task, index) => task !== "station" || visits[index - 1] !== "station")
  const order = trip.filter((task) => task !== "station").map((id) => (typeof id === "number" ? id - 1 : -1))
  if (order.length + missing.size !== stops.length || new Set(order).size !== order.length || order.some((index) => index < 0 || index >= stops.length || missing.has(index))) {
    throw unreadable(`the optimised route does not visit each of the ${stops.length - missing.size} stops it assigned once`)
  }
  if (station && trip.at(-1) !== "station") return { refused: "the optimiser visited the unloading station before the last stop" }
  const unloads: number[] = []
  trip.forEach((task, index) => {
    if (task === "station" && index < trip.length - 1) unloads.push(trip.slice(0, index).filter((other) => other !== "station").length)
  })
  if (unloads.length > 0 && !reloading) return { refused: "the optimiser visited the unloading station before the last stop" }
  if (unloads.includes(0)) return { refused: "the optimiser visited the unloading station before the first stop" }
  const visited: Step[] = steps.map((step, index) => {
    if (typeof step.distance !== "number" || typeof step.duration !== "number") throw unreadable(`step ${index + 1} has no distance or duration; the request asks for g`)
    return { at: position(step.location, `step ${index + 1}`), metres: step.distance, seconds: step.duration }
  })
  // Two stops at one address are one point of the trip, spanning no leg, as are the loads one station visit takes.
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
  // Waiting for a stop's window or a break's, never the week the station's device waits, nor at the station on a reload.
  const waitingSeconds = route.steps
    .filter((step): step is Record<string, unknown> => isRecord(step) && ((step.type === visit && taskOf(step) !== stationId) || step.type === "break"))
    .reduce((sum, step) => sum + (typeof step.waiting_time === "number" ? step.waiting_time : 0), 0)
  return {
    order,
    legs,
    waitingSeconds,
    ...(unloads.length > 0 ? { unloads } : {}),
    ...(missing.size > 0 ? { unassigned: [...missing].sort((a, b) => a - b) } : {}),
    provenance: { engineVersion: null, graphDate: null },
  }
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
