// What Finance reads off its rows and never stores (Issue #112 §2, ADR-0005:
// a status is stored only where the columns do not say it). A Billable
// Event's status is a fold over its stamps and the invoice line naming it —
// `blocked` is a block reason, `cancelled` a cancellation stamp, `invoiced` a
// line naming it, `reversed` a `reversal` event naming it, `ready` none of
// those — and the later fact wins where two hold: a reversal names an invoiced
// event, so a reversed event is `reversed` and not `invoiced`; a blocked event
// may be cancelled (there is nothing to invoice), so a cancelled blocked event
// is `cancelled`. An Unload's review status is its latest review's decision,
// or `captured` when nobody has looked. An invoice line's, and by summing its
// lines an invoice's, credit standing is how much of it a credit note has
// taken back: nothing, some, or all — a fully credited invoice is what the
// prototype called cancelled. Each is a pure fold the API runs on every read,
// so a list may filter by it in SQL as the `assetStatus` CASE does and the
// wire never carries a status a form could set.
import type { BillableEventStatus, BlockReason, WeightReviewDecision, WeightReviewStatus } from "./vocabulary"

/** What decides a Billable Event's status: the two stamps on the row and the two rows that may name it. */
export type BillableEventReading = {
  blockReason: BlockReason | null
  /** The cancellation stamp, or null: the `timestamptz` as Drizzle reads it (a `Date`) or as the wire spells it (an `IsoDateTime` string). The fold asks only whether it is there. */
  cancelledAt: Date | string | null
  /** Whether an invoice line names the event. */
  invoiced: boolean
  /** Whether a `reversal` event names the event. */
  reversed: boolean
}

/** The status a Billable Event is read as: the later fact wins where two hold. */
export function billableEventStatus(reading: BillableEventReading): BillableEventStatus {
  if (reading.reversed) return "reversed"
  if (reading.invoiced) return "invoiced"
  if (reading.cancelledAt !== null) return "cancelled"
  if (reading.blockReason !== null) return "blocked"
  return "ready"
}

/** Whether an event of this reading may still go on an invoice: priced, not cancelled, not on a line, not reversed. */
export const isReady = (reading: BillableEventReading): boolean => billableEventStatus(reading) === "ready"

/** An Unload's review status: the latest review's decision, or `captured` when there is none. */
export const weightReviewStatus = (latestDecision: WeightReviewDecision | null): WeightReviewStatus => latestDecision ?? "captured"

/** How much of a line, or of an invoice, a credit note has taken back. A type and not a vocabulary: nothing stores it and no column checks it. */
export type CreditStanding = "uncredited" | "partially-credited" | "credited"

/**
 * The standing of a quantity against what has been credited of it: nothing
 * yet, some, or all. A credit beyond the quantity cannot be written (the
 * route holds each credit to what remains), so at or past the quantity reads
 * as credited rather than as an error.
 */
export function creditStanding(quantity: number, creditedQuantity: number): CreditStanding {
  if (creditedQuantity <= 0) return "uncredited"
  return creditedQuantity < quantity ? "partially-credited" : "credited"
}
