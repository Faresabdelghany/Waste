// A stop's estimated arrival (O8 of #290, decided on #344): the route's
// active Plan driven from its departure, with its progress. The arithmetic is
// the Plan's own, so what the office is told agrees with what was optimised
// (packages/routing, `routeShift`):
//
//   the clock     — starts at the route's start once it has one (`started_at`),
//                   else at its departure (`departureOf`: the planned start,
//                   or the planned driver's shift), never earlier than now
//                   for a route not yet started;
//   the legs      — `plan_leg.seconds` in driving order. A full trip's first
//                   leg leaves the depot for its first stop and its last two
//                   are the final tip and the drive home; a stops-only trip
//                   starts at its first stop. A Plan cut into parts (O15) is
//                   one chain of legs all the same, each once;
//   a stop        — its seconds at the kerb (`serviceSecondsOf`), served no
//                   earlier than its window opens: the vehicle arriving
//                   before waits for it, as the optimiser's does (O14). A
//                   window that cannot be met, `disjoint`, waits for
//                   nothing;
//   an unload     — a Plan stop of kind `unload` on the way (O15) takes
//                   `UNLOAD_SECONDS` at the station; the final tip at the
//                   trip's end is the trip's own and adds none, as the
//                   over-shift verdict counts it;
//   the progress  — a stop the driver decided (completed, or skipped or
//                   failed for one of the driver's reasons) is passed, and
//                   the clock stands at its outcome; a stop the vehicle is at
//                   (`arrived_at`) is arrived; on a running route no stop
//                   still to come arrives before now, so a late vehicle's
//                   estimates slide forward with it rather than lie in the
//                   past. A stop the system closed — ended with the route,
//                   cancelled, removed or moved by the dispatcher, dropped by
//                   generation — is passed without its kerb time and without
//                   moving the clock, the vehicle never having been there;
//                   an unload visit before the last stop decided is passed
//                   too.
//
// Breaks are left out: the optimiser places the driver's break where it
// fits, and a Plan does not say where, so an estimate after it may be early
// by its minutes. A stop the active Plan does not name — the office's, added
// after it — has no estimate, and neither does any stop of a route without a
// measured Plan or a departure, or of a route that has ended.
//
// Every instant is epoch milliseconds; the caller turns the project's clock —
// the departure and the windows, times of the operating day — into instants.
import { UNLOAD_SECONDS } from "../routing/reloads"
import type { PlanTrip } from "../routing/vocabulary"
import { DRIVER_PICKUP_REASONS, type PickupReason, type PickupStatus, type RouteStatus } from "./vocabulary"

/** A Plan stop as the estimate reads it, in the Plan's order. */
export type EtaStop =
  | {
      kind: "pickup"
      pickupId: string
      status: PickupStatus
      reason: PickupReason | null
      /** When the driver decided it, or the system closed it. */
      outcomeAt: number | null
      /** When the vehicle first arrived, where it has. */
      arrivedAt: number | null
      serviceSeconds: number
      /** The instants its window opens and closes on the operating day, none, or `disjoint`. */
      window: readonly [number, number] | null | "disjoint"
    }
  | { kind: "unload" }

export type EtaInput = {
  routeStatus: RouteStatus
  /** The route's start, once it has started. */
  startedAt: number | null
  /** When it is planned to leave, on its operating day; null where neither the route nor its driver says. */
  plannedDeparture: number | null
  trip: PlanTrip
  stops: readonly EtaStop[]
  /** The active Plan's legs' seconds in driving order; null for a Plan not measured. */
  legs: readonly number[] | null
  now: number
}

/** A Plan stop's estimate: the instant the vehicle is expected there, or null where it has been passed or nothing can be said. */
export type EtaReading = { kind: "pickup"; pickupId: string; eta: number | null } | { kind: "unload"; eta: number | null }

export type RouteEta = {
  /** In the Plan's order. */
  stops: EtaReading[]
  /** When the trip is expected to end — back at the depot on a full trip, done at its last stop on a stops-only one — or null. */
  finishAt: number | null
}

/** The legs a trip of `stops` Plan stops drives: one into each stop but a stops-only trip's first, and a full trip's two home. */
export const legsOfTrip = (trip: PlanTrip, stops: number): number => (stops === 0 ? 0 : trip === "full" ? stops + 2 : stops - 1)

const DRIVER_REASONS: ReadonlySet<PickupReason> = new Set(DRIVER_PICKUP_REASONS)

/** Whether the driver decided the stop: the vehicle was there, and the clock stands at its outcome. */
const decided = (stop: Extract<EtaStop, { kind: "pickup" }>): boolean => stop.status === "completed" || ((stop.status === "skipped" || stop.status === "failed") && stop.reason !== null && DRIVER_REASONS.has(stop.reason))

const nothing = (stops: readonly EtaStop[]): RouteEta => ({
  stops: stops.map((stop) => (stop.kind === "pickup" ? { kind: "pickup", pickupId: stop.pickupId, eta: null } : { kind: "unload", eta: null })),
  finishAt: null,
})

/** Each Plan stop's estimated arrival, and the trip's end, from the route's departure and progress over its active Plan. */
export function routeEta(input: EtaInput): RouteEta {
  const { stops, legs, trip, now } = input
  const running = input.routeStatus === "active"
  if (!running && input.routeStatus !== "planned" && input.routeStatus !== "ready") return nothing(stops)
  if (legs === null || stops.length === 0 || legs.length !== legsOfTrip(trip, stops.length)) return nothing(stops)
  const start = running ? input.startedAt : input.plannedDeparture === null ? null : Math.max(input.plannedDeparture, now)
  if (start === null) return nothing(stops)

  // The last stop the driver decided: an unload visit before it is behind the vehicle.
  let lastDecided = -1
  for (const [index, stop] of stops.entries()) if (stop.kind === "pickup" && decided(stop)) lastDecided = index

  let clock = start
  const readings: EtaReading[] = []
  for (const [index, stop] of stops.entries()) {
    // The leg into this stop: a full trip's legs start at the depot, a stops-only trip's at its first stop.
    const legIn = trip === "full" ? legs[index] : index === 0 ? 0 : legs[index - 1]
    const expected = clock + legIn * 1000
    if (stop.kind === "unload") {
      if (index < lastDecided) {
        readings.push({ kind: "unload", eta: null })
        clock = expected
        continue
      }
      const arrival = running ? Math.max(expected, now) : expected
      readings.push({ kind: "unload", eta: arrival })
      clock = arrival + UNLOAD_SECONDS * 1000
      continue
    }
    if (stop.status !== "planned") {
      readings.push({ kind: "pickup", pickupId: stop.pickupId, eta: null })
      // Decided by the driver: the vehicle was there, and left by its outcome. Closed by the system: never visited, so neither its kerb time nor its outcome moves the clock.
      clock = decided(stop) ? (stop.outcomeAt ?? expected + stop.serviceSeconds * 1000) : expected
      continue
    }
    const arrival = stop.arrivedAt ?? (running ? Math.max(expected, now) : expected)
    const opens = stop.window === null || stop.window === "disjoint" ? arrival : Math.max(arrival, stop.window[0])
    readings.push({ kind: "pickup", pickupId: stop.pickupId, eta: arrival })
    const leaves = opens + stop.serviceSeconds * 1000
    // A vehicle at the stop leaves it no earlier than now, however long it has stood there.
    clock = running && stop.arrivedAt !== null ? Math.max(leaves, now) : leaves
  }
  const home = trip === "full" ? (legs[stops.length] + legs[stops.length + 1]) * 1000 : 0
  return { stops: readings, finishAt: clock + home }
}
