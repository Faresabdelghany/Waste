// Recurring charges as statements (#291 slice 2, #292 C2): what a billing run
// charges a month-sold subscription before it selects, in advance and
// prorated by day by its agreement's cadence (@waste/domain/finance/recurring
// says the arithmetic). `planRecurringCharges` reads and decides, and writes
// nothing — what a run's preview folds into its figures — and
// `mintRecurringCharges` writes what it planned, in the run's transaction
// under the project's lock (`runBilling`), so the office's run and the
// worker's schedule charge alike.
//
// A plan reads, for the project, every subscription whose product is sold by
// the month, under an agreement with a cadence that was not called off
// (`cancelled`; a draft's charge is blocked `agreement-draft`, as its pickups
// are, until it is signed and repriced), in force on some day of the run's
// window — the run's period and the day after it — with its agreement's
// period and its pauses; for each charge period the run charges
// (`chargePeriodsOfRun`) and that holds no charge of the subscription yet,
// the days charged (`chargedDays`, none and there is no charge); and the
// price (`priceRecurringCharge`, which `reprice` calls too): one month of the
// product through `priceDraft`, exactly as a pickup is priced, on the first
// day charged, then the domain's `priceCharge` — the month prorated to the
// period's charged days, times the quantity, its VAT. A price the integer
// columns cannot hold is `amount-too-large`, the office's to look at, never a
// run that fails. Each charge is a `subscription` event: its subscription,
// agreement and product, its period and days, no person and no outbox event
// (the run's own). The `billable_event_subscription_charge_idx` index is the
// idempotency key — one charge per subscription and period — and the insert
// skips a conflict, the backstop behind the project's lock that two runs take
// turns on.
import type { BillingPeriod } from "@waste/domain/finance/periods"
import type { PricedAmounts } from "@waste/domain/finance/pricing"
import { chargedDays, chargePeriodsOfRun, priceCharge, RECURRING_UNIT, type ChargePeriod } from "@waste/domain/finance/recurring"
import type { BlockReason } from "@waste/domain/finance/vocabulary"
import type { BillingCadence } from "@waste/domain/registry/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from "drizzle-orm"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { agreement, subscription, subscriptionPause } from "../schema/agreements"
import { product } from "../schema/catalogue"
import { billableEvent } from "../schema/finance"
import { billableEventShapeIssue, priceDraft, type ComposedEvent } from "./billable-writes"
import type { Scope } from "./project-clock"

/** A recurring charge's price, or the one block that stands in the way. */
export type ChargeOutcome = { blockReason: null; price: PricedAmounts } | { blockReason: BlockReason; price: null }

/** What a recurring charge is priced from: its agreement, product and quantity, the first day charged, its period and how many of its days. */
export type ChargeToPrice = { agreementId: string; productId: string; quantity: number; serviceDate: string; period: ChargePeriod; chargedDays: number }

/** A recurring charge as a run would write it: what it charges and for which period, and its price or the block that stands in the way. */
export type PlannedCharge = ChargeToPrice & ChargeOutcome & { subscriptionId: string; payerCustomerId: string; periodDays: number }

/** Prices one recurring charge: a month of the product as a pickup is priced, on the first day charged, then prorated to the charge (`priceCharge`). */
export async function priceRecurringCharge(tx: Tx, scope: Scope, charge: ChargeToPrice): Promise<ChargeOutcome> {
  const month = await priceDraft(tx, scope, { agreementId: charge.agreementId, productId: charge.productId, quantity: 1, serviceDate: charge.serviceDate })
  if (month.blockReason !== null) return { blockReason: month.blockReason, price: null }
  return priceCharge(month.price, charge.quantity, charge.period, charge.chargedDays)
}

/** The last day a run's window holds: the day after its period, the first day of the next charge period it bills in advance. */
const windowLast = (period: BillingPeriod): string => addDays(period.periodTo, 1)

/** The charges a run over the period would mint for the project, subscription by subscription in id order, each period in order; nothing written. */
export async function planRecurringCharges(tx: Tx, scope: Scope, period: BillingPeriod): Promise<PlannedCharge[]> {
  const last = windowLast(period)
  const subscriptions = await tx
    .select({
      id: subscription.id,
      agreementId: subscription.agreementId,
      productId: subscription.productId,
      quantity: subscription.quantity,
      validFrom: subscription.validFrom,
      validTo: subscription.validTo,
      cadence: agreement.billingCadence,
      payerCustomerId: agreement.payerCustomerId,
      agreementFrom: agreement.validFrom,
      agreementTo: agreement.validTo,
    })
    .from(subscription)
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
    .innerJoin(product, and(eq(product.companyId, subscription.companyId), eq(product.id, subscription.productId)))
    .where(
      and(
        eq(subscription.companyId, scope.companyId),
        eq(subscription.projectId, scope.projectId),
        eq(product.unit, RECURRING_UNIT),
        ne(agreement.billingCadence, "manual"),
        ne(agreement.status, "cancelled"),
        lte(subscription.validFrom, last),
        or(isNull(subscription.validTo), gt(subscription.validTo, period.periodFrom)),
      ),
    )
    .orderBy(asc(subscription.id))
  if (subscriptions.length === 0) return []
  const ids = subscriptions.map((row) => row.id)

  const charged = await tx
    .select({ subscriptionId: billableEvent.subscriptionId, from: billableEvent.chargePeriodFrom })
    .from(billableEvent)
    .where(and(eq(billableEvent.companyId, scope.companyId), eq(billableEvent.kind, "subscription"), inArray(billableEvent.subscriptionId, ids), lte(billableEvent.chargePeriodFrom, last)))
  const already = new Set(charged.map((row) => `${row.subscriptionId}/${row.from}`))
  const pauses = await tx
    .select({ subscriptionId: subscriptionPause.subscriptionId, validFrom: subscriptionPause.validFrom, validTo: subscriptionPause.validTo })
    .from(subscriptionPause)
    .where(and(eq(subscriptionPause.companyId, scope.companyId), inArray(subscriptionPause.subscriptionId, ids)))
  const pausesOf = new Map<string, { validFrom: string; validTo: string | null }[]>()
  for (const pause of pauses) pausesOf.set(pause.subscriptionId, [...(pausesOf.get(pause.subscriptionId) ?? []), pause])

  const planned: PlannedCharge[] = []
  for (const row of subscriptions) {
    for (const chargePeriod of chargePeriodsOfRun(row.cadence as BillingCadence, period)) {
      if (already.has(`${row.id}/${chargePeriod.from}`)) continue
      const days = chargedDays(chargePeriod, [{ validFrom: row.validFrom, validTo: row.validTo }, { validFrom: row.agreementFrom, validTo: row.agreementTo }], pausesOf.get(row.id) ?? [])
      if (days.first === null) continue
      const charge: ChargeToPrice = { agreementId: row.agreementId, productId: row.productId, quantity: row.quantity, serviceDate: days.first, period: chargePeriod, chargedDays: days.days }
      planned.push({ ...charge, subscriptionId: row.id, payerCustomerId: row.payerCustomerId, periodDays: days.periodDays, ...(await priceRecurringCharge(tx, scope, charge)) })
    }
  }
  return planned
}

/** Mints the charges a run over the period charges, in the run's transaction; answers how many it wrote. */
export async function mintRecurringCharges(tx: Tx, scope: Scope, period: BillingPeriod, newId: IdMinter): Promise<number> {
  const planned = await planRecurringCharges(tx, scope, period)
  if (planned.length === 0) return 0
  const rows = planned.map((charge) => {
    const composed: ComposedEvent = {
      kind: "subscription",
      agreementId: charge.agreementId,
      productId: charge.productId,
      quantity: charge.quantity,
      unitPriceMinor: charge.price?.unitPriceMinor ?? null,
      netMinor: charge.price?.netMinor ?? null,
      vatPercent: charge.price?.vatPercent ?? null,
      vatMinor: charge.price?.vatMinor ?? null,
      currency: charge.price?.currency ?? null,
      priceListRowId: charge.price?.priceListRowId ?? null,
      blockReason: charge.blockReason,
      routeId: null,
      pickupId: null,
      ticketId: null,
      reversesEventId: null,
      evidenceProofId: null,
      subscriptionId: charge.subscriptionId,
      sourceEventId: null,
      createdBy: null,
      overrideReason: null,
    }
    const issue = billableEventShapeIssue(composed)
    if (issue !== undefined) throw new Error(`recurring charge: ${issue}`)
    return {
      id: newId(),
      companyId: scope.companyId,
      projectId: scope.projectId,
      ...composed,
      serviceDate: charge.serviceDate,
      chargePeriodFrom: charge.period.from,
      chargePeriodTo: charge.period.to,
      chargedDays: charge.chargedDays,
      periodDays: charge.periodDays,
    }
  })
  let written = 0
  // A statement's parameters are bounded (65 535), and a row binds some thirty.
  for (let at = 0; at < rows.length; at += MINT_CHUNK) written += (await tx.insert(billableEvent).values(rows.slice(at, at + MINT_CHUNK)).onConflictDoNothing().returning({ id: billableEvent.id })).length
  return written
}

/** The charges one insert writes. */
const MINT_CHUNK = 1000
