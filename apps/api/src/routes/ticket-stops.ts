// A stop booked to answer a ticket (O3c of #290): a container request's
// delivery, an overflow's emptying, a defect's repair or swap. The office's
// Add stop names the ticket (`PickupAdd.ticketId`); the ticket must be one of
// the route's project, open, of a kind the stop's service answers, about the
// stop's container and place where it names them (`stopMismatch`), and
// answered by no other stop still planned. The stop written, the ticket names
// it (`booked_route_id`, `booked_pickup_id`) with a comment saying so — the
// ticket's history is its events, the table being no audited one — and a
// missed booking is replaced by the next, its story in the comments. Every
// booking is kept in the `ticket_booking` ledger too (#422), which is where a
// stop's outcome finds its ticket, so the stop a rebooking replaced still
// tells the ticket it answered.
//
// The stop decided tells the ticket in the same request
// (`@waste/db/commands/ticket-stops`): the driver's completion and the
// office's correction to completed service the ticket, a correction away from
// completed comments on it. Misses reach it through Resolution's consumer.
import type { Tx } from "@waste/db/client"
import { bookedStopUncompleted, bookingTicket, serveBookedTicket, type BookedStop } from "@waste/db/commands/ticket-stops"
import { appendTicketEvent } from "@waste/db/commands/open-ticket"
import { labelOf as ticketLabelOf, ticketColumns, type TicketRow } from "@waste/db/commands/resolution-rows"
import { pickup, route } from "@waste/db/schema/execution"
import { ticket, ticketBooking } from "@waste/db/schema/resolution"
import { answeredAlready, bookedFor, notAnsweredBy, onlyAnOpenTicket, servicesAnswering, stopMismatch } from "@waste/domain/execution/ticket-stops"
import type { PickupService } from "@waste/domain/execution/vocabulary"
import { OPEN_TICKET_STATUSES, type TicketKind, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { routeLabel } from "@waste/contracts/execution"
import { and, eq } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { invalidRequest, problem } from "../problem"
import type { Scope } from "./references"

/** What a ticket the body names is told when it is no ticket of the route's project. */
export const NOT_A_TICKET = "Not a ticket of this project"

/** Where the stop is, as the ticket is held to it. */
type StopAt = { service: PickupService; containerId: string | null; propertyId: string | null; sharedCollectionPointId: string | null }

/**
 * The ticket a stop is booked to answer, judged as the body's own field
 * before the stop's place is read: of the route's project (400 at
 * `ticketId`), answered by the stop's service (400 at `service`), about the
 * container the body names where it names one (400 at `containerId`). Locked
 * once the fences found it (the route's lock taken first, by the caller), so
 * a ticket of another project is never held.
 */
export async function requireTicketForStop(tx: Tx, principal: Principal, scope: Scope, ticketId: string, stop: { service: PickupService; containerId: string | null }): Promise<TicketRow> {
  const [row] = await tx
    .select(ticketColumns)
    .from(ticket)
    .where(and(eq(ticket.companyId, scope.companyId), eq(ticket.projectId, scope.projectId), inProjects(ticket.projectId, principal), eq(ticket.id, ticketId)))
    .for("update")
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path: "ticketId", message: NOT_A_TICKET }])
  const kind = row.kind as TicketKind
  if (!(servicesAnswering(kind) as readonly PickupService[]).includes(stop.service)) throw invalidRequest("body", [{ path: "service", message: notAnsweredBy(kind, stop.service) }])
  const onItsContainer = stopMismatch({ containerId: row.containerId, propertyId: null, sharedCollectionPointId: null }, { ...stop, propertyId: null, sharedCollectionPointId: null })
  if (onItsContainer !== undefined) throw invalidRequest("body", [onItsContainer])
  return row
}

/**
 * The ticket, once the stop's place is known: at the ticket's place (400 at
 * the field that names it), open (409), and answered by no other stop still
 * planned (409, naming it).
 */
export async function requireBookableTicket(tx: Tx, scope: Scope, row: TicketRow, stop: StopAt): Promise<TicketRow> {
  const mismatch = stopMismatch({ containerId: row.containerId, propertyId: row.propertyId, sharedCollectionPointId: row.sharedCollectionPointId }, stop)
  if (mismatch !== undefined) throw invalidRequest("body", [mismatch])
  if (!(OPEN_TICKET_STATUSES as readonly string[]).includes(row.status)) throw problem(409, { detail: onlyAnOpenTicket(ticketLabelOf(row), row.status) })
  if (row.bookedPickupId !== null) {
    const [booked] = await tx
      .select({ status: pickup.status, position: pickup.position, number: route.number })
      .from(pickup)
      .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
      .where(and(eq(pickup.companyId, scope.companyId), eq(pickup.id, row.bookedPickupId)))
      .limit(1)
    if (booked?.status === "planned") throw problem(409, { detail: answeredAlready(ticketLabelOf(row), { position: booked.position, route: routeLabel(booked.number) }) })
  }
  return row
}

/** The ticket names the stop booked for it, with a comment saying which, and the ledger keeps the booking; a missed one it named before is replaced on the ticket, never in the ledger. */
export async function bookTicket(tx: Tx, principal: Principal, booking: TicketRow, stop: { pickupId: string; routeId: string; position: number; routeLabel: string; service: PickupService }): Promise<void> {
  const [row] = await tx
    .update(ticket)
    .set({ bookedRouteId: stop.routeId, bookedPickupId: stop.pickupId })
    .where(and(eq(ticket.companyId, principal.companyId), eq(ticket.id, booking.id)))
    .returning(ticketColumns)
  await tx.insert(ticketBooking).values({ companyId: principal.companyId, projectId: row.projectId, ticketId: row.id, routeId: stop.routeId, pickupId: stop.pickupId })
  await appendTicketEvent(
    tx,
    { companyId: principal.companyId, projectId: row.projectId, id: row.id },
    {
      kind: "comment",
      status: row.status as TicketStatus,
      assigneeUserAccountId: row.assigneeUserAccountId,
      resolution: null,
      body: bookedFor({ position: stop.position, route: stop.routeLabel, service: stop.service }),
      visibility: "internal",
      objectKey: null,
      recordedBy: principal.user.id,
      sourceEventId: null,
    },
  )
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
  return { pickupId, routeId: row.routeId, position: row.position, routeLabel: routeLabel(row.number), service: row.service as PickupService, status: row.status }
}

/**
 * A stop's outcome as its ticket hears it: completed — the driver's or the
 * office's correction to it — services the ticket; corrected away from
 * completed tells it in a comment. Nothing for any other move, or a stop
 * booked for no ticket. The ticket is the one any booking named the stop for
 * (#422): a stop it was booked away from that services it names the stop
 * booked since, while that one is still planned.
 */
export async function ticketHearsOfStop(tx: Tx, actor: Principal, pickupId: string, outcome: { from: string; to: string; note?: string }, at: Date): Promise<void> {
  const completes = outcome.to === "completed" && outcome.from !== "completed"
  const uncompletes = outcome.from === "completed" && (outcome.to === "skipped" || outcome.to === "failed")
  if (!completes && !uncompletes) return
  const booking = await bookingTicket(tx, actor.companyId, pickupId)
  if (booking === undefined) return
  const who = { companyId: actor.companyId, userAccountId: actor.user.id }
  const stop = await bookedStop(tx, actor.companyId, pickupId)
  if (completes) {
    const since = booking.bookedPickupId === null || booking.bookedPickupId === pickupId ? undefined : await bookedStop(tx, actor.companyId, booking.bookedPickupId)
    await serveBookedTicket(tx, who, booking, stop, at, since?.status === "planned" ? { position: since.position, route: since.routeLabel } : undefined)
    return
  }
  await bookedStopUncompleted(tx, who, booking, { ...stop, outcome: outcome.to as "skipped" | "failed", note: outcome.note ?? "" })
}
