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
// A pickup's event reads its Pickup Exception too (#293 M5): where the stop
// is one the rules may charge (`isChargeable`), its project's rules, the
// exceptions at its place over the longest rule's window up to its service
// date (`exceptionStopsAt`, the read the API's history makes), the proof that
// recorded its outcome, and `judgeException`'s step; then, where a step is
// charged under a placement, the step's product with its rows on the list the
// placement's agreement is priced under — whatever the placement's own
// product is sold by, since a month's subscription still pays its fees — and
// the pickup's live exception charge, read apart from its collection's.
//
// A stop the office added (#111) is read like any other, with its `origin`:
// the scheme and the container are left joins, since an ad-hoc route names
// no scheme (no planning area, then) and an address-only stop no container
// (no type, and no placement to read), so the event is judged and never a
// dead letter; the domain records nothing for an office stop but a work
// order's job (M14 of #293). For that the stop's `service` and whether a
// ticket booked it (O3c of #290) are read with it, and, where the project
// names a product for the service (`work_order_product`) and no ticket booked
// the stop, the agreement it charges: a delivery's through the subscription
// it books, a removal's and a swap's through the container's latest placement
// to begin by the service date — the one it takes away, which the
// completion's return has ended on that day — and a repair's or a wash's
// through the placement in force that day; with the list it is priced under
// on the service date and its rows. An office stop's own placement is never
// read for a pickup's price, since the domain charges it nothing but a job.
import { isChargeable, judgeException, type PickupExceptionStop } from "@waste/domain/execution/pickup-exceptions"
import type { ExceptionFacts, JobChargeFacts, PlacementFacts, PickupEventFacts, TicketChargeFacts, TicketCompletedFacts, VisitEventFacts } from "@waste/domain/finance/from-event"
import { isWorkOrderService, type PickupOrigin, type PickupOutcome, type PickupReason, type PickupService, type PickupStatus } from "@waste/domain/execution/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import type { AgreementStatus, CustomerKind, ProductStatus, ProductUnit } from "@waste/domain/registry/vocabulary"
import type { TicketResolution } from "@waste/domain/resolution/vocabulary"
import type { Tx } from "@waste/db/client"
import type { SiteVisit } from "@waste/contracts/site-visits"
import { agreementFacts, EXCEPTION_EVENT_KINDS, liveEventOf, liveVisitEventOf, listInForce, rowsOn } from "@waste/db/commands/billable-writes"
import type { EventReading } from "@waste/db/commands/billing-shapes"
import { dayInTimezone } from "@waste/db/commands/days"
import { exceptionRulesOf, exceptionStopsAt, latestOutcomeProofs, placeOf } from "@waste/db/commands/pickup-exceptions"
import { projectTimezone } from "@waste/db/commands/project-clock"
import { lockRow } from "@waste/db/commands/shared"
import { priceVisitCharge, type VisitRow } from "@waste/db/commands/site-visits"
import { validOn } from "@waste/db/query/valid-on"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { customer } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { ticketKindProduct, workOrderProduct } from "@waste/db/schema/finance"
import { ticket, ticketBooking } from "@waste/db/schema/resolution"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { and, desc, eq, lte } from "drizzle-orm"

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
  /** An emptying, or the office's work order (O3 of #290). */
  service: PickupService
  /** The subscription a delivery books; null for every other service. */
  subscriptionId: string | null
  /** Whether a ticket booked the stop to answer it (O3c of #290), the ticket booked again since or not (#422). */
  bookedForTicket: boolean
  /** What a Pickup Exception is judged on (#293 M5): the driver's reason, the contaminant code, and the place it is counted at. */
  reason: string | null
  contaminantCodeId: string | null
  propertyId: string | null
  sharedCollectionPointId: string | null
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
      service: pickup.service,
      subscriptionId: pickup.subscriptionId,
      bookingTicketId: ticketBooking.ticketId,
      reason: pickup.reason,
      contaminantCodeId: pickup.contaminantCodeId,
      propertyId: pickup.propertyId,
      sharedCollectionPointId: pickup.sharedCollectionPointId,
    })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .leftJoin(routeScheme, and(eq(routeScheme.companyId, route.companyId), eq(routeScheme.id, route.routeSchemeId)))
    .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
    // Any booking that ever named the stop, not only a ticket's current one (#422): a stop a rebooking replaced still answered its ticket. One ticket at most books a stop (`ticket_booking_pickup_id_key`).
    .leftJoin(ticketBooking, and(eq(ticketBooking.companyId, pickup.companyId), eq(ticketBooking.pickupId, pickup.id)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId), eq(pickup.id, pickupId)))
    .limit(1)
  if (row === undefined) return undefined
  const { bookingTicketId, ...stop } = row
  return { ...stop, origin: row.origin as PickupOrigin, service: row.service as PickupService, bookedForTicket: bookingTicketId !== null }
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
export const liveFacts = (live: EventReading): PickupEventFacts["liveEvent"] => ({
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
 * The stop as a Pickup Exception (#293 M5): null where it is none the rules
 * may charge; else the rules' judgement over the exceptions at its place, the
 * proof that recorded it, and — where a step is charged under a placement —
 * the step's product priced as any product is.
 */
async function exceptionFacts(tx: Tx, companyId: string, found: PickupRow, pickupId: string, placement: PlacementRead | undefined): Promise<ExceptionFacts | null> {
  const place = placeOf(found)
  if (place === undefined) return null
  const stop: PickupExceptionStop = {
    id: pickupId,
    status: found.status as PickupStatus,
    reason: found.reason as PickupReason | null,
    contaminantCodeId: found.contaminantCodeId,
    origin: found.origin,
    service: found.service,
    serviceDate: found.serviceDate,
    place: place.id,
  }
  if (!isChargeable(stop)) return null
  const scope = { companyId, projectId: found.projectId }
  const rules = await exceptionRulesOf(tx, companyId, found.projectId)
  const reach = Math.max(0, ...rules.map((rule) => rule.windowDays))
  const history = await exceptionStopsAt(tx, companyId, found.projectId, place, addDays(found.serviceDate, -reach), found.serviceDate)
  const judgement = judgeException(stop, rules, history)
  const evidenceProofId = (await latestOutcomeProofs(tx, companyId, [pickupId])).get(pickupId) ?? null
  if (judgement === null || judgement.free || judgement.productId === null || placement === undefined) return { judgement, evidenceProofId, charge: null }
  const [named] = await tx
    .select({ unit: product.unit, vatPercent: product.vatPercent })
    .from(product)
    .where(and(eq(product.companyId, companyId), eq(product.projectId, found.projectId), eq(product.id, judgement.productId)))
    .limit(1)
  if (named === undefined) throw new Error(`pickup exception: step ${judgement.productId} is not a product of project ${found.projectId}; the rule's ladder holds it there`)
  // A draft agreement blocks before any list is read (`priceOccurrence`); the list is read where a price could come of it.
  const list = placement.agreement.status === "draft" ? undefined : await listInForce(tx, scope, placement.priceListId, found.serviceDate)
  return {
    judgement,
    evidenceProofId,
    charge: {
      product: { id: judgement.productId, unit: named.unit as ProductUnit, vatPercent: named.vatPercent },
      priceList: list === undefined ? null : { id: list.id, currency: list.currency, rows: await rowsOn(tx, companyId, list.id, judgement.productId, found.serviceDate) },
    },
  }
}

/**
 * Everything a pickup's event is judged on, read in the order the table
 * lists it — the pickup with its route, scheme and container; the placement
 * valid on the service date with what it reaches; the list the agreement is
 * priced under with its rows on the day; the live event under its lock — and
 * the live event's reading beside it, since the handler that acts on a
 * correction needs the row and not the domain's plain view of it.
 */
export async function pickupFacts(tx: Tx, companyId: string, kind: PickupEventFacts["kind"], found: PickupRow, pickupId: string): Promise<{ facts: PickupEventFacts; live: EventReading[] }> {
  // An address-only stop has no container and so no placement, and an office stop is a job or nothing: the domain judges either on its origin alone.
  const placement = found.containerId === null || found.origin === "office" ? undefined : await placementOn(tx, companyId, found.projectId, found.containerId, found.serviceDate)
  let priced: PlacementFacts | null = null
  if (placement !== undefined) {
    const { priceListId, ...facts } = placement
    // A month or a day product records nothing, and a draft agreement blocks before any list is read (`priceOccurrence`); the list is read where a price could come of it.
    const list = facts.product.unit === "month" || facts.product.unit === "day" || facts.agreement.status === "draft" ? undefined : await listInForce(tx, { companyId, projectId: found.projectId }, priceListId, found.serviceDate)
    priced = { ...facts, priceList: list === undefined ? null : { id: list.id, currency: list.currency, rows: await rowsOn(tx, companyId, list.id, facts.product.id, found.serviceDate) } }
  }
  const live = await liveEventOf(tx, companyId, { routeId: found.routeId, pickupId })
  const liveException = await liveEventOf(tx, companyId, { routeId: found.routeId, pickupId }, EXCEPTION_EVENT_KINDS)
  const exception = await exceptionFacts(tx, companyId, found, pickupId, placement)
  return {
    facts: {
      service: found.service,
      bookedForTicket: found.bookedForTicket,
      job: await jobFacts(tx, companyId, found),
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
      exception,
      liveException: liveException === undefined ? null : liveFacts(liveException),
    },
    live: [live, liveException].flatMap((row) => (row === undefined ? [] : [row])),
  }
}

/**
 * A work order's charge (M14 of #293): the project's product for the stop's
 * service, and the agreement it charges with its pricing; null for an
 * emptying, a stop a ticket booked — the ticket's charge is the one — and a
 * service the project names no product for, none of which the domain charges.
 */
async function jobFacts(tx: Tx, companyId: string, found: PickupRow): Promise<JobChargeFacts | null> {
  if (found.origin !== "office" || !isWorkOrderService(found.service) || found.bookedForTicket || found.containerId === null) return null
  const scope = { companyId, projectId: found.projectId }
  const [named] = await tx
    .select({ id: product.id, status: product.status, unit: product.unit, vatPercent: product.vatPercent })
    .from(workOrderProduct)
    .innerJoin(product, and(eq(product.companyId, workOrderProduct.companyId), eq(product.id, workOrderProduct.productId)))
    .where(and(eq(workOrderProduct.companyId, companyId), eq(workOrderProduct.projectId, found.projectId), eq(workOrderProduct.service, found.service)))
    .limit(1)
  if (named === undefined) return null
  const jobProduct = { id: named.id, status: named.status as ProductStatus, unit: named.unit as ProductUnit, vatPercent: named.vatPercent }
  const subscriptionId = found.service === "deliver" ? found.subscriptionId : await placedUnder(tx, scope, found.containerId, found.serviceDate, found.service === "remove" || found.service === "swap")
  const [served] =
    subscriptionId === null
      ? []
      : await tx
          .select({ agreementId: subscription.agreementId })
          .from(subscription)
          .where(and(eq(subscription.companyId, companyId), eq(subscription.projectId, found.projectId), eq(subscription.id, subscriptionId)))
          .limit(1)
  const facts = served === undefined ? undefined : await agreementFacts(tx, scope, served.agreementId)
  if (facts === undefined) return { product: jobProduct, agreement: null, subscriptionId: null, priceList: null }
  const list = facts.status === "draft" ? undefined : await listInForce(tx, scope, facts.priceListId, found.serviceDate)
  return {
    product: jobProduct,
    agreement: { id: facts.id, status: facts.status, customerKind: facts.customerKind, customerId: facts.customerId },
    subscriptionId,
    priceList: list === undefined ? null : { id: list.id, currency: list.currency, rows: await rowsOn(tx, companyId, list.id, jobProduct.id, found.serviceDate) },
  }
}

/** The subscription a container stood under for a work order on the day: the placement in force, or for a removal or a swap its latest to begin by the day, ended or not. Null where none is. */
async function placedUnder(tx: Tx, scope: { companyId: string; projectId: string }, containerId: string, day: string, latest: boolean): Promise<string | null> {
  const [placed] = await tx
    .select({ subscriptionId: containerServicePlacement.subscriptionId })
    .from(containerServicePlacement)
    .where(
      and(
        eq(containerServicePlacement.companyId, scope.companyId),
        eq(containerServicePlacement.projectId, scope.projectId),
        eq(containerServicePlacement.containerId, containerId),
        latest ? lte(containerServicePlacement.validFrom, day) : validOn(containerServicePlacement, day),
      ),
    )
    .orderBy(desc(containerServicePlacement.validFrom))
    .limit(1)
  return placed?.subscriptionId ?? null
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

/**
 * A Site Visit's event as the domain reads it (#393, M4 of #293): the visit
 * as it stands now — admitted or not, voided or not, the Agreement it is
 * charged to — its live `visit` event under its row lock, and, for a
 * recording of an admitted visit standing unvoided and uncharged, the
 * product its Visit Rule charged it at when it was checked in — stored on
 * the visit, the number the attendant quoted, never recounted here — priced
 * through `priceDraft` on its day. The caller holds the visit's row lock, so
 * a recording and its void take turns.
 */
export async function visitFacts(tx: Tx, companyId: string, kind: VisitEventFacts["kind"], found: { row: VisitRow; visit: SiteVisit }): Promise<{ facts: VisitEventFacts; live: EventReading[] }> {
  const { row } = found
  const scope = { companyId, projectId: row.projectId }
  const live = await liveVisitEventOf(tx, companyId, row.id)
  const voided = row.voidedAt !== null
  const admitted = row.outcome === "admitted"
  const productId = admitted ? row.chargeProductId : null
  const judged = kind === "site-visit-recorded" && admitted && !voided && live === undefined
  const priced = judged ? await priceVisitCharge(tx, scope, row.agreementId, productId, row.serviceDate) : null
  return {
    facts: {
      kind,
      visitId: row.id,
      serviceDate: row.serviceDate,
      admitted,
      voided,
      agreementId: row.agreementId,
      productId,
      priced: priced === null ? null : { price: priced.price, blockReason: priced.blockReason },
      liveEvent: live === undefined ? null : liveFacts(live),
    },
    live: live === undefined ? [] : [live],
  }
}
