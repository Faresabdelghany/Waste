// The pure rules of a Plan's life (#124 §2–3). The tables, the jobs and the
// API are I/O around these two readings; anything that needs a row lock or a
// clock lives with the writer, not here.
import type { OptimiseFallback, PlanSolver, PlanTrip } from "./vocabulary"

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
 * The solver an Optimise request gets (#124 §4, #171): the optimiser for
 * fifty open stops or fewer from a depot, and otherwise a `baseline`
 * measurement of the generated order with the token that says why — the size
 * first, the older rule, when both hold. The optimiser orders from the depot
 * (the provider's vehicle starts and ends there), so a route naming none has
 * nothing to order from.
 */
export function optimiseSolver({ openStops, hasDepot }: { openStops: number; hasDepot: boolean }): { solver: "optimiser"; fallback: null } | { solver: "baseline"; fallback: OptimiseFallback } {
  if (openStops > OPTIMISER_MAX_STOPS) return { solver: "baseline", fallback: "too-many-stops" }
  if (!hasDepot) return { solver: "baseline", fallback: "no-depot" }
  return { solver: "optimiser", fallback: null }
}

/**
 * Whether a routing job's Plan has been overtaken, and so is `failed ·
 * superseded` with no call (#132 §4), or, its answer landed, kept `ready` and
 * never activated. A `manual` or `baseline` Plan is active from creation, so
 * once it is not the route's active Plan nobody will read its measurement.
 * An `optimiser` Plan is never active before it is ready, so it is overtaken
 * by an active Plan newer than itself: the optimiser's answer to a later
 * request (amending #124 §2, where the optimiser's result activated on ready
 * unconditionally). Where an activation is written it fails the waiting
 * optimisations it overtakes at once (`activatePlan`, `activateSolved`,
 * @waste/db/commands/plans), a re-activated Plan's id being no newer than
 * theirs; this reading is the jobs' own check before a call and before an
 * answer is made active. Plan ids are UUIDv7, time-ordered, so newer is the
 * greater id.
 */
export function isSuperseded({ solver, planId, activePlanId }: { solver: PlanSolver; planId: string; activePlanId: string | null }): boolean {
  if (solver !== "optimiser") return activePlanId !== planId
  return activePlanId !== null && activePlanId > planId
}

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
