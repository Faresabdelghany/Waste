// The placement in force on a day, held as generation holds a stop: the
// placement valid that day, and its subscription and that subscription's
// agreement each valid that day too — or a public placement (M12 of #293),
// which stands at its own point with neither. A placement can be valid on a
// day its subscription is not: an issue under a subscription with an end
// opens the placement with none (commands/stock-ledger.ts), so the period is
// asked three times over rather than read off the placement alone.
//
// Every reader asks it through `inForceOn`: generation's stop matching
// (apps/worker's planning/stop-matching.ts), the customers a route's stops
// serve (stop-customers.ts), a container's place for every office stop
// (`placementInForce`: Add stop, the fill-driven emptying, a ticket type's
// plan in a route), and what a stop is charged under and whose case it opens
// (`subscribedPlacementOn`: Finance's facts and Resolution's consumer).
import type { PlacementFacts } from "@waste/domain/finance/from-event"
import { and, eq, sql, type SQL, type SQLWrapper } from "drizzle-orm"

import type { Tx } from "../client"
import { agreement, subscription } from "../schema/agreements"
import { product } from "../schema/catalogue"
import { containerServicePlacement } from "../schema/containers"
import { customer } from "../schema/customers"
import { validOn } from "./valid-on"

/** A project of a company: every read here is fenced to one. */
export type PlacementScope = { companyId: string; projectId: string }

/**
 * The placement in force on `day`, as conditions over the placement and the
 * subscription and agreement joined to it: `placement` for its own `where`
 * or join, `subscription` and `agreement` for their joins, and `stands`, the
 * `where` that keeps a public placement or a subscribed one whose agreement
 * the joins found. With the two as left joins and `stands`, a reader keeps
 * public placements; with inner joins, the subscribed ones alone. `day` is a
 * day or an expression yielding one per row (`d.day`, a route's service date).
 */
export function inForceOn(day: string | SQLWrapper): { placement: SQL; subscription: SQL; agreement: SQL; stands: SQL } {
  return {
    placement: validOn(containerServicePlacement, day),
    subscription: sql`${subscription.companyId} = ${containerServicePlacement.companyId} and ${subscription.projectId} = ${containerServicePlacement.projectId} and ${subscription.id} = ${containerServicePlacement.subscriptionId} and ${validOn(subscription, day)}`,
    agreement: sql`${agreement.companyId} = ${subscription.companyId} and ${agreement.projectId} = ${subscription.projectId} and ${agreement.id} = ${subscription.agreementId} and ${validOn(agreement, day)}`,
    stands: sql`(${containerServicePlacement.subscriptionId} is null or ${agreement.id} is not null)`,
  }
}

/** One container's placements of the project: what each reader below narrows to the day. */
const ofContainer = (scope: PlacementScope, containerId: string) =>
  and(eq(containerServicePlacement.companyId, scope.companyId), eq(containerServicePlacement.projectId, scope.projectId), eq(containerServicePlacement.containerId, containerId))

/** Where and what a container's stop collects on a day. */
export type PlacementStop = { propertyId: string | null; sharedCollectionPointId: string | null; wasteFractionId: string }

/**
 * The place and the fraction of a container's stop on a service date: the
 * place the subscription of the placement in force names — or a public
 * placement's own point — and the fraction the placement holds; undefined for
 * a container placed nowhere that day.
 */
export async function placementInForce(tx: Tx, scope: PlacementScope, containerId: string, serviceDate: string): Promise<PlacementStop | undefined> {
  const inForce = inForceOn(serviceDate)
  const [place] = await tx
    .select({
      propertyId: subscription.propertyId,
      sharedCollectionPointId: sql<string | null>`coalesce(${subscription.sharedCollectionPointId}, ${containerServicePlacement.sharedCollectionPointId})`,
      wasteFractionId: containerServicePlacement.wasteFractionId,
    })
    .from(containerServicePlacement)
    .leftJoin(subscription, inForce.subscription)
    .leftJoin(agreement, inForce.agreement)
    .where(and(ofContainer(scope, containerId), inForce.placement, inForce.stands))
    .limit(1)
  return place
}

/** A subscribed placement in force as Finance reads it: what the domain's `PlacementFacts` carries less the list, plus the list the agreement names (null for the project's default), which Finance reads next. */
export type SubscribedPlacement = Omit<PlacementFacts, "priceList"> & { priceListId: string | null }

/**
 * The subscribed placement of the container in force on the day, with its
 * subscription, its agreement and the agreement's customer's kind, and the
 * subscription's product; undefined where none was — a container placed
 * nowhere that day, publicly, or under a subscription or an agreement out of
 * force. What a stop is charged under (Finance) and whose case its failure
 * opens (Resolution, #258).
 */
export async function subscribedPlacementOn(tx: Tx, scope: PlacementScope, containerId: string, day: string): Promise<SubscribedPlacement | undefined> {
  const inForce = inForceOn(day)
  const [row] = await tx
    .select({
      subscriptionId: subscription.id,
      agreementId: agreement.id,
      agreementStatus: agreement.status,
      customerId: agreement.customerId,
      customerKind: customer.kind,
      priceListId: agreement.priceListId,
      productId: product.id,
      unit: product.unit,
      vatPercent: product.vatPercent,
    })
    .from(containerServicePlacement)
    .innerJoin(subscription, inForce.subscription)
    .innerJoin(agreement, inForce.agreement)
    .innerJoin(customer, and(eq(customer.companyId, agreement.companyId), eq(customer.id, agreement.customerId)))
    .innerJoin(product, and(eq(product.companyId, subscription.companyId), eq(product.id, subscription.productId)))
    .where(and(ofContainer(scope, containerId), inForce.placement))
    .limit(1)
  if (row === undefined) return undefined
  return {
    subscriptionId: row.subscriptionId,
    agreement: { id: row.agreementId, status: row.agreementStatus, customerKind: row.customerKind, customerId: row.customerId },
    product: { id: row.productId, unit: row.unit, vatPercent: row.vatPercent },
    priceListId: row.priceListId,
  }
}

