// Balancing a day across vehicles (O15 of #290, #350's third part). A day's
// routes of one project that have not started are weighed as the route read
// weighs them — their expected load against the planned vehicle's payload
// (O10), their planned work against the driver's shift (O14, `routeShift`),
// the unload visits on the way counted (O15) — and where one runs over either,
// the balance proposes moving its open stops onto routes of the day that can
// take them and stay within both. It proposes and never moves: the office
// accepts the proposal, and each move is O23's — the stop taken off where it
// stood and the office's stop of the same work added on the other route — so
// no route is created or cancelled and generation's identity is untouched
// (ADR-0002).
//
// A stop may go only where it could be put by hand: a route of the same
// service provider (or of the company's own, both), whose vehicle carries its
// fraction (a vehicle naming none carries any), that empties its container
// not already (`emptiedAlready`), and whose working day reaches the stop's
// window. Each round takes, of every stop of the route furthest over and every
// route that can take it, the move that costs the receiving route least —
// its detour to the nearest of its stops and back, and the stop's time at the
// kerb — so stops go to the routes already near them. It stops when no route
// is over, when the routes over have no move left, or at `BALANCE_MOVES_MAX`.
// No provider is asked: distances are straight lines, each metre read as a
// road's `DETOUR_FACTOR` at `BALANCE_SPEED` — an estimate the office reads as
// one, the routes' new Plans measuring the drive once the moves are applied.
import { routeShift, secondsOfDay, type DriverShift } from "../execution/shift"
import { emptiedAlready, type MovingStop } from "../execution/stop-moves"

/** The most moves one balance proposes and applies: the office reads each, and every route they touch is asked a new Plan. */
export const BALANCE_MOVES_MAX = 50

/** A straight line's metres as a road's: a typical city detour. */
export const DETOUR_FACTOR = 1.3

/** 30 km/h, a refuse truck's average between stops, in metres a second. */
export const BALANCE_SPEED = 30_000 / 3600

/** `[longitude, latitude]`. */
export type BalancePosition = readonly [number, number]

/** A stop as the balance reads it: where it is, what it weighs and takes at the kerb, its fraction and its window, beside what a move judges. */
export type BalanceStop = MovingStop & {
  /** Its place, or null for one that cannot be located: never moved. */
  at: BalancePosition | null
  kg: number
  serviceSeconds: number
  wasteFractionId: string
  /** Seconds of the operating date it may be served between, or null for any time. */
  window: readonly [number, number] | null
}

/** A route as the balance reads it: what the route read reads of it, and its stops. */
export type BalanceRoute = {
  id: string
  serviceProviderId: string | null
  /** The fractions its planned vehicle carries; null where the vehicle names none, or there is no vehicle. */
  fractions: readonly string[] | null
  capacityKg: number | null
  shift: DriverShift | null
  plannedStartTime: string | null
  /** Its active Plan's drive, or null without a measured one: the balance estimates it from the stops. */
  driveSeconds: number | null
  waitingSeconds: number | null
  /** The unload visits its active Plan makes on the way. */
  unloads: number
  /** Its expected kilograms, as its workload reads them (`routeWorkload`). */
  kg: number
  /** Seconds at its stops still planned (`routeWorkload`). */
  stopSeconds: number
  /** Every stop it holds, decided or not, in their order; only the open ones move. */
  stops: readonly BalanceStop[]
}

/** A route's day as the balance weighs it, before or after the moves. */
export type DayLoad = {
  kg: number
  workSeconds: number
  /** How far the load runs over the payload, 0 within it; null without a payload. */
  overCapacityKg: number | null
  /** How far the work runs outside the shift, 0 within it; null without a shift. */
  overShiftSeconds: number | null
}

/** One stop moved. */
export type BalanceMove = { pickupId: string; fromRouteId: string; toRouteId: string }

export type BalanceProposal = {
  moves: BalanceMove[]
  /** Every route of the day, as it stands and as the moves would leave it. */
  routes: { routeId: string; before: DayLoad; after: DayLoad }[]
}

const haversine = (a: BalancePosition, b: BalancePosition): number => {
  const radians = Math.PI / 180
  const dLat = (b[1] - a[1]) * radians
  const dLon = (b[0] - a[0]) * radians
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h))
}

/** Straight-line metres as seconds of road. */
const roadSeconds = (metres: number): number => Math.round((metres * DETOUR_FACTOR) / BALANCE_SPEED)

/** A route's drive where it has no measured Plan: its open stops in their order, stop to stop. */
function estimatedDrive(stops: readonly BalanceStop[]): number {
  const located = stops.filter((stop) => stop.status === "planned" && stop.at !== null).map((stop) => stop.at as BalancePosition)
  return located.slice(1).reduce((sum, at, index) => sum + roadSeconds(haversine(located[index], at)), 0)
}

/** The detour a stop costs a route, there and back from the nearest of its other open stops; null where it has none located. */
function detourSeconds(stop: BalanceStop, stops: readonly BalanceStop[]): number | null {
  if (stop.at === null) return null
  let nearest = Number.POSITIVE_INFINITY
  for (const other of stops) {
    if (other.id === stop.id || other.status !== "planned" || other.at === null) continue
    nearest = Math.min(nearest, haversine(stop.at, other.at))
  }
  return nearest === Number.POSITIVE_INFINITY ? null : 2 * roadSeconds(nearest)
}

/** Where a route works: from its start to its shift's end, the whole day without a shift. */
function workingWindow(route: BalanceRoute, startsAt: string | null): [number, number] {
  const from = startsAt === null ? 0 : secondsOfDay(startsAt)
  return [from, route.shift === null ? 86_400 : secondsOfDay(route.shift.to)]
}

/** A route's weighing as it is changed: its kilograms, stop seconds, drive and stops. */
type Working = { route: BalanceRoute; kg: number; stopSeconds: number; driveSeconds: number; stops: BalanceStop[] }

/** The day a route works: the route read's arithmetic (`routeShift`), the unload visits its load needs on the way where it has a payload. */
function loadOf(working: Working): DayLoad {
  const { route } = working
  // Each payload more than the first is a visit on the way; the route keeps the visits its Plan makes where its load has not changed.
  const unloads = route.capacityKg === null || working.kg === route.kg ? route.unloads : Math.max(0, Math.ceil(working.kg / route.capacityKg) - 1)
  const day = routeShift({ shift: route.shift, plannedStartTime: route.plannedStartTime, driveSeconds: working.driveSeconds, waitingSeconds: route.waitingSeconds, stopSeconds: working.stopSeconds, unloads })
  return {
    kg: working.kg,
    workSeconds: day.workSeconds ?? working.driveSeconds + working.stopSeconds,
    overCapacityKg: route.capacityKg === null ? null : Math.max(0, working.kg - route.capacityKg),
    overShiftSeconds: day.overShiftSeconds,
  }
}

/** How far a route runs over, as a share of what it has: the larger of its load over its payload and its work outside its shift. */
function excess(working: Working, load: DayLoad): number {
  const { route } = working
  const overKg = route.capacityKg === null || route.capacityKg === 0 ? 0 : (load.overCapacityKg ?? 0) / route.capacityKg
  const span = route.shift === null ? 0 : secondsOfDay(route.shift.to) - secondsOfDay(route.shift.from)
  const overTime = span <= 0 ? 0 : (load.overShiftSeconds ?? 0) / span
  return Math.max(overKg, overTime)
}

const within = (load: DayLoad): boolean => (load.overCapacityKg ?? 0) === 0 && (load.overShiftSeconds ?? 0) === 0

/** Whether the route can take the stop as the office could by hand: its provider, its vehicle's fractions, its container not emptied there already, its window inside the route's working day. */
export function canTake(route: BalanceRoute, stop: BalanceStop, stops: readonly BalanceStop[], startsAt: string | null): boolean {
  if (stop.status !== "planned" || stop.at === null) return false
  if (route.fractions !== null && !route.fractions.includes(stop.wasteFractionId)) return false
  if (emptiedAlready(stop, stops)) return false
  if (stop.window === null) return true
  const [from, to] = workingWindow(route, startsAt)
  return stop.window[0] < to && stop.window[1] > from
}

/** The balance of a day's routes: the moves that bring the routes over back within their payload and shift, and every route before and after. */
export function balanceDay(routes: readonly BalanceRoute[]): BalanceProposal {
  const working: Working[] = routes.map((route) => ({ route, kg: route.kg, stopSeconds: route.stopSeconds, driveSeconds: route.driveSeconds ?? estimatedDrive(route.stops), stops: [...route.stops] }))
  const before = new Map(working.map((day) => [day.route.id, loadOf(day)] as const))
  const startsAt = new Map(routes.map((route) => [route.id, routeShift({ shift: route.shift, plannedStartTime: route.plannedStartTime, driveSeconds: null, waitingSeconds: null, stopSeconds: 0 }).startsAt] as const))
  const moves: BalanceMove[] = []
  const stuck = new Set<string>()
  while (moves.length < BALANCE_MOVES_MAX) {
    // The route furthest over that still has a move to make.
    const over = working
      .filter((day) => !stuck.has(day.route.id) && !within(loadOf(day)))
      .sort((a, b) => excess(b, loadOf(b)) - excess(a, loadOf(a)) || (a.route.id < b.route.id ? -1 : 1))[0]
    if (over === undefined) break
    let best: { stop: BalanceStop; to: Working; cost: number; leaves: number } | undefined
    for (const stop of over.stops) {
      if (stop.status !== "planned" || stop.at === null) continue
      for (const to of working) {
        if (to === over || to.route.serviceProviderId !== over.route.serviceProviderId) continue
        if (!canTake(to.route, stop, to.stops, startsAt.get(to.route.id) ?? null)) continue
        const added = detourSeconds(stop, to.stops)
        if (added === null) continue
        const after = loadOf({ ...to, kg: to.kg + stop.kg, stopSeconds: to.stopSeconds + stop.serviceSeconds, driveSeconds: to.driveSeconds + added })
        if (!within(after)) continue
        const cost = added + stop.serviceSeconds
        const better = best === undefined || cost < best.cost || (cost === best.cost && (stop.id < best.stop.id || (stop.id === best.stop.id && to.route.id < best.to.route.id)))
        if (better) best = { stop, to, cost, leaves: detourSeconds(stop, over.stops) ?? 0 }
      }
    }
    if (best === undefined) {
      stuck.add(over.route.id)
      continue
    }
    const { stop, to } = best
    moves.push({ pickupId: stop.id, fromRouteId: over.route.id, toRouteId: to.route.id })
    over.kg -= stop.kg
    over.stopSeconds -= stop.serviceSeconds
    over.driveSeconds = Math.max(0, over.driveSeconds - best.leaves)
    over.stops = over.stops.filter((other) => other.id !== stop.id)
    to.kg += stop.kg
    to.stopSeconds += stop.serviceSeconds
    to.driveSeconds += best.cost - stop.serviceSeconds
    to.stops.push(stop)
  }
  return { moves, routes: working.map((day) => ({ routeId: day.route.id, before: before.get(day.route.id) as DayLoad, after: loadOf(day) })) }
}
