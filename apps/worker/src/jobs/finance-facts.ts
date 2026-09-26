// The facts the Finance consumer reads beside an outbox event's payload
// (Issue #112 §3, the table under "The consumer's contract"), one statement
// each under `withCompany`, handed to the domain's `billableFor` as plain
// values. Nothing is decided here: which event becomes which billable event
// is `@waste/domain/finance/from-event`'s, and this module is the joins that
// gather what that rule asks for, spelled once so the handler
// (record-billable-events.ts) reads like the table.
//
// For a pickup's event: the pickup's row lock first (`lockRow(pickup)`), so
// every Finance event of one pickup takes its turn — the driver's completion
// and the office's correction to the same outcome minutes later are two
// events on two queues, worked by two workers at once, and both would read
// "no live event" and both record without it: the `source_event_id` index
// holds one row per event, not one per pickup, so the lock is what holds the
// pickup to one live event; then the pickup with its route (`service_date`,
// the identity day; `route_scheme_id`), the scheme's planning area, the
// container's type, the fraction on the day and the pickup's status now —
// the table's word, not the payload's, since pg-boss delivers in no promised
// order; then the placement of the container valid on the service date with
// its subscription, agreement (status, customer, payer, `price_list_id`,
// currency) and the customer's kind, the product (unit, `vat_percent`), and
// the list the agreement is priced under with its rows on the day — the
// commands' `listInForce` and `rowsOn`, the same statements `priceDraft` runs
// for the office's event, so a pickup is priced one way whichever door
// recorded it; and the pickup's live event under its row lock
// (`liveEventOf`). For a ticket's: the ticket's row lock for the same reason
// (two `ticket-completed` events of one ticket are two events, and the lock
// holds the reads to one at a time), then the ticket's own agreement, or the
// agreement of its pickup's placement on the route's service date, with that
// placement's subscription; and the project's timezone, in which the worker
// renders `closedAt` as the day the ticket closed — a ticket reopened since
// has no `closedAt`, and its completion is stale news, not a failure.
import type { PlacementFacts, PickupEventFacts, TicketCompletedFacts } from "@waste/domain/finance/from-event"
import type { PickupOutcome } from "@waste/domain/execution/vocabulary"
import type { AgreementStatus, CustomerKind, ProductUnit } from "@waste/domain/registry/vocabulary"
import type { TicketResolution } from "@waste/domain/resolution/vocabulary"
import type { Tx } from "@waste/db/client"
import { liveEventOf, listInForce, rowsOn } from "@waste/db/commands/billable-writes"
import type { EventReading } from "@waste/db/commands/billing-shapes"
import { dayInTimezone } from "@waste/db/commands/days"
import { projectTimezone } from "@waste/db/commands/project-clock"
import { lockRow } from "@waste/db/commands/shared"
import { validOn } from "@waste/db/query/valid-on"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { customer } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { ticket } from "@waste/db/schema/resolution"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { and, eq } from "drizzle-orm"

/** A pickup as the consumer read it: the row the event names, with its route's identity day and scheme, its container's type, and its status now. */
export type PickupRow = {
  projectId: string
  routeId: string
  serviceDate: string
  planningAreaId: string | null
  containerId: string
  containerTypeId: string
  wasteFractionId: string
  status: string
}

/** Whether the read takes the pickup's row lock first: the consumer's own event does, so two Finance events of one pickup take turns; a ticket's read of its pickup does not. */
export type PickupRowOptions = { lock?: boolean }

/**
 * The pickup of the route the event names, with its route, its scheme's
 * planning area and its container's type; undefined when the row is not
 * there. With `lock`, `lockRow(pickup)` runs first — `select … for update` on
 * the pickup's own row, as `wms_api` under the fence — so the status and the
 * live event read after it are what the lock let through: two workers on two
 * events of one pickup (the completion on `outbox.pickup-completed`, a
 * correction to `completed` on `outbox.pickup-corrected`) serialise here, and
 * the second reads the first's event and records nothing. An id that is not
 * there locks nothing, and the read answers for it.
 */
export async function pickupRow(tx: Tx, companyId: string, routeId: string, pickupId: string, { lock = false }: PickupRowOptions = {}): Promise<PickupRow | undefined> {
  if (lock) await lockRow(tx, pickup, { companyId, id: pickupId })
  const [row] = await tx
    .select({
      projectId: pickup.projectId,
      routeId: pickup.routeId,
      serviceDate: route.serviceDate,
      planningAreaId: routeScheme.planningAreaId,
      containerId: pickup.containerId,
      containerTypeId: container.containerTypeId,
      wasteFractionId: pickup.wasteFractionId,
      status: pickup.status,
    })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .innerJoin(routeScheme, and(eq(routeScheme.companyId, route.companyId), eq(routeScheme.id, route.routeSchemeId)))
    .innerJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId), eq(pickup.id, pickupId)))
    .limit(1)
  return row
}

/** The placement as read, before the list: what the domain's `PlacementFacts` carries less the list, plus the list the agreement names (null for the project's default), which the next read needs. */
type PlacementRead = Omit<PlacementFacts, "priceList"> & { priceListId: string | null }

/** The placement of the container valid on the day, with its subscription, agreement, customer's kind and product; undefined when none was. */
async function placementOn(tx: Tx, companyId: string, projectId: string, containerId: string, day: string): Promise<PlacementRead | undefined> {
  const [row] = await tx
    .select({
      subscriptionId: containerServicePlacement.subscriptionId,
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
    .innerJoin(subscription, and(eq(subscription.companyId, containerServicePlacement.companyId), eq(subscription.id, containerServicePlacement.subscriptionId)))
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
    .innerJoin(customer, and(eq(customer.companyId, agreement.companyId), eq(customer.id, agreement.customerId)))
    .innerJoin(product, and(eq(product.companyId, subscription.companyId), eq(product.id, subscription.productId)))
    .where(and(eq(containerServicePlacement.companyId, companyId), eq(containerServicePlacement.projectId, projectId), eq(containerServicePlacement.containerId, containerId), validOn(containerServicePlacement, day)))
    .limit(1)
  if (row === undefined) return undefined
  return {
    subscriptionId: row.subscriptionId,
    agreement: { id: row.agreementId, status: row.agreementStatus as AgreementStatus, customerKind: row.customerKind as CustomerKind, customerId: row.customerId },
    product: { id: row.productId, unit: row.unit as ProductUnit, vatPercent: row.vatPercent },
    priceListId: row.priceListId,
  }
}

/** The live event as the domain reads it: its parties, its quantity, its frozen price or null while blocked, its day, and whether a line names it. */
const liveFacts = (live: EventReading): PickupEventFacts["liveEvent"] => ({
  id: live.id,
  agreementId: live.agreementId,
  subscriptionId: live.subscriptionId,
  productId: live.productId,
  quantity: live.quantity,
  price:
    live.netMinor === null || live.unitPriceMinor === null || live.vatPercent === null || live.vatMinor === null || live.currency === null
      ? null
      : { priceListRowId: live.priceListRowId, unitPriceMinor: live.unitPriceMinor, netMinor: live.netMinor, vatPercent: live.vatPercent, vatMinor: live.vatMinor, currency: live.currency },
  serviceDate: live.serviceDate,
  invoiced: live.invoiceLineId !== null,
})

/**
 * Everything a pickup's event is judged on, read in the order the table
 * lists it — the pickup with its route, scheme and container; the placement
 * valid on the service date with what it reaches; the list the agreement is
 * priced under with its rows on the day; the live event under its lock — and
 * the live event's reading beside it, since the handler that acts on a
 * correction needs the row and not the domain's plain view of it.
 */
export async function pickupFacts(tx: Tx, companyId: string, kind: PickupEventFacts["kind"], found: PickupRow, pickupId: string): Promise<{ facts: PickupEventFacts; live: EventReading | undefined }> {
  const placement = await placementOn(tx, companyId, found.projectId, found.containerId, found.serviceDate)
  let priced: PlacementFacts | null = null
  if (placement !== undefined) {
    const { priceListId, ...facts } = placement
    // A month product records nothing, and a draft agreement blocks before any list is read (`priceOccurrence`); the list is read where a price could come of it.
    const list = facts.product.unit === "month" || facts.agreement.status === "draft" ? undefined : await listInForce(tx, { companyId, projectId: found.projectId }, priceListId, found.serviceDate)
    priced = { ...facts, priceList: list === undefined ? null : { id: list.id, currency: list.currency, rows: await rowsOn(tx, companyId, list.id, facts.product.id, found.serviceDate) } }
  }
  const live = await liveEventOf(tx, companyId, { routeId: found.routeId, pickupId })
  return {
    facts: {
      kind,
      routeId: found.routeId,
      pickupId,
      serviceDate: found.serviceDate,
      planningAreaId: found.planningAreaId,
      containerTypeId: found.containerTypeId,
      wasteFractionId: found.wasteFractionId,
      outcome: found.status as PickupOutcome,
      placement: priced,
      liveEvent: live === undefined ? null : liveFacts(live),
    },
    live,
  }
}

/** A ticket as the consumer read it: its project, what it ended in, when it closed, and the agreement and pickup it names. */
export type TicketRow = {
  projectId: string
  status: string
  resolution: string | null
  closedAt: Date | null
  agreementId: string | null
  routeId: string | null
  pickupId: string | null
}

/**
 * The ticket the event names, as it stands now, under its row lock
 * (`lockRow(ticket)`, so two events of one ticket take turns as a pickup's
 * do); undefined when the row is not there, which locks nothing.
 */
export async function ticketRow(tx: Tx, companyId: string, ticketId: string): Promise<TicketRow | undefined> {
  await lockRow(tx, ticket, { companyId, id: ticketId })
  const [row] = await tx
    .select({ projectId: ticket.projectId, status: ticket.status, resolution: ticket.resolution, closedAt: ticket.closedAt, agreementId: ticket.agreementId, routeId: ticket.routeId, pickupId: ticket.pickupId })
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.id, ticketId)))
    .limit(1)
  return row
}

/**
 * Everything a completed ticket's event is judged on: the agreement it
 * reaches — its own, or the one its pickup's placement ran under on the
 * route's service date, with that placement's subscription — and the day it
 * closed on the project's clock. `closedAt` is the ticket's own stamp
 * (`ticket_closed_shape` ties it to the status), read now rather than from
 * the payload for the same reason the pickup's status is: a ticket
 * `reopen`ed since its completion was published has no closing instant, and
 * its `closedOn` is null — stale news the domain answers nothing to, as it
 * does a completion whose pickup a correction moved — never a failed job,
 * since a completion followed by a reopening is an ordinary day and not a
 * relay gone wrong.
 */
export async function ticketFacts(tx: Tx, companyId: string, ticketId: string, found: TicketRow): Promise<TicketCompletedFacts> {
  let reached: TicketCompletedFacts["agreement"] = found.agreementId === null ? null : { id: found.agreementId, subscriptionId: null }
  if (reached === null && found.routeId !== null && found.pickupId !== null) {
    const stop = await pickupRow(tx, companyId, found.routeId, found.pickupId)
    if (stop !== undefined) {
      const placement = await placementOn(tx, companyId, stop.projectId, stop.containerId, stop.serviceDate)
      if (placement !== undefined) reached = { id: placement.agreement.id, subscriptionId: placement.subscriptionId }
    }
  }
  const timezone = await projectTimezone(tx, companyId, found.projectId)
  return { kind: "ticket-completed", ticketId, resolution: found.resolution as TicketResolution | null, agreement: reached, closedOn: found.closedAt === null ? null : dayInTimezone(found.closedAt, timezone) }
}
