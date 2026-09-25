// The billable-event statements, once (Issue #112 §3): the one function that
// writes a `billable_event` row, and the reads that gather what the resolver
// needs and run it.
//
// `recordBillableEvent` is what `POST /billable-events` runs with the
// caller's account, and what part B's consumer will run with `null` and the
// outbox event's id: the row, in the caller's transaction, and nothing else —
// no history row (the audit log is a reprice's history, ADR-0005) and no
// outbox event (nothing acts on a recording; what Finance publishes is the
// invoice, routes/invoice-writes.ts). It takes `tx`, a company and a project,
// the domain's draft (@waste/domain/finance/from-event's `BillableEventDraft`:
// the kind, the links, what the occurrence was under, the quantity, the
// service date, the resolved price or the block), the manual event's two
// texts, `createdBy`, `sourceEventId` and an id minter, and never a Principal
// or a Context, so a worker with no request in hand can call it (#109 §7.24;
// where it lives once `apps/worker` exists is decided there). No clock: the
// stamps are the database's and nothing here is published.
//
// `priceDraft` is the whole pricing of one occurrence as statements, in the
// order `reprice` mends the blocks (@waste/domain/finance/pricing's
// `priceOccurrence`): the agreement with its customer's kind — a draft is
// `agreement-draft` and nothing more is read — then the list it is priced
// under in force on the service date, the agreement's own when it names one
// and the project's default otherwise (`priceListIdFor` as a `where`), none
// being `no-price-list`; then the list's rows for the product valid on the
// day, and the product's VAT rate, handed to the domain, which answers the
// price frozen on the event or `no-price-row` or `no-vat-rate`. The manual
// create, `reprice` and the consumer all price through it, so an event is
// priced one way whichever door recorded it.
//
// The row's shape is checked before the insert (`billableEventShapeIssue`):
// the API composes every row itself, so a row that disagrees with its kind,
// its origin or its price is a bug in a route and thrown as one, never left
// for the table's ten checks to answer as a 500 naming a constraint. The
// checks here spell the same rules as the table's, named for them.
import type { BillableEvent } from "@waste/contracts/billable-events"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { agreement } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { customer } from "@waste/db/schema/customers"
import { billableEvent, priceList, priceListRow } from "@waste/db/schema/finance"
import type { BillableEventDraft } from "@waste/domain/finance/from-event"
import { vatOf } from "@waste/domain/finance/money"
import { priceOccurrence, type PriceLabels, type PriceRow, type PricingOutcome } from "@waste/domain/finance/pricing"
import type { BillableEventKind, BlockReason } from "@waste/domain/finance/vocabulary"
import type { AgreementStatus, CustomerKind } from "@waste/domain/registry/vocabulary"
import { and, asc, eq } from "drizzle-orm"

import type { IdMinter } from "../ids"
import { eventColumns, eventOf, UNNAMED, type EventRow } from "./billing-shapes"
import type { Scope } from "./references"

/** The agreement as pricing reads it: its standing, its parties, its currency, the list it names, and its customer's kind — the prototype's Customer type, a price row's condition. */
export type AgreementFacts = {
  id: string
  status: AgreementStatus
  customerId: string
  payerCustomerId: string
  currency: string
  priceListId: string | null
  customerKind: CustomerKind
}

/** One agreement of the project with its customer's kind, or undefined when there is none: the first read of every pricing, and what the manual create's override reads its currency from. */
export async function agreementFacts(tx: Tx, scope: Scope, agreementId: string): Promise<AgreementFacts | undefined> {
  const [row] = await tx
    .select({
      id: agreement.id,
      status: agreement.status,
      customerId: agreement.customerId,
      payerCustomerId: agreement.payerCustomerId,
      currency: agreement.currency,
      priceListId: agreement.priceListId,
      customerKind: customer.kind,
    })
    .from(agreement)
    .innerJoin(customer, and(eq(customer.companyId, agreement.companyId), eq(customer.id, agreement.customerId)))
    .where(and(eq(agreement.companyId, scope.companyId), eq(agreement.projectId, scope.projectId), eq(agreement.id, agreementId)))
    .limit(1)
  if (row === undefined) return undefined
  return { ...row, status: row.status as AgreementStatus, customerKind: row.customerKind as CustomerKind }
}

/** The product's VAT rate, or undefined when the product is not the project's: the last read of a pricing, and what the override reads its rate from. */
export async function productFacts(tx: Tx, scope: Scope, productId: string): Promise<{ vatPercent: number | null } | undefined> {
  const [row] = await tx
    .select({ vatPercent: product.vatPercent })
    .from(product)
    .where(and(eq(product.companyId, scope.companyId), eq(product.projectId, scope.projectId), eq(product.id, productId)))
    .limit(1)
  return row
}

/** The list an agreement is priced under, in force on the day: its own when it names one, the project's default otherwise (`priceListIdFor` as a `where`); undefined when neither is in force. */
async function listInForce(tx: Tx, scope: Scope, agreementsList: string | null, day: string): Promise<{ id: string; currency: string } | undefined> {
  const [row] = await tx
    .select({ id: priceList.id, currency: priceList.currency })
    .from(priceList)
    .where(
      and(
        eq(priceList.companyId, scope.companyId),
        eq(priceList.projectId, scope.projectId),
        agreementsList === null ? eq(priceList.isDefault, true) : eq(priceList.id, agreementsList),
        validOn(priceList, day),
      ),
    )
    .limit(1)
  return row
}

/** The rows of one list for one product valid on the day, in the order they were made: what the resolver judges. */
async function rowsOn(tx: Tx, companyId: string, listId: string, productId: string, day: string): Promise<PriceRow[]> {
  const rows = await tx
    .select({
      id: priceListRow.id,
      unitPriceMinor: priceListRow.unitPriceMinor,
      planningAreaId: priceListRow.planningAreaId,
      customerKind: priceListRow.customerKind,
      containerTypeId: priceListRow.containerTypeId,
      wasteFractionId: priceListRow.wasteFractionId,
      customerId: priceListRow.customerId,
      validFrom: priceListRow.validFrom,
      validTo: priceListRow.validTo,
    })
    .from(priceListRow)
    .where(and(eq(priceListRow.companyId, companyId), eq(priceListRow.priceListId, listId), eq(priceListRow.productId, productId), validOn(priceListRow, day)))
    .orderBy(asc(priceListRow.id))
  return rows.map((row) => ({ ...row, customerKind: row.customerKind as CustomerKind | null }))
}

/** What one occurrence is priced with: the agreement and the product it was under, how many, the day, and the conditions a pickup carries — null or absent on a manual or a ticket event. */
export type PricingInput = {
  agreementId: string
  productId: string
  quantity: number
  serviceDate: string
  /** The route's scheme's planning area, the price row's zone. */
  planningAreaId?: string | null
  /** The pickup's container's type. */
  containerTypeId?: string | null
  /** The pickup's fraction on the day. */
  wasteFractionId?: string | null
}

const blocked = (blockReason: BlockReason): PricingOutcome => ({ blockReason, price: null, resolution: null })

/**
 * The whole pricing of one occurrence, as statements: the agreement (a draft
 * is `agreement-draft`, and nothing more is read), the list in force on the
 * service date (none is `no-price-list`), the rows for the product on the
 * day, the product's rate — then the domain's `priceOccurrence`, which
 * answers the price or `no-price-row` or `no-vat-rate`. The agreement and the
 * product are held to the project before this is called (the route's 400s),
 * so their absence here is a row that went between statements and is thrown.
 */
export async function priceDraft(tx: Tx, scope: Scope, input: PricingInput, labels: PriceLabels = {}): Promise<PricingOutcome> {
  const facts = await agreementFacts(tx, scope, input.agreementId)
  if (facts === undefined) throw new Error(`priceDraft: agreement ${input.agreementId} is not in project ${scope.projectId}; a route holds the agreement it prices under before pricing`)
  if (facts.status === "draft") return blocked("agreement-draft")
  const list = await listInForce(tx, scope, facts.priceListId, input.serviceDate)
  if (list === undefined) return blocked("no-price-list")
  const rows = await rowsOn(tx, scope.companyId, list.id, input.productId, input.serviceDate)
  const priced = await productFacts(tx, scope, input.productId)
  if (priced === undefined) throw new Error(`priceDraft: product ${input.productId} is not in project ${scope.projectId}; a route holds the product it prices before pricing`)
  return priceOccurrence(
    {
      agreement: { status: facts.status },
      priceList: { id: list.id, currency: list.currency, rows },
      product: priced,
      quantity: input.quantity,
      input: {
        on: input.serviceDate,
        planningAreaId: input.planningAreaId ?? null,
        customerKind: facts.customerKind,
        containerTypeId: input.containerTypeId ?? null,
        wasteFractionId: input.wasteFractionId ?? null,
        customerId: facts.customerId,
      },
    },
    labels,
  )
}

/** The columns of a row as a write composes them, less the ids and the stamps: what the shape rules below judge. */
export type ComposedEvent = {
  kind: BillableEventKind
  agreementId: string | null
  productId: string | null
  quantity: number
  unitPriceMinor: number | null
  netMinor: number | null
  vatPercent: number | null
  vatMinor: number | null
  currency: string | null
  priceListRowId: string | null
  blockReason: string | null
  routeId: string | null
  pickupId: string | null
  ticketId: string | null
  reversesEventId: string | null
  sourceEventId: string | null
  createdBy: string | null
  overrideReason: string | null
}

/**
 * The table's shape rules over a composed row, each named for the check it
 * spells, or undefined where the row holds: blocked is unpriced and priced is
 * unblocked with the five price columns null together or none; a priced event
 * names its agreement and its product; the net is the unit price times the
 * quantity, negated on a reversal, and the VAT the domain's `vatOf`; the
 * winning row is traceable unless blocked, a person's or a reversal; a manual
 * event with a person's price and no row carries the reason and nothing else
 * does; a pickup names its route; what each kind names; and a row is a
 * person's or an event's, never both and never neither.
 */
export function billableEventShapeIssue(row: ComposedEvent): string | undefined {
  const priced = row.netMinor !== null
  if ((row.blockReason === null) !== priced) return "a blocked event carries no price and a priced one no block reason (billable_event_priced_shape)"
  if ([row.unitPriceMinor, row.vatPercent, row.vatMinor, row.currency].some((value) => (value === null) === priced)) return "the five price columns are null together or none (billable_event_priced_shape)"
  if (row.blockReason === null && (row.agreementId === null || row.productId === null)) return "a priced event names its agreement and its product (billable_event_priced_references)"
  if (priced && row.netMinor !== (row.kind === "reversal" ? -1 : 1) * (row.unitPriceMinor ?? 0) * row.quantity) return "the net is the unit price times the quantity, negated on a reversal (billable_event_amounts_shape)"
  if (priced && row.vatMinor !== vatOf(row.netMinor ?? 0, row.vatPercent ?? 0)) return "the VAT is round(net × rate / 100), half away from zero (billable_event_vat_shape)"
  if (row.priceListRowId === null && row.blockReason === null && row.kind !== "manual" && row.kind !== "reversal") return `a priced ${row.kind} event names the row that won (billable_event_row_shape)`
  if ((row.kind === "manual" && row.priceListRowId === null && row.blockReason === null) !== (row.overrideReason !== null)) return "a manual event priced by hand carries the reason, and nothing else does (billable_event_override_shape)"
  if (row.pickupId !== null && row.routeId === null) return "a pickup is named with its route (billable_event_pickup_shape)"
  switch (row.kind) {
    case "pickup":
      if (row.pickupId === null || row.ticketId !== null || row.reversesEventId !== null) return "a pickup event names its pickup and no ticket and no reversal (billable_event_kind_shape)"
      break
    case "ticket":
      if (row.ticketId === null || row.pickupId !== null || row.reversesEventId !== null) return "a ticket event names its ticket and no pickup and no reversal (billable_event_kind_shape)"
      break
    case "manual":
      if (row.pickupId !== null || row.ticketId !== null || row.reversesEventId !== null || row.createdBy === null) return "a manual event names neither a pickup nor a ticket nor a reversal, and has its person (billable_event_kind_shape)"
      break
    case "reversal":
      if (row.reversesEventId === null || row.pickupId !== null || row.ticketId !== null || !priced || (row.netMinor ?? 0) > 0) return "a reversal names the event it undoes, nothing of its own, and carries the negated price (billable_event_kind_shape)"
      break
  }
  if ((row.createdBy === null) !== (row.sourceEventId !== null)) return "an event is a person's or the consumer's, never both and never neither (billable_event_origin_shape)"
  return undefined
}

export type RecordBillableEventInput = {
  companyId: string
  projectId: string
  /** The occurrence as the domain drafted it, or as the office's body spells a manual one. */
  draft: BillableEventDraft
  /** A manual event's two texts — the person's reason for a price of their own, and the note; null on the consumer's. */
  overrideReason: string | null
  note: string | null
  /** The caller's account, or null for the consumer's event. */
  createdBy: string | null
  /** The outbox event the consumer made it from, or null for a person's. */
  sourceEventId: string | null
  /** Mints the row's id: the API's process minter, or the worker's. */
  newId: IdMinter
}

/**
 * Records one billable event: the row, in the caller's transaction, its
 * shape checked before the insert. Answers the row and the `BillableEvent`
 * as the route answers it — `blocked` or `ready`, since no line and no
 * reversal can name a row just written.
 */
export async function recordBillableEvent(tx: Tx, input: RecordBillableEventInput): Promise<{ row: EventRow; answered: BillableEvent }> {
  const { draft } = input
  const { price } = draft
  const composed: ComposedEvent = {
    kind: draft.kind,
    agreementId: draft.agreementId,
    productId: draft.productId,
    quantity: draft.quantity,
    unitPriceMinor: price?.unitPriceMinor ?? null,
    netMinor: price?.netMinor ?? null,
    vatPercent: price?.vatPercent ?? null,
    vatMinor: price?.vatMinor ?? null,
    currency: price?.currency ?? null,
    priceListRowId: price?.priceListRowId ?? null,
    blockReason: draft.blockReason,
    ...draft.links,
    sourceEventId: input.sourceEventId,
    createdBy: input.createdBy,
    overrideReason: input.overrideReason,
  }
  const issue = billableEventShapeIssue(composed)
  if (issue !== undefined) throw new Error(`billable event: ${issue}`)
  const [row] = await tx
    .insert(billableEvent)
    .values({
      id: input.newId(),
      companyId: input.companyId,
      projectId: input.projectId,
      ...composed,
      serviceDate: draft.serviceDate,
      subscriptionId: draft.subscriptionId,
      note: input.note,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
    })
    .returning(eventColumns)
  return { row, answered: eventOf({ ...row, ...UNNAMED }) }
}
