// What a ticket hears of the stop booked to answer it (O3c of #290), in the
// request that decides the stop: the driver's completion and the office's
// correction of its outcome. An outbox queue has one consumer, and the stop's
// completion and correction are Finance's, so Resolution's part of them runs
// here, in the same transaction, as the ledger's work orders do beside it
// (apps/api/src/routes/work-orders.ts); the misses — a stop skipped or failed
// by the driver, the route's end or cancellation, or the office — reach the
// ticket through Resolution's own consumer (open-tickets in the worker).
//
// A stop completed completes its open ticket as `serviced`: a
// `status-changed` recorded by whoever completed the stop, naming it, and
// `ticket-completed` emitted, so Finance prices the ticket once (C3a). A
// ticket closed meanwhile is told in a comment instead, and so is a ticket
// whose stop is corrected away from completed after serving it: the ledger of
// cases is appended to, never taken back, and reopening — which has its own
// charge — is the office's to decide.
import { correctedAway, servedAfterClose, servicedBy, stopCorrected } from "@waste/domain/execution/ticket-stops"
import type { PickupService } from "@waste/domain/execution/vocabulary"
import { ticketTransition } from "@waste/domain/resolution/transitions"
import type { TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { newId, type IdMinter } from "../ids"
import { ticket, ticketBooking } from "../schema/resolution"
import { appendTicketEvent } from "./open-ticket"
import { emit } from "./outbox"
import { labelOf, ticketColumns, ticketOf, type TicketRow } from "./resolution-rows"

/** The stop as a ticket's words name it: its position on its route, the route's label, its service; and its route, which a ticket it services names with it. */
export type BookedStop = { pickupId: string; routeId: string; position: number; routeLabel: string; service: PickupService }

/** A stop as a ticket's words name it, no more. */
export type StopRef = { position: number; route: string }

/** Who decided the stop: the account recording the ticket's event. */
export type Actor = { companyId: string; userAccountId: string }

/**
 * The ticket a booking ever named the stop for, as a condition on `ticket`
 * (#422): read through the `ticket_booking` ledger rather than the ticket's
 * own columns, which name only its current booking, so a stop decided after
 * its ticket was booked again still finds it. One ticket at most ever books a
 * stop (`ticket_booking_pickup_id_key`).
 */
export function bookedTicket(tx: Tx, companyId: string, pickupId: string): SQL {
  const booking = tx
    .select({ ticketId: ticketBooking.ticketId })
    .from(ticketBooking)
    .where(and(eq(ticketBooking.companyId, companyId), eq(ticketBooking.pickupId, pickupId)))
  return and(eq(ticket.companyId, companyId), inArray(ticket.id, booking)) as SQL
}

/** The ticket that booked this stop, under its row lock; undefined for a stop booked for none, almost every stop, for which this one read of the ledger's key is all. */
export async function bookingTicket(tx: Tx, companyId: string, pickupId: string): Promise<TicketRow | undefined> {
  const [row] = await tx.select(ticketColumns).from(ticket).where(bookedTicket(tx, companyId, pickupId)).for("update").limit(1)
  return row
}

const refOf = (companyId: string, row: TicketRow) => ({ companyId, projectId: row.projectId, id: row.id })

/** A comment of the office's eyes alone, recorded by the actor, the ticket's status and assignee as they stand. */
const comment = (row: TicketRow, body: string, actor: Actor) => ({
  kind: "comment" as const,
  status: row.status as TicketStatus,
  assigneeUserAccountId: row.assigneeUserAccountId,
  resolution: null,
  body,
  visibility: "internal" as const,
  objectKey: null,
  recordedBy: actor.userAccountId,
  sourceEventId: null,
})

/**
 * The stop completed, by the driver or by the office's correction: the ticket
 * that booked it (`bookingTicket`, under its lock) serviced if open, or told
 * if closed. A ticket serviced by a stop it was booked away from (#422) names
 * that stop again, the one that answered it, and its words name the stop
 * booked since where that is still planned (`stillBooked`), for the office to
 * take off.
 */
export async function serveBookedTicket(tx: Tx, actor: Actor, current: TicketRow, stop: BookedStop, at: Date, stillBooked?: StopRef, mint: IdMinter = newId): Promise<void> {
  if (ticketTransition(current.status as TicketStatus, "complete", labelOf(current)).kind !== "move") {
    await appendTicketEvent(tx, refOf(actor.companyId, current), comment(current, servedAfterClose({ position: stop.position, route: stop.routeLabel, service: stop.service }), actor), mint)
    return
  }
  const [row] = await tx
    .update(ticket)
    .set({ status: "completed", resolution: "serviced", closedAt: at, bookedRouteId: stop.routeId, bookedPickupId: stop.pickupId })
    .where(and(eq(ticket.companyId, actor.companyId), eq(ticket.id, current.id)))
    .returning(ticketColumns)
  await appendTicketEvent(
    tx,
    refOf(actor.companyId, row),
    { kind: "status-changed", status: "completed", assigneeUserAccountId: row.assigneeUserAccountId, resolution: "serviced", body: servicedBy({ position: stop.position, route: stop.routeLabel }, stillBooked), visibility: "internal", objectKey: null, recordedBy: actor.userAccountId, sourceEventId: null },
    mint,
  )
  await emit(tx, { companyId: actor.companyId }, { aggregate: "ticket", aggregateId: row.id, kind: "ticket-completed", payload: ticketOf(row), projectId: row.projectId, occurredAt: at })
}

/**
 * The stop corrected away from completed: the ticket that booked it told in a
 * comment, its status as it stands — that the stop it was serviced by is no
 * longer done, where the ticket stands serviced by this stop, the one it
 * names, or the correction alone otherwise (a ticket the office closed or
 * reopened by hand, or one another of its stops serviced, #422).
 */
export async function bookedStopUncompleted(tx: Tx, actor: Actor, current: TicketRow, stop: BookedStop & { outcome: "skipped" | "failed"; note: string }, mint: IdMinter = newId): Promise<void> {
  const where = { position: stop.position, route: stop.routeLabel }
  const serviced = current.status === "completed" && current.resolution === "serviced" && current.bookedPickupId === stop.pickupId
  const body = serviced ? correctedAway({ ...where, service: stop.service, outcome: stop.outcome, note: stop.note }) : stopCorrected({ ...where, outcome: stop.outcome, note: stop.note })
  await appendTicketEvent(tx, refOf(actor.companyId, current), comment(current, body, actor), mint)
}
