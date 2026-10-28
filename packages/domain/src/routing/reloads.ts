// Multi-trip unloading (O15 of #290). A route heavier than its planned
// vehicle's payload no longer tips once at the end and reads "over": its Plan
// visits the Unloading Station on the way whenever the vehicle is full, and
// goes on from there, each visit a Plan stop of kind `unload`. The visit after
// the last stop stays the full trip's own end (#124 §3), never a stop.
//
// The loads are the workload's (O10, `stopLoadKg`, ../execution/workload):
// each stop's expected kilograms, a stop that loads no waste or whose weight
// nothing says weighing nothing, against the planned vehicle's payload. A stop
// heavier than the vehicle is read as a full one, so it is a trip of its own
// and never a stop the Plan cannot place. Reloads need the station, so only a
// full trip has them.
//
// The optimiser places the visits itself (packages/routing): each stop is a
// shipment, its load picked up at the stop and delivered at the station, and
// the vehicle carries its payload. vroom-express counts a shipment as two
// locations against the fifty one request takes, and the vehicle's start and
// end as none, so a request with reloads holds half the stops one without
// does. A known order — a dispatcher's or the generated one — is cut where the
// next stop would not fit (`unloadsAlong`), the fewest visits that order can
// make.
import type { PlanSolver, PlanTrip } from "./vocabulary"

/** The locations one optimisation request takes (#118): vroom-express counts a job as one and a shipment as two. */
export const OPTIMISER_MAX_LOCATIONS = 50

/** The stops one optimisation with reloads takes: each stop is a shipment, two locations. */
export const RELOAD_MAX_STOPS = OPTIMISER_MAX_LOCATIONS / 2

/** An unload visit's time at the station, weighing in and emptying: a typical figure, like a work order's (../execution/workload). */
export const UNLOAD_SECONDS = 900

/** What a request with reloads carries: the payload, and each stop's load by its index into the request's stops. */
export type Reload = { capacityKg: number; amounts: readonly number[] }

/**
 * The reload a request over these stops carries, or null for one that tips
 * once at the end as before: a full trip, a payload known, and the stops'
 * loads over it. An optimiser request takes reloads only while its stops fit
 * one request as shipments (`RELOAD_MAX_STOPS`); a larger one is ordered as
 * before, one tip at the end and its load read as over.
 */
export function reloadOf({ solver, trip, capacityKg, stopKg }: { solver: PlanSolver; trip: PlanTrip; capacityKg: number | null; stopKg: readonly (number | null)[] }): Reload | null {
  if (trip !== "full" || capacityKg === null || capacityKg <= 0) return null
  const amounts = stopKg.map((kg) => Math.min(Math.max(kg ?? 0, 0), capacityKg))
  if (amounts.reduce((sum, kg) => sum + kg, 0) <= capacityKg) return null
  if (solver === "optimiser" && amounts.length > RELOAD_MAX_STOPS) return null
  return { capacityKg, amounts }
}

/**
 * The unload visits along a known order: before each stop the vehicle cannot
 * take on top of what it carries, the count of stops driven before the visit.
 * The loads are in the order driven, each at most the payload (`reloadOf`).
 */
export function unloadsAlong(amounts: readonly number[], capacityKg: number): number[] {
  const after: number[] = []
  let load = 0
  amounts.forEach((kg, index) => {
    if (index > 0 && load + kg > capacityKg) {
      after.push(index)
      load = 0
    }
    load += kg
  })
  return after
}

/** A Plan's stop as it is written: one of the route's pickups, or an unload visit on the way. */
export type PlanStopEntry = { kind: "pickup"; pickupId: string } | { kind: "unload" }

/** The pickups in their order with the unload visits between them, each after the count of pickups `unloads` names. */
export function withUnloads(pickupIds: readonly string[], unloads: readonly number[]): PlanStopEntry[] {
  const at = new Set(unloads)
  return pickupIds.flatMap((pickupId, index): PlanStopEntry[] => (at.has(index) ? [{ kind: "unload" }, { kind: "pickup", pickupId }] : [{ kind: "pickup", pickupId }]))
}
