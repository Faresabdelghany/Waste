// Routing's closed lists (#39, decided on #124 and #132): who ordered a Plan,
// where its measurement stands, what trip it measured, and which class a
// routing job carries. Like Planning's (planning/vocabulary.ts), the database
// reads each list into its `CHECK` (`oneOf` in packages/db/src/schema/checks.ts)
// and the contracts read the same list into a `z.enum`, so the check at the
// API boundary and the check in the column cannot drift. A value is a
// kebab-case token: a SQL literal and an enum member, the same string.

/** Who ordered the Plan: the optimiser (≤ 50 stops), the dispatcher's reorder, or the generated order measured. */
export const PLAN_SOLVERS = ["optimiser", "manual", "baseline"] as const
export type PlanSolver = (typeof PLAN_SOLVERS)[number]

/** Where the measurement stands. Deferral is `deferred_until` beside `calculating`, never a fourth status (#132 §4). */
export const PLAN_STATUSES = ["calculating", "ready", "failed"] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

/** What was measured: the whole trip (depot → stops → station → depot), or the stops alone when the Route names no depot or no station. */
export const PLAN_TRIPS = ["full", "stops-only"] as const
export type PlanTrip = (typeof PLAN_TRIPS)[number]

/** Who is waiting on a routing job: a person (a reorder, an Optimise click, a preview) or the horizon. Priority reads it first (#132 §1). */
export const ROUTING_JOB_CLASSES = ["interactive", "batch"] as const
export type RoutingJobClass = (typeof ROUTING_JOB_CLASSES)[number]

/**
 * The one structured failure reason (#132 §4): a deferred measurement whose
 * Plan is no longer the Route's active one makes no call and fails with this
 * token. Every other failure reason is the provider's own sentence, so the
 * column holds no closed list.
 */
export const SUPERSEDED = "superseded"

/** Every list above by name, for the test that walks them. */
export const ROUTING_VOCABULARIES = {
  PLAN_SOLVERS,
  PLAN_STATUSES,
  PLAN_TRIPS,
  ROUTING_JOB_CLASSES,
} as const
