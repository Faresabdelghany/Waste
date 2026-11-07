// What a ticket hears of the stop booked to answer it (O3c of #290), in the
// transaction that decides the stop: the driver's completion and the office's
// correction of its outcome (`ticketHearsOfStop`, through `stopOutcomeChanged`,
// stop-outcomes.ts). An outbox queue has one consumer, and the stop's
// completion and correction are Finance's, so Resolution's part of them runs
// here, in the same transaction, as the ledger's work orders do beside it
// (work-orders.ts); the misses — a stop skipped or failed by the driver, the
// route's end or cancellation, or the office — reach the ticket through
// Resolution's own consumer (open-tickets in the worker).
//
// A stop completed completes its open ticket as `serviced`: a
// `status-changed` recorded by whoever completed the stop, naming it, and
// `ticket-completed` emitted, so Finance prices the ticket once (C3a). A
// ticket closed meanwhile is told in a comment instead, and so is a ticket
// whose stop is corrected away from completed after serving it: the ledger of
// cases is appended to, never taken back, and reopening — which has its own
// charge — is the office's to decide.
//
// A stop booked for a ticket is written to the ticket here too
// (`bookTicket`): the office's Add stop (apps/api's routes/ticket-stops.ts)
// and the system's plan in a route (#546 of #544,
// commands/ticket-automation.ts) book through the one write.
import { routeLabel } from "@waste/domain/numbering"
import { correctedAway, servedAfterClose, servicedBy, stopCorrected } from "@waste/domain/resolution/ticket-stops"
import type { PickupService } from "@waste/domain/execution/vocabulary"
import { ticketTransition } from "@waste/domain/resolution/transitions"
import { and, eq, inArray, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { newId, type IdMinter } from "../ids"
import type { Send } from "../jobs"
import { pickup, route } from "../schema/execution"
import { ticket, ticketBooking } from "../schema/resolution"
import { appendTicketEvent, ticketRefOf } from "./open-ticket"
import type { Actor } from "./shared"
import { moveTicket, type AutomationCause } from "./ticket-automation"
import { labelOf, ticketColumns, type TicketRow } from "../shapes/tickets"

/** The stop as a ticket's words name it: its position on its route, the route's label, its service; and its route, which a ticket it services names with it. */
export type BookedStop = { pickupId: string; routeId: string; position: number; routeLabel: string; service: PickupService }

/** A stop as a ticket's words name it, no more. */
export type StopRef = { position: number; route: string }

/**
 * The ticket names the stop booked for it, with a line saying which, and the
 * `ticket_booking` ledger keeps the booking (#422); a missed one it named
 * before is replaced on the ticket, never in the ledger. The office's line is
 * `bookedFor`'s, recorded by the person; the system's is its automation's, by
 * nobody. Answers the ticket as booked.
 */
export async function bookTicket(tx: Tx, companyId: string, booking: TicketRow, stop: Pick<BookedStop, "pickupId" | "routeId">, line: { body: string; recordedBy: string | null }, mint: IdMinter = newId): Promise<TicketRow> {
  const [row] = await tx
    .update(ticket)
    .set({ bookedRouteId: stop.routeId, bookedPickupId: stop.pickupId })
    .where(and(eq(ticket.companyId, companyId), eq(ticket.id, booking.id)))
    .returning(ticketColumns)
  await tx.insert(ticketBooking).values({ id: mint(), companyId, projectId: row.projectId, ticketId: row.id, routeId: stop.routeId, pickupId: stop.pickupId })
  await appendTicketEvent(
    tx,
    { companyId, projectId: row.projectId, id: row.id },
    { kind: "comment", status: row.status, assigneeUserAccountId: row.assigneeUserAccountId, resolution: null, body: line.body, visibility: "internal", objectKey: null, recordedBy: line.recordedBy, sourceEventId: null },
    mint,
  )
  return row
}

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

/** The stop still planned that answers the ticket — the one it is booked for, where that is still planned — as a ticket's words name it; undefined where none does, and a new booking may answer it. */
export async function plannedStopAnswering(tx: Tx, companyId: string, booking: Pick<TicketRow, "bookedPickupId">): Promise<StopRef | undefined> {
  if (booking.bookedPickupId === null) return undefined
  const [booked] = await tx
    .select({ status: pickup.status, position: pickup.position, number: route.number })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.id, booking.bookedPickupId)))
    .limit(1)
  return booked?.status === "planned" ? { position: booked.position, route: routeLabel(booked.number) } : undefined
}

/** The ticket that booked this stop, under its row lock; undefined for a stop booked for none, almost every stop, for which this one read of the ledger's key is all. */
export async function bookingTicket(tx: Tx, companyId: string, pickupId: string): Promise<TicketRow | undefined> {
  const [row] = await tx.select(ticketColumns).from(ticket).where(bookedTicket(tx, companyId, pickupId)).for("update").limit(1)
  return row
}

/** A comment of the office's eyes alone, recorded by the actor, the ticket's status and assignee as they stand. */
const comment = (row: TicketRow, body: string, actor: Actor) => ({
  kind: "comment" as const,
  status: row.status,
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
export async function serveBookedTicket(tx: Tx, actor: Actor, current: TicketRow, stop: BookedStop, at: Date, automation: AutomationCause, stillBooked?: StopRef, mint: IdMinter = newId): Promise<void> {
  if (ticketTransition(current.status, "complete", labelOf(current)).kind !== "move") {
    await appendTicketEvent(tx, ticketRefOf(actor.companyId, current), comment(current, servedAfterClose({ position: stop.position, route: stop.routeLabel, service: stop.service }), actor), mint)
    return
  }
  // The stop's completion is the change that sets its type's completion actions going (#546 of #544).
  await moveTicket(tx, { ...automation, companyId: actor.companyId, newId: mint, now: () => at }, current, {
    to: "completed",
    set: { resolution: "serviced", bookedRouteId: stop.routeId, bookedPickupId: stop.pickupId },
    note: servicedBy({ position: stop.position, route: stop.routeLabel }, stillBooked),
    recordedBy: actor.userAccountId,
    at,
  })
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
  await appendTicketEvent(tx, ticketRefOf(actor.companyId, current), comment(current, body, actor), mint)
}

/** The stop as a ticket's words name it, with its status: the stop just decided, or the one its ticket is booked for now. */
async function bookedStop(tx: Tx, companyId: string, pickupId: string): Promise<BookedStop & { status: string }> {
  const [row] = await tx
    .select({ routeId: pickup.routeId, position: pickup.position, service: pickup.service, status: pickup.status, number: route.number })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.id, pickupId)))
    .limit(1)
  if (row === undefined) throw new Error(`pickup ${pickupId} decided and then not there`)
  return { pickupId, routeId: row.routeId, position: row.position, routeLabel: routeLabel(row.number), service: row.service, status: row.status }
}

/**
 * A stop's outcome as its ticket hears it: completed — the driver's or the
 * office's correction to it — services the ticket; corrected away from
 * completed tells it in a comment. Nothing for any other move, or a stop
 * booked for no ticket. The ticket is the one any booking named the stop for
 * (#422): a stop it was booked away from that services it names the stop
 * booked since, while that one is still planned.
 */
export async function ticketHearsOfStop(tx: Tx, actor: Actor, send: Send, pickupId: string, outcome: { from: string; to: string; note?: string }, at: Date): Promise<void> {
  const completes = outcome.to === "completed" && outcome.from !== "completed"
  const uncompletes = outcome.from === "completed" && (outcome.to === "skipped" || outcome.to === "failed")
  if (!completes && !uncompletes) return
  const booking = await bookingTicket(tx, actor.companyId, pickupId)
  if (booking === undefined) return
  const stop = await bookedStop(tx, actor.companyId, pickupId)
  if (completes) {
    const since = booking.bookedPickupId === null || booking.bookedPickupId === pickupId ? undefined : await bookedStop(tx, actor.companyId, booking.bookedPickupId)
    await serveBookedTicket(tx, actor, booking, stop, at, { send, by: actor.userAccountId }, since?.status === "planned" ? { position: since.position, route: since.routeLabel } : undefined)
    return
  }
  await bookedStopUncompleted(tx, actor, booking, { ...stop, outcome: outcome.to as "skipped" | "failed", note: outcome.note ?? "" })
}
