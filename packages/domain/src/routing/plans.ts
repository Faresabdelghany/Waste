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
