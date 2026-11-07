// Where a container is collected on a day: the placement in force that day,
// held as generation holds a stop (apps/worker's stop matching) — the
// placement, its subscription and its agreement each valid on the day — and
// what it collects. Every office stop of a container reads it: Add stop
// (apps/api's routes/pickups.ts), the fill-driven emptying
// (commands/fill-emptying.ts) and a ticket type's plan in a route
// (commands/ticket-automation.ts).
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { agreement, subscription } from "../schema/agreements"
import { containerServicePlacement } from "../schema/containers"
import { validOn } from "./valid-on"

/** Where and what a container's stop collects on a day. */
export type PlacementStop = { propertyId: string | null; sharedCollectionPointId: string | null; wasteFractionId: string }

/**
 * The place and the fraction of a container's stop on a service date: the
 * place the subscription of the placement in force names — or a public
 * placement's own point — and the fraction the placement holds; undefined for
 * a container placed nowhere that day.
 */
export async function placementInForce(tx: Tx, scope: { companyId: string; projectId: string }, containerId: string, serviceDate: string): Promise<PlacementStop | undefined> {
  const [place] = await tx
    .select({
      propertyId: subscription.propertyId,
      sharedCollectionPointId: sql<string | null>`coalesce(${subscription.sharedCollectionPointId}, ${containerServicePlacement.sharedCollectionPointId})`,
      wasteFractionId: containerServicePlacement.wasteFractionId,
    })
    .from(containerServicePlacement)
    .leftJoin(
      subscription,
      and(eq(subscription.companyId, containerServicePlacement.companyId), eq(subscription.projectId, containerServicePlacement.projectId), eq(subscription.id, containerServicePlacement.subscriptionId), validOn(subscription, serviceDate)),
    )
    .leftJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.projectId, subscription.projectId), eq(agreement.id, subscription.agreementId), validOn(agreement, serviceDate)))
    .where(
      and(
        eq(containerServicePlacement.companyId, scope.companyId),
        eq(containerServicePlacement.projectId, scope.projectId),
        eq(containerServicePlacement.containerId, containerId),
        validOn(containerServicePlacement, serviceDate),
        // A public placement (M12 of #293) stands at its own point with no subscription; a subscribed one, as generation has it, only with its agreement in force too.
        or(isNull(containerServicePlacement.subscriptionId), isNotNull(agreement.id)),
      ),
    )
    .limit(1)
  return place
}
