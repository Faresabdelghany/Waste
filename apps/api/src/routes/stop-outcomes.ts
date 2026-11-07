// What a stop's outcome sets going, for every door that decides one: the
// driver's command (routes/driver.ts) and the office's correction
// (routes/pickups.ts). A delivery, a removal or a swap moves its containers
// through the Stock Movement ledger as it completes, or tells the office the
// movements stand when a correction takes the completion back
// (work-orders.ts, O3b of #290); and the ticket a stop was booked to answer
// is serviced by its completion, or told of a correction away from it
// (ticket-stops.ts, O3c of #290). Both run in the transaction that decided
// the outcome, in that order.
import type { Send } from "@waste/db/jobs"
import type { PickupStatus } from "@waste/domain/execution/vocabulary"
import type { Tx } from "@waste/db/client"

import type { Principal } from "../auth/principal"
import { ticketHearsOfStop } from "./ticket-stops"
import { ledgerHearsOfStop, type CompletedBy } from "./work-orders"

/** A stop's outcome moved from `from` to `to`, when it happened and by whose door; `at` is the request's clock, the note the correction's. */
export async function stopOutcomeChanged(tx: Tx, actor: Principal, send: Send, pickupId: string, outcome: { from: PickupStatus; to: PickupStatus; note?: string; occurredAt: string; by: CompletedBy }, at: Date): Promise<void> {
  await ledgerHearsOfStop(tx, actor, send, pickupId, outcome, at)
  await ticketHearsOfStop(tx, actor, send, pickupId, outcome, new Date(outcome.occurredAt))
}
