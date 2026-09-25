// A route's progress (Issue #104): the one fold the route list, the single
// read and the live read all answer — how many pickups stand in each status,
// how many there are, and the fraction done. Derived and never persisted
// (#104 §2, "Derived, never persisted"): the API counts a route's pickups by
// status in one aggregate over the page's ids and hands the counts here; the
// device counts its local rows the same way.
//
// "Done" is a pickup that has an outcome — completed, skipped or failed — so
// a route whose driver ended the day with stops left reads as finished, its
// skipped stops counted, which is what the dashboard's bar and Resolution's
// list both want; the counts beside the fraction say how it finished. A route
// without pickups is done at zero, not divided by zero.
import { PICKUP_STATUSES, type PickupStatus } from "./vocabulary"

/** How many pickups stand in each status. */
export type PickupCounts = Readonly<Record<PickupStatus, number>>

/** The counts, the total, and the fraction of pickups that have an outcome, 0..1. */
export type Progress = PickupCounts & { total: number; fraction: number }

/** The counts of a list of pickups by status, every status present, zero where none stands there. */
export function countPickups(pickups: readonly { status: PickupStatus }[]): PickupCounts {
  const counts: Record<PickupStatus, number> = { planned: 0, completed: 0, skipped: 0, failed: 0 }
  for (const pickup of pickups) counts[pickup.status] += 1
  return counts
}

/** The fold: counts in, every status filled, the total and the fraction done out. A count left out is zero. */
export function progressOf(counts: Partial<PickupCounts>): Progress {
  const filled: Record<PickupStatus, number> = { planned: 0, completed: 0, skipped: 0, failed: 0 }
  for (const status of PICKUP_STATUSES) filled[status] = counts[status] ?? 0
  const total = PICKUP_STATUSES.reduce((sum, status) => sum + filled[status], 0)
  const done = total - filled.planned
  return { ...filled, total, fraction: total === 0 ? 0 : done / total }
}
