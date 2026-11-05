// The scale house's window prices (M16b of #293), the statements the API and
// the worker share: a Scale Ticket's lines with the window's product each is
// sold by, the ticket's live `scale-ticket` events, the charge of one line
// already recorded, and the pricing of one line — under the ticket's
// agreement where it has one (`priceDraft`, the tier on the line's quantity),
// under the project's default list as a walk-in's otherwise — at the rate per
// tonne or per cubic metre times the line's kilograms or litres
// (@waste/domain/finance/window). Nothing here takes a payment.
import type { PricingOutcome, PriceLabels } from "@waste/domain/finance/pricing"
import { priceOccurrence } from "@waste/domain/finance/pricing"
import { quantityOf, soldAtTheWindow, thousandthsOf, windowLoad } from "@waste/domain/finance/window"
import type { ProductUnit } from "@waste/domain/registry/vocabulary"
import { and, asc, eq, inArray, isNull } from "drizzle-orm"

import type { Tx } from "../client"
import { product } from "../schema/catalogue"
import { billableEvent } from "../schema/finance"
import { scaleTicketLine } from "../schema/scale-house"
import { listInForce, priceDraft, rowsOn } from "./billable-writes"
import type { Scope } from "./project-clock"
import { eventsFrom, type EventReading } from "./billing-shapes"
import { lockRow } from "./shared"

/** One line of a ticket as the window prices it: its measure and the product it is sold by, with that product's unit and rate. */
export type WindowLine = {
  lineId: string
  position: number
  wasteFractionId: string
  netKg: number
  volumeLitres: number | null
  product: { id: string; unit: ProductUnit; vatPercent: number | null } | null
}

/** A ticket's lines in position order, each with its product read beside it; or the one line `lineId` names, where it is given. */
export async function windowLinesOf(tx: Tx, companyId: string, ticketId: string | null, lineId?: string): Promise<WindowLine[]> {
  const rows = await tx
    .select({
      lineId: scaleTicketLine.id,
      position: scaleTicketLine.position,
      wasteFractionId: scaleTicketLine.wasteFractionId,
      netKg: scaleTicketLine.netKg,
      volumeLitres: scaleTicketLine.volumeLitres,
      productId: product.id,
      unit: product.unit,
      vatPercent: product.vatPercent,
    })
    .from(scaleTicketLine)
    .leftJoin(product, and(eq(product.companyId, scaleTicketLine.companyId), eq(product.id, scaleTicketLine.productId)))
    .where(and(eq(scaleTicketLine.companyId, companyId), ticketId === null ? undefined : eq(scaleTicketLine.ticketId, ticketId), lineId === undefined ? undefined : eq(scaleTicketLine.id, lineId)))
    .orderBy(asc(scaleTicketLine.position))
  return rows.map((row) => ({
    lineId: row.lineId,
    position: row.position,
    wasteFractionId: row.wasteFractionId,
    netKg: row.netKg,
    volumeLitres: row.volumeLitres,
    product: row.productId === null ? null : { id: row.productId, unit: row.unit as ProductUnit, vatPercent: row.vatPercent },
  }))
}

/**
 * A ticket's live `scale-ticket` events (M16b of #293), not cancelled and not
 * reversed, each under its row lock as a pickup's is, in id order; empty
 * where the ticket has none — never charged, a walk-in's, or every charge
 * already cancelled or reversed.
 */
export async function liveScaleTicketEventsOf(tx: Tx, companyId: string, lineIds: readonly string[]): Promise<EventReading[]> {
  if (lineIds.length === 0) return []
  const { query, reversing } = eventsFrom(tx, companyId)
  const rows = await query
    .where(and(eq(billableEvent.companyId, companyId), eq(billableEvent.kind, "scale-ticket"), inArray(billableEvent.scaleTicketLineId, [...lineIds]), isNull(billableEvent.cancelledAt), isNull(reversing.id)))
    .orderBy(asc(billableEvent.id))
  const live: EventReading[] = []
  for (const row of rows) {
    await lockRow(tx, billableEvent, { companyId, id: row.id })
    const [current] = await eventsFrom(tx, companyId).query.where(and(eq(billableEvent.companyId, companyId), eq(billableEvent.id, row.id))).limit(1)
    if (current !== undefined && current.cancelledAt === null && current.reversalId === null) live.push(current)
  }
  return live
}

/** `billable_event_scale_ticket_charge_idx`: one charge per window line, the consumer's idempotency key for a line's record. */
export const ONE_SCALE_TICKET_CHARGE_PER_LINE = "billable_event_scale_ticket_charge_idx"

/** The charge of a window line already recorded, whatever its standing; undefined while none is. */
export async function scaleTicketChargeOf(tx: Tx, companyId: string, lineId: string): Promise<EventReading | undefined> {
  const [row] = await eventsFrom(tx, companyId)
    .query.where(and(eq(billableEvent.companyId, companyId), eq(billableEvent.kind, "scale-ticket"), eq(billableEvent.scaleTicketLineId, lineId)))
    .limit(1)
  return row
}

/** What one window line is priced on: the day, the line, and the ticket's agreement, or null for a walk-in's. */
export type WindowLineInput = { serviceDate: string; agreementId: string | null; line: WindowLine }

/**
 * One window line priced as Finance would price it: `no-product` where it
 * names no product the window sells or the measure its unit needs; under its
 * agreement through `priceDraft` where it has one, under the project's
 * default list in force with no customer otherwise; then the rate times its
 * thousandths, `amount-too-large` where that does not fit.
 */
export async function priceWindowLine(tx: Tx, scope: Scope, input: WindowLineInput, labels: PriceLabels = {}): Promise<PricingOutcome & { quantity: number | null }> {
  const { line } = input
  const thousandths = line.product === null || !soldAtTheWindow(line.product.unit) ? null : thousandthsOf(line.product.unit, line)
  if (line.product === null || thousandths === null) return { blockReason: "no-product", price: null, resolution: null, quantity: null }
  const quantity = quantityOf(thousandths)
  const outcome =
    input.agreementId !== null
      ? await priceDraft(tx, scope, { agreementId: input.agreementId, productId: line.product.id, quantity: 1, serviceDate: input.serviceDate, wasteFractionId: line.wasteFractionId, tierQuantity: quantity }, labels)
      : await walkInOutcome(tx, scope, line.product, input.serviceDate, line.wasteFractionId, quantity, labels)
  if (outcome.price === null) return { ...outcome, quantity }
  const load = windowLoad(outcome.price, thousandths)
  return load === null ? { blockReason: "amount-too-large", price: null, resolution: outcome.resolution, quantity } : { ...outcome, price: load, quantity }
}

/** A walk-in's line priced under the project's default list in force on the day, as a customer of no kind with no negotiated row. */
async function walkInOutcome(tx: Tx, scope: Scope, sold: { id: string; vatPercent: number | null }, day: string, wasteFractionId: string, quantity: number, labels: PriceLabels): Promise<PricingOutcome> {
  const list = await listInForce(tx, scope, null, day)
  if (list === undefined) return { blockReason: "no-price-list", price: null, resolution: null }
  const rows = await rowsOn(tx, scope.companyId, list.id, sold.id, day)
  return priceOccurrence(
    {
      agreement: { status: "active" },
      priceList: { id: list.id, currency: list.currency, rows },
      product: sold,
      quantity: 1,
      input: { on: day, planningAreaId: null, customerKind: null, containerTypeId: null, wasteFractionId, customerId: null, quantity },
    },
    labels,
  )
}
