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
// has no `closedAt`, and its completion is stale news, not a failure. Then
// the product it charges for (#291 C3): the one its completion named, else the
// project's for the ticket's kind (`ticket_kind_product`), with its status,
// unit and rate, the agreement's pricing facts and the list in force on the
// day it closed with its rows — whether the product is charged at all is the
// domain's (`chargesTicketWork`), so a retired one is read like any other.
//
// A stop the office added (#111) is read like any other, with its `origin`:
// the scheme and the container are left joins, since an ad-hoc route names
// no scheme (no planning area, then) and an address-only stop no container
// (no type, and no placement to read), so the event is judged and never a
// dead letter; the domain records nothing for an office stop.
import type { PlacementFacts, PickupEventFacts, TicketChargeFacts, TicketCompletedFacts } from "@waste/domain/finance/from-event"
import type { PickupOrigin, PickupOutcome } from "@waste/domain/execution/vocabulary"
import type { AgreementStatus, CustomerKind, ProductStatus, ProductUnit } from "@waste/domain/registry/vocabulary"
import type { TicketResolution } from "@waste/domain/resolution/vocabulary"
import type { Tx } from "@waste/db/client"
import { agreementFacts, liveEventOf, listInForce, rowsOn } from "@waste/db/commands/billable-writes"
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
import { ticketKindProduct } from "@waste/db/schema/finance"
import { ticket } from "@waste/db/schema/resolution"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { and, eq } from "drizzle-orm"

/** A pickup as the consumer read it: the row the event names, with its route's identity day and scheme, its container's type, who put it there, and its status now. */
export type PickupRow = {
  projectId: string
  routeId: string
  serviceDate: string
  /** Null for a scheme without one, and on the office's ad-hoc route, which has no scheme (#111). */
  planningAreaId: string | null
  /** Both null on an address-only stop the office added (#111). */
  containerId: string | null
  containerTypeId: string | null
  origin: PickupOrigin
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
      origin: pickup.origin,
      wasteFractionId: pickup.wasteFractionId,
      status: pickup.status,
    })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .leftJoin(routeScheme, and(eq(routeScheme.companyId, route.companyId), eq(routeScheme.id, route.routeSchemeId)))
    .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId), eq(pickup.id, pickupId)))
    .limit(1)
  return row === undefined ? undefined : { ...row, origin: row.origin as PickupOrigin }
}

/** The placement as read, before the list: what the domain's `PlacementFacts` carries less the list, plus the list the agreement names (null for the project's default), which the next read needs. */
type PlacementRead = Omit<PlacementFacts, "priceList"> & { priceListId: string | null }

/** The placement of the container valid on the day, with its subscription, agreement, customer's kind and product; undefined when none was. Resolution's consumer reads a stop's agreement and customer through it too (#258). */
export async function placementOn(tx: Tx, companyId: string, projectId: string, containerId: string, day: string): Promise<PlacementRead | undefined> {
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
  // An address-only stop has no container and so no placement: the domain judges it on its origin alone.
  const placement = found.containerId === null ? undefined : await placementOn(tx, companyId, found.projectId, found.containerId, found.serviceDate)
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
      origin: found.origin,
      containerTypeId: found.containerTypeId,
      wasteFractionId: found.wasteFractionId,
      outcome: found.status as PickupOutcome,
      placement: priced,
      liveEvent: live === undefined ? null : liveFacts(live),
    },
    live,
  }
}

/** A ticket as the consumer read it: its project and kind, what it ended in, when it closed, the agreement and pickup it names, and the product its completion named. */
export type TicketRow = {
  projectId: string
  kind: string
  status: string
  resolution: string | null
  closedAt: Date | null
  agreementId: string | null
  routeId: string | null
  pickupId: string | null
  chargeProductId: string | null
}

/**
 * The ticket the event names, as it stands now, under its row lock
 * (`lockRow(ticket)`, so two events of one ticket take turns as a pickup's
 * do); undefined when the row is not there, which locks nothing.
 */
export async function ticketRow(tx: Tx, companyId: string, ticketId: string): Promise<TicketRow | undefined> {
  await lockRow(tx, ticket, { companyId, id: ticketId })
  const [row] = await tx
    .select({ projectId: ticket.projectId, kind: ticket.kind, status: ticket.status, resolution: ticket.resolution, closedAt: ticket.closedAt, agreementId: ticket.agreementId, routeId: ticket.routeId, pickupId: ticket.pickupId, chargeProductId: ticket.chargeProductId })
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.id, ticketId)))
    .limit(1)
  return row
}

/**
 * Everything a completed ticket's event is judged on: the agreement it
 * reaches — the one its pickup's placement ran under on the route's service
 * date, with that placement's subscription, where the ticket names no
 * agreement or names that one (the Driver App's tickets name both, #258);
 * else its own, with no subscription — and the day it
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
  let reached: TicketCompletedFacts["agreement"] = null
  if (found.routeId !== null && found.pickupId !== null) {
    const stop = await pickupRow(tx, companyId, found.routeId, found.pickupId)
    const placement = stop === undefined || stop.containerId === null ? undefined : await placementOn(tx, companyId, stop.projectId, stop.containerId, stop.serviceDate)
    if (placement !== undefined && (found.agreementId === null || found.agreementId === placement.agreement.id)) reached = { id: placement.agreement.id, subscriptionId: placement.subscriptionId }
  }
  if (reached === null && found.agreementId !== null) reached = { id: found.agreementId, subscriptionId: null }
  const timezone = await projectTimezone(tx, companyId, found.projectId)
  const closedOn = found.closedAt === null ? null : dayInTimezone(found.closedAt, timezone)
  const charge = reached === null || closedOn === null ? null : await chargeFacts(tx, { companyId, projectId: found.projectId }, found, reached.id, closedOn)
  return { kind: "ticket-completed", ticketId, resolution: found.resolution as TicketResolution | null, agreement: reached, closedOn, charge }
}

/**
 * The product a completed ticket charges for (#291 C3) — the completion's,
 * else the project's for the ticket's kind; null where neither names one —
 * with what the resolver prices it from: the agreement's facts and, unless it
 * is a draft, which blocks before any list is read, the list it is priced
 * under in force on the day the ticket closed with its rows for the product.
 */
async function chargeFacts(tx: Tx, scope: { companyId: string; projectId: string }, found: TicketRow, agreementId: string, closedOn: string): Promise<TicketChargeFacts | null> {
  let source: TicketChargeFacts["source"] = "completion"
  let productId = found.chargeProductId
  if (productId === null) {
    const [mapped] = await tx
      .select({ productId: ticketKindProduct.productId })
      .from(ticketKindProduct)
      .where(and(eq(ticketKindProduct.companyId, scope.companyId), eq(ticketKindProduct.projectId, scope.projectId), eq(ticketKindProduct.ticketKind, found.kind)))
      .limit(1)
    if (mapped === undefined) return null
    source = "kind"
    productId = mapped.productId
  }
  const [named] = await tx
    .select({ status: product.status, unit: product.unit, vatPercent: product.vatPercent })
    .from(product)
    .where(and(eq(product.companyId, scope.companyId), eq(product.projectId, scope.projectId), eq(product.id, productId)))
    .limit(1)
  if (named === undefined) throw new Error(`ticket charge: product ${productId} is not in project ${scope.projectId}; the ticket's key and the charges' hold it there`)
  const facts = await agreementFacts(tx, scope, agreementId)
  if (facts === undefined) throw new Error(`ticket charge: agreement ${agreementId} is not in project ${scope.projectId}; the ticket reached it there`)
  const list = facts.status === "draft" ? undefined : await listInForce(tx, scope, facts.priceListId, closedOn)
  return {
    source,
    product: { id: productId, status: named.status as ProductStatus, unit: named.unit as ProductUnit, vatPercent: named.vatPercent },
    agreement: { status: facts.status, customerKind: facts.customerKind, customerId: facts.customerId },
    priceList: list === undefined ? null : { id: list.id, currency: list.currency, rows: await rowsOn(tx, scope.companyId, list.id, productId, closedOn) },
  }
}
