// The pure rules of a Plan's life (#124 §2–3). The tables, the jobs and the
// API are I/O around these two readings; anything that needs a row lock or a
// clock lives with the writer, not here.
import type { PlanSolver, PlanTrip } from "./vocabulary"

/**
 * Whether a Plan of this solver is the Route's active Plan from the moment it
 * is created (#124 §2). A `manual` or `baseline` Plan carries a sequence that
 * is already known, so it activates on creation and its measurement only adds
 * numbers — a measurement that fails leaves it active, unmeasured and dashed.
 * An `optimiser` Plan has no sequence until the provider answers, so it
 * activates atomically on `ready` and a failure leaves the previously active
 * Plan in place.
 */
export const activeOnCreation = (solver: PlanSolver): boolean => solver !== "optimiser"

/**
 * What the measurement covers (#124 §3): the modelled trip
 * `depot → stops → station → depot` when the Route names both ends, and the
 * stops alone otherwise — stored and displayed as partial, never implying the
 * full trip.
 */
export const tripOf = ({ hasDepot, hasStation }: { hasDepot: boolean; hasStation: boolean }): PlanTrip =>
  hasDepot && hasStation ? "full" : "stops-only"

/** The optimiser's ceiling: one optimisation request takes at most fifty locations (#118); above it a Plan is `baseline`, measured and read "Not optimised". */
export const OPTIMISER_MAX_STOPS = 50

/**
 * The current execution order (#170): the active Plan's sequence for the
 * stops it names — one it names that is no longer the route's is dropped, not
 * invented — and the stops it does not name appended in baseline order
 * (#124 §2), so a driver never loses the last usable order because one bin
 * joined the day. `sequence` on the wire is a stop's ordinal here, computed
 * on every read and never stored. Without an active Plan the baseline stands.
 */
export function executionOrder(baseline: readonly string[], planOrder: readonly string[] | null): string[] {
  if (planOrder === null) return [...baseline]
  const present = new Set(baseline)
  const named = planOrder.filter((id) => present.has(id))
  const namedSet = new Set(named)
  return [...named, ...baseline.filter((id) => !namedSet.has(id))]
}

/**
 * Staleness, a reading and never a status (#124 §2): the route's stops moved
 * under the active Plan — a stop was inserted that the Plan does not name, or
 * one it names was removed by regeneration. A stop the driver decided is
 * progress, not staleness.
 */
export function planIsStale({ named, open, removed }: { named: readonly string[]; open: readonly string[]; removed: readonly string[] }): boolean {
  const namedSet = new Set(named)
  if (open.some((id) => !namedSet.has(id))) return true
  const removedSet = new Set(removed)
  return named.some((id) => removedSet.has(id))
}
