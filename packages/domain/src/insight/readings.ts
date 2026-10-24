// What a report's counts mean (#292, C26 and O12). The reports store nothing:
// the API counts rows that exist — the dated Route and its Pickups, the
// Ticket, the Invoice and its lines, the Unload and its weight review, a
// stop's weight proof — and these are the rules it counts them by, spelled
// once so the API's statements, the web's reading of them and a test agree.
//
// A pickup stands in one of four places. `completed` is collected. `missed`
// is a stop that was due and not collected: `failed` (the driver tried) or
// `skipped` (nobody did — passed by, or closed with its route's end or a
// dispatcher's cancellation). `open` is still `planned`: a stop of a route
// that has not run yet, or runs now, is not missed until it has an outcome.
// `withdrawn` is a stop that stopped being work rather than work left
// undone — taken off by a regeneration (the occurrence moved or the
// container left the rule) or removed by the dispatcher — and counts in
// neither rate. The collection rate is completed over completed and missed,
// the missed rate missed over the same: both over the stops that have an
// outcome, so a window that reaches into next week is not dragged down by
// stops nobody has driven to yet.
//
// A route started on time when its session started no later than its
// planned start on the project's clock on its operating date, plus
// `ON_TIME_GRACE_MINUTES`. A route with no planned start time cannot be
// judged and is counted apart; one that has not started is not judged yet.
// The statement holds the comparison in SQL, since the instant is the
// operating date and the planned time read in `project.timezone`.
//
// An unload's net weight counts by its weight review (Issue #112): `approved`
// and `captured` (nobody has looked yet) count, apart from each other so a
// report says how much of its tonnage is reviewed; `rejected` is reported
// beside and counts in no total; `corrected` is superseded, since the
// correction wrote a new unload that carries the weight, and is not counted
// at all — counting both would count the load twice.
import type { PickupReason, PickupStatus } from "../execution/vocabulary"
import type { WeightReviewStatus } from "../finance/vocabulary"

/** The reasons that withdraw a stop from the work instead of leaving it undone: a regeneration's and a dispatcher's removal. A value of `PICKUP_REASONS`. */
export const WITHDRAWN_REASONS = ["regeneration", "removed-by-dispatcher"] as const satisfies readonly PickupReason[]

/** Where a pickup stands in a report. */
export type PickupStanding = "completed" | "missed" | "open" | "withdrawn"

/** The standing of a pickup of the given status and reason. */
export function pickupStanding(status: PickupStatus, reason: PickupReason | null): PickupStanding {
  if (reason !== null && (WITHDRAWN_REASONS as readonly PickupReason[]).includes(reason)) return "withdrawn"
  switch (status) {
    case "completed":
      return "completed"
    case "skipped":
    case "failed":
      return "missed"
    case "planned":
      return "open"
  }
}

/** How late after its planned start a route may start and still be on time. */
export const ON_TIME_GRACE_MINUTES = 15

/** Where an unload's net weight stands in a tonnage report. */
export type UnloadStanding = "approved" | "captured" | "rejected" | "superseded"

/** The standing of an unload whose weight review reads `status`. */
export function unloadStanding(status: WeightReviewStatus): UnloadStanding {
  return status === "corrected" ? "superseded" : status
}

/**
 * A rate, 0..1: the part over the whole, or null where the whole is nothing —
 * a rate of nothing is not zero, and a report says so rather than showing 0 %.
 */
export function rate(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null
}
