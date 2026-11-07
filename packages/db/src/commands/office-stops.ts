// The office's stop on a route (#111), written once for every door that adds
// one: Add stop and a move onto the route (apps/api's routes/pickups.ts and
// routes/stop-moves.ts), the fill-driven emptying (commands/fill-emptying.ts)
// and a ticket type's plan in a route (commands/ticket-automation.ts). Each
// door locks the route, holds it to an open order (`orderIsOpen`), reads the
// stop's place — for a container, its placement in force on the route's
// service date (`placementInForce`) — and judges what is its own; then the
// stop is written here, the same rules for all.
//
// The office may repeat a container on a route — an extra emptying, a work
// order beside its collection — but not book the same work twice while it is
// planned: an office stop of the container for that service, planned on the
// route, is the one asked for already. The stop is `planned`, `origin =
// office`, after the route's last position as the route stands, and held to
// the route's planned vehicle (O7 of #290, `misfitOf`); the route's
// `updatedAt` moves, since its stops are part of it on the wire, and no event
// is written — Resolution and Finance hear of a stop at its outcome. The write
// is a savepoint of the caller's transaction, so a stop the vehicle cannot
// take, or one a unique index refuses (a container a work order holds), is
// taken back and the caller's transaction goes on.
import { ROUTE_STATUSES, type PickupService } from "@waste/domain/execution/vocabulary"
import { orderIsOpen } from "@waste/domain/execution/transitions"
import { and, eq, max, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { newId } from "../ids"
import { pickup, route } from "../schema/execution"
import { misfitOf, pickupFitStops } from "./fleet-fit"

/** The statuses a route takes an office stop in, for a statement: its order still open. */
export const ORDER_OPEN_STATUSES = ROUTE_STATUSES.filter(orderIsOpen)

/** The office's stop as its door judged it: the work, where and what it collects, what a work order books, the bulky booking it collects, the stop it was moved from, and the driver's note. */
export type OfficeStopDraft = {
  id?: string
  service: PickupService
  containerId: string | null
  propertyId: string | null
  sharedCollectionPointId: string | null
  wasteFractionId: string
  note: string | null
  subscriptionId?: string | null
  warehouseId?: string | null
  replacementContainerId?: string | null
  bulkyBookingId?: string | null
  movedFromRouteId?: string | null
  movedFromPickupId?: string | null
}

/** What adding came to: the stop written, the same work found planned there already, or the sentence of the vehicle that cannot take it. */
export type OfficeStopAdded = { kind: "added"; id: string; position: number } | { kind: "booked-already" } | { kind: "misfit"; sentence: string }

/** Thrown inside the savepoint to take a misfit back, carrying its sentence. */
class Misfit extends Error {}

/**
 * Adds the office's stop to the route its caller locked and held to an open
 * order. `beforeWrite` is the door's own judgement that comes after the
 * same work and before the write — Add stop's of the ticket the stop is to
 * answer — so its refusals keep their order. A unique index's refusal
 * propagates, the stop taken back.
 */
export async function addOfficeStop(tx: Tx, companyId: string, onRoute: { id: string; projectId: string; plannedVehicleId: string | null }, draft: OfficeStopDraft, beforeWrite?: () => Promise<void>): Promise<OfficeStopAdded> {
  if (draft.containerId !== null) {
    const [booked] = await tx
      .select({ id: pickup.id })
      .from(pickup)
      .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, onRoute.id), eq(pickup.containerId, draft.containerId), eq(pickup.origin, "office"), eq(pickup.service, draft.service), eq(pickup.status, "planned")))
      .limit(1)
    if (booked !== undefined) return { kind: "booked-already" }
  }
  await beforeWrite?.()
  try {
    return await tx.transaction(async (savepoint) => {
      const [last] = await savepoint
        .select({ position: max(pickup.position) })
        .from(pickup)
        .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, onRoute.id)))
      const [stop] = await savepoint
        .insert(pickup)
        .values({ ...draft, id: draft.id ?? newId(), companyId, projectId: onRoute.projectId, routeId: onRoute.id, position: (last?.position ?? 0) + 1, origin: "office", status: "planned" })
        .returning({ id: pickup.id, position: pickup.position })
      if (onRoute.plannedVehicleId !== null) {
        const misfit = await misfitOf(savepoint, companyId, onRoute.plannedVehicleId, await pickupFitStops(savepoint, companyId, [stop.id]))
        if (misfit !== undefined) throw new Misfit(misfit)
      }
      await savepoint
        .update(route)
        .set({ updatedAt: sql`now()` })
        .where(and(eq(route.companyId, companyId), eq(route.id, onRoute.id)))
      return { kind: "added" as const, id: stop.id, position: stop.position }
    })
  } catch (error) {
    if (error instanceof Misfit) return { kind: "misfit", sentence: error.message }
    throw error
  }
}
