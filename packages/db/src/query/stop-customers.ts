// The customers a route's stops serve (C18 of #291): who a broadcast about a
// route — cancelled, running late — and the day-ahead collection reminder go
// to. A container's stop serves the customer of the placement valid on the
// route's service date, through its subscription and agreement, at the
// subscription's place; a bulky stop serves its booking's customer at the
// booking's place. A stop with neither (an address-only stop of the office's)
// names no customer, and is told nothing.
//
// The stops are those still owed: `planned`, or `skipped` with the reason
// `route-cancelled`, the office's cancel closing them. A notice about an area
// reaches a stop whose place lies inside the boundary in force on the
// route's operating date of one of the areas named (`st_contains`, as
// generation's matcher and `planningAreasAt` judge a place); a stop with no
// place lies in no area. Every statement names the company and the project.
import type { MessageChannel } from "@waste/domain/messaging/vocabulary"
import { sql, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { agreement, subscription } from "../schema/agreements"
import { bulkyBooking } from "../schema/bulky"
import { containerServicePlacement } from "../schema/containers"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { pickup, route } from "../schema/execution"
import { message } from "../schema/messaging"
import { planningAreaBoundary } from "../schema/planning-areas"
import { validOn } from "./valid-on"

/** A project of a company: every read here is fenced to one. */
export type StopScope = { companyId: string; projectId: string }

const owed = sql`(${pickup.status} = 'planned' or (${pickup.status} = 'skipped' and ${pickup.reason} = 'route-cancelled'))`
const place = sql`coalesce(${property.location}, ${sharedCollectionPoint.location})`

/** `(customer_id, place)` of each owed stop of the project's routes `where` picks, the containers' and the bookings'. */
function servedStops(scope: StopScope, where: SQL, areaIds: readonly string[]): SQL {
  const inAreas =
    areaIds.length === 0
      ? sql`true`
      : sql`(${place} is not null and exists (
          select 1 from ${planningAreaBoundary}
          where ${planningAreaBoundary.companyId} = ${scope.companyId} and ${planningAreaBoundary.projectId} = ${scope.projectId}
            and ${planningAreaBoundary.planningAreaId} = any(${sql.param([...areaIds])}::text[]::uuid[])
            and ${validOn(planningAreaBoundary, route.operatingDate)}
            and extensions.st_contains(${planningAreaBoundary.boundary}, ${place})
        ))`
  return sql`
    select ${agreement.customerId} as customer_id
    from ${pickup}
    join ${route} on ${route.companyId} = ${pickup.companyId} and ${route.id} = ${pickup.routeId}
    join ${containerServicePlacement}
      on ${containerServicePlacement.companyId} = ${pickup.companyId} and ${containerServicePlacement.projectId} = ${route.projectId} and ${containerServicePlacement.containerId} = ${pickup.containerId}
      and ${validOn(containerServicePlacement, route.serviceDate)}
    join ${subscription} on ${subscription.companyId} = ${containerServicePlacement.companyId} and ${subscription.id} = ${containerServicePlacement.subscriptionId}
    join ${agreement} on ${agreement.companyId} = ${subscription.companyId} and ${agreement.id} = ${subscription.agreementId}
    left join ${property} on ${property.companyId} = ${subscription.companyId} and ${property.id} = ${subscription.propertyId}
    left join ${sharedCollectionPoint} on ${sharedCollectionPoint.companyId} = ${subscription.companyId} and ${sharedCollectionPoint.id} = ${subscription.sharedCollectionPointId}
    where ${pickup.companyId} = ${scope.companyId} and ${route.projectId} = ${scope.projectId} and ${pickup.bulkyBookingId} is null and ${owed} and ${where} and ${inAreas}
    union
    select ${bulkyBooking.customerId} as customer_id
    from ${pickup}
    join ${route} on ${route.companyId} = ${pickup.companyId} and ${route.id} = ${pickup.routeId}
    join ${bulkyBooking} on ${bulkyBooking.companyId} = ${pickup.companyId} and ${bulkyBooking.id} = ${pickup.bulkyBookingId}
    left join ${property} on ${property.companyId} = ${bulkyBooking.companyId} and ${property.id} = ${bulkyBooking.propertyId}
    left join ${sharedCollectionPoint} on ${sharedCollectionPoint.companyId} = ${bulkyBooking.companyId} and ${sharedCollectionPoint.id} = ${bulkyBooking.sharedCollectionPointId}
    where ${pickup.companyId} = ${scope.companyId} and ${route.projectId} = ${scope.projectId} and ${owed} and ${where} and ${inAreas}
  `
}

/** The customers a route's owed stops serve, each once, in id order; within `areaIds` where it names any. */
export async function customersOfRoute(tx: Tx, scope: StopScope, routeId: string, areaIds: readonly string[]): Promise<string[]> {
  const rows = await tx.execute<{ customer_id: string }>(sql`
    select distinct customer_id::text from (${servedStops(scope, sql`${route.id} = ${routeId}`, areaIds)}) as served order by 1
  `)
  return rows.map((row) => row.customer_id)
}

/**
 * The reminder's key for a customer and a day: a fixed id per pair, the
 * message's `source_event_id`, so a customer is reminded of a day once
 * however often the job runs (`message_source_event_id_customer_id_idx`).
 */
export const reminderKey = (customerId: string | SQL, day: string): SQL => sql`md5(${"collection-reminder:"} || ${customerId}::text || ${":"} || ${day})::uuid`

/** One customer the reminder is due to, under its key. */
export type ReminderDue = { customerId: string; sourceEventId: string }

/** What the reminder of a day owes in one run: the customers due, and how many lie beyond the day's cap (counted while any is due). */
export type RemindersDue = { due: ReminderDue[]; beyondCap: number }

/**
 * The customers of the project's scheduled collections on `day` — owed
 * emptyings that generation planned, on routes `planned` or `ready` operating
 * that day — not yet reminded of it: the first `batch` of the first `cap` in
 * customer-id order. The cap is the day's, since the first `cap` are the same
 * customers on every run; a customer beyond it is counted, never reminded.
 * Only a customer with an address on the template's `channel` is counted,
 * since `queueMessage` refuses the rest and writes nothing: one counted would
 * be due again on every run and hold its place in the batch.
 */
export async function remindersDue(tx: Tx, scope: StopScope, day: string, { channel, cap, batch }: { channel: MessageChannel; cap: number; batch: number }): Promise<RemindersDue> {
  const address = channel === "email" ? customer.email : customer.phone
  const scheduled = sql`${route.operatingDate} = ${day}::date and ${route.status} in ('planned', 'ready') and ${pickup.status} = 'planned' and ${pickup.origin} = 'generation' and ${pickup.service} = 'empty'`
  const rows = await tx.execute<{ customer_id: string; key: string; n: number; total: number }>(sql`
    with ranked as (
      select customer_id, ${reminderKey(sql`customer_id`, day)} as key,
        row_number() over (order by customer_id) as n, count(*) over () as total
      from (select distinct customer_id from (${servedStops(scope, scheduled, [])}) as served) as customers
      where exists (select 1 from ${customer} where ${customer.companyId} = ${scope.companyId} and ${customer.id} = customers.customer_id and ${address} is not null)
    )
    select customer_id::text, key::text, n::int, total::int from ranked
    where n <= ${cap} and not exists (
      select 1 from ${message} where ${message.companyId} = ${scope.companyId} and ${message.sourceEventId} = ranked.key and ${message.customerId} = ranked.customer_id
    )
    order by n
    limit ${batch}
  `)
  const total = rows[0]?.total ?? 0
  return { due: rows.map((row) => ({ customerId: row.customer_id, sourceEventId: row.key })), beyondCap: Math.max(0, total - cap) }
}
