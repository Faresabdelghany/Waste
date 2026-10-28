// The pure rules of a Plan's life (#124 §2–3). The tables, the jobs and the
// API are I/O around these two readings; anything that needs a row lock or a
// clock lives with the writer, not here.
import { OPTIMISER_MAX_PARTS, partsNeeded } from "./parts"
import type { OptimiseFallback, PlanSolver, PlanStatus, PlanTrip } from "./vocabulary"

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

/** The locations one optimisation request takes (#118): vroom-express counts a job as one and a shipment as two, the vehicle's start and end as none. */
export const OPTIMISER_MAX_LOCATIONS = 50

/** The stops one optimisation request takes on a stops-only trip, one location a stop. */
export const OPTIMISER_MAX_STOPS = OPTIMISER_MAX_LOCATIONS

/**
 * The open stops one optimisation request takes on this trip: a full trip
 * sends its station as a job of its own (held last by its window), one
 * location more, so it orders one stop fewer than a stops-only trip. A route
 * above it is optimised in parts of this size (./parts.ts).
 */
export const optimiserMaxStops = (trip: PlanTrip): number => OPTIMISER_MAX_LOCATIONS - (trip === "full" ? 1 : 0)

/**
 * The solver an Optimise request gets (#124 §4, #171): the optimiser for the
 * open stops of a route from a depot, in as many requests as they need up to
 * `OPTIMISER_MAX_PARTS` (O15 of #290: fifty stops a request, forty-nine on a
 * full trip, whose station is a location of the request too), and otherwise
 * a `baseline` measurement of the generated order with the token that says
 * why — the size first, the older rule, when both hold. The optimiser orders
 * from the depot (the provider's vehicle starts and ends there), so a route
 * naming none has nothing to order from.
 */
export function optimiseSolver({ openStops, hasDepot, hasStation = false }: { openStops: number; hasDepot: boolean; hasStation?: boolean }): { solver: "optimiser"; fallback: null } | { solver: "baseline"; fallback: OptimiseFallback } {
  if (partsNeeded(openStops, optimiserMaxStops(tripOf({ hasDepot, hasStation }))) > OPTIMISER_MAX_PARTS) return { solver: "baseline", fallback: "too-many-stops" }
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
 * Whether a `ready` or `calculating` Plan that keys a request's fingerprint
 * answers that request (#124 §4, #212): the cache's reuse rule. The
 * fingerprint keys each stop by its place, so it cannot tell two orders of
 * stops at one address apart, nor a Plan over pickups regeneration replaced
 * at the same places; the Plan must name the request's very stops. A
 * `manual` or `baseline` request is an order, so in that order. An
 * `optimiser` request is a set, answered in the solver's order, so as a set;
 * and an optimiser Plan still calculating names no stops yet, its solver
 * reading the route's when it runs, so it answers as it stands.
 */
export function answersRequest({ solver, status, named, asked }: { solver: PlanSolver; status: PlanStatus; named: readonly string[]; asked: readonly string[] }): boolean {
  if (solver === "optimiser" && status === "calculating") return true
  if (named.length !== asked.length) return false
  if (solver !== "optimiser") return named.every((id, index) => id === asked[index])
  const namedSet = new Set(named)
  return new Set(asked).size === asked.length && asked.every((id) => namedSet.has(id))
}

/**
 * What the horizon asks of a route it plans (#172): generation for a route
 * it creates or reshapes, the sweep for one whose active Plan is missing or
 * no longer answers it. The open stops in baseline order under the Optimise
 * request's size rule — the optimiser from a depot, in parts where the stops
 * need them, a `baseline` measurement otherwise (#124 §4) — unless the active Plan is a
 * dispatcher's `manual` one, which the next run never undoes (#124's
 * clobber): then a new `manual` Plan over the order the driver already reads
 * (`executionOrder`), the dispatcher's sequence of the stops it names and the
 * rest appended in baseline order, measured and active from creation. Null,
 * nothing to ask, when the dispatcher asked to optimise after that reorder
 * and the request still waits (`optimisationWaiting`): a manual Plan made
 * active would fail it — a later order wins — and the optimiser reads the
 * route's stops as they stand when it runs.
 */
export function horizonRequest({
  open,
  hasDepot,
  hasStation = false,
  active,
  optimisationWaiting,
}: {
  open: readonly string[]
  hasDepot: boolean
  hasStation?: boolean
  active: { solver: PlanSolver; named: readonly string[] } | null
  /** An optimiser Plan asked after the active one is still calculating. */
  optimisationWaiting: boolean
}): { solver: PlanSolver; orderedPickupIds: string[] } | null {
  if (active?.solver === "manual") return optimisationWaiting ? null : { solver: "manual", orderedPickupIds: executionOrder(open, active.named) }
  return { solver: optimiseSolver({ openStops: open.length, hasDepot, hasStation }).solver, orderedPickupIds: [...open] }
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
