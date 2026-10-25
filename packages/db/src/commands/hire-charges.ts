// Container hire as statements (M14 of #293): what a billing run charges the
// containers of a day-sold subscription before it selects, by calendar month
// in arrears, each placement's first free days not charged
// (@waste/domain/finance/hire says the arithmetic). `planHireCharges` reads
// and decides, and writes nothing — what a run's preview folds into its
// figures — and `mintHireCharges` writes what it planned, in the run's
// transaction under the project's lock (`runBilling`), beside the recurring
// charges, so the office's run and the worker's schedule charge alike.
//
// A plan reads, for the project, every placement under a subscription whose
// product is sold by the day (`HIRE_UNIT`), of an agreement with a cadence
// that was not called off (`manual` is billed by hand, `cancelled` not at all;
// a draft's hire is blocked `agreement-draft`, as its pickups are), that stood
// on site on some day from the first of the run's first month to the run's
// last day; with its container's type, its fraction and the product's free
// days. For each month the run charges on the project's today
// (`hireMonthsDue`: ended by then, so no day still to come) that holds no hire
// of the placement yet, the days charged (`hireDays`, none and there is no
// charge), and the price (`priceHire`, which `reprice` calls too): the day
// of the product through `priceDraft`, exactly as a pickup is priced, with
// the charged days its quantity, on the first day charged, under the
// container's type and the placement's fraction. A subscription's pause does
// not stop it: the bin still stands there. Each charge is a `hire` event: its
// subscription, agreement, product, container and placement, its month and
// days, no person and no outbox event (the run's own). The
// `billable_event_hire_charge_idx` index is the idempotency key — one charge
// per placement and month — and the insert skips a conflict, the backstop
// behind the project's lock that two runs take turns on.
import { daysOf, HIRE_UNIT, hireDays, hireMonthsDue, monthOf } from "@waste/domain/finance/hire"
import type { BillingPeriod } from "@waste/domain/finance/periods"
import type { ChargePeriod } from "@waste/domain/finance/recurring"
import { and, asc, eq, gt, gte, inArray, isNull, lte, ne, or } from "drizzle-orm"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { agreement, subscription } from "../schema/agreements"
import { product } from "../schema/catalogue"
import { container, containerServicePlacement } from "../schema/containers"
import { billableEvent } from "../schema/finance"
import { billableEventShapeIssue, priceDraft, type ComposedEvent } from "./billable-writes"
import type { Scope } from "./project-clock"
import type { ChargeOutcome } from "./recurring-charges"

/** What a hire is priced from: its agreement and product, the first day charged, the days charged, and the conditions its container sets. */
export type HireToPrice = { agreementId: string; productId: string; serviceDate: string; chargedDays: number; containerTypeId: string; wasteFractionId: string }

/** A hire as a run would write it: the placement and month it charges, and its price or the block that stands in the way. */
export type PlannedHire = HireToPrice & ChargeOutcome & { placementId: string; containerId: string; subscriptionId: string; payerCustomerId: string; period: ChargePeriod; periodDays: number }

/** Prices one hire: the product's day as a pickup is priced, the charged days its quantity, under the container's type and the placement's fraction. */
export async function priceHire(tx: Tx, scope: Scope, hire: HireToPrice): Promise<ChargeOutcome> {
  const priced = await priceDraft(tx, scope, { agreementId: hire.agreementId, productId: hire.productId, quantity: hire.chargedDays, serviceDate: hire.serviceDate, containerTypeId: hire.containerTypeId, wasteFractionId: hire.wasteFractionId })
  return priced.blockReason === null ? { blockReason: null, price: priced.price } : { blockReason: priced.blockReason, price: null }
}

/** The conditions a hire event was priced under, off its placement: the container's type and the placement's fraction; undefined where the placement is not there. */
export async function hireConditionsOf(tx: Tx, scope: Scope, placementId: string): Promise<{ containerTypeId: string; wasteFractionId: string } | undefined> {
  const [row] = await tx
    .select({ containerTypeId: container.containerTypeId, wasteFractionId: containerServicePlacement.wasteFractionId })
    .from(containerServicePlacement)
    .innerJoin(container, and(eq(container.companyId, containerServicePlacement.companyId), eq(container.id, containerServicePlacement.containerId)))
    .where(and(eq(containerServicePlacement.companyId, scope.companyId), eq(containerServicePlacement.projectId, scope.projectId), eq(containerServicePlacement.id, placementId)))
    .limit(1)
  return row
}

/** The hires a run over the period on `today`, the project's day, would mint for the project, placement by placement in id order, each month in order; nothing written. */
export async function planHireCharges(tx: Tx, scope: Scope, period: BillingPeriod, today: string): Promise<PlannedHire[]> {
  const firstMonth = monthOf(period.periodFrom).from
  const placements = await tx
    .select({
      id: containerServicePlacement.id,
      containerId: containerServicePlacement.containerId,
      subscriptionId: containerServicePlacement.subscriptionId,
      wasteFractionId: containerServicePlacement.wasteFractionId,
      validFrom: containerServicePlacement.validFrom,
      validTo: containerServicePlacement.validTo,
      containerTypeId: container.containerTypeId,
      agreementId: subscription.agreementId,
      productId: subscription.productId,
      freeDays: product.freeDays,
      payerCustomerId: agreement.payerCustomerId,
    })
    .from(containerServicePlacement)
    .innerJoin(container, and(eq(container.companyId, containerServicePlacement.companyId), eq(container.id, containerServicePlacement.containerId)))
    .innerJoin(subscription, and(eq(subscription.companyId, containerServicePlacement.companyId), eq(subscription.id, containerServicePlacement.subscriptionId)))
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
    .innerJoin(product, and(eq(product.companyId, subscription.companyId), eq(product.id, subscription.productId)))
    .where(
      and(
        eq(containerServicePlacement.companyId, scope.companyId),
        eq(containerServicePlacement.projectId, scope.projectId),
        eq(product.unit, HIRE_UNIT),
        ne(agreement.billingCadence, "manual"),
        ne(agreement.status, "cancelled"),
        lte(containerServicePlacement.validFrom, period.periodTo),
        or(isNull(containerServicePlacement.validTo), gt(containerServicePlacement.validTo, firstMonth)),
      ),
    )
    .orderBy(asc(containerServicePlacement.id))
  if (placements.length === 0) return []

  const charged = await tx
    .select({ placementId: billableEvent.placementId, from: billableEvent.chargePeriodFrom })
    .from(billableEvent)
    .where(
      and(
        eq(billableEvent.companyId, scope.companyId),
        eq(billableEvent.kind, "hire"),
        // A month before the run's first is none of this run's.
        gte(billableEvent.chargePeriodFrom, firstMonth),
        inArray(
          billableEvent.placementId,
          placements.map((row) => row.id),
        ),
      ),
    )
  const already = new Set(charged.map((row) => `${row.placementId}/${row.from}`))

  const planned: PlannedHire[] = []
  for (const row of placements) {
    for (const month of hireMonthsDue({ validFrom: row.validFrom, validTo: row.validTo }, period, today)) {
      if (already.has(`${row.id}/${month.from}`)) continue
      const days = hireDays({ validFrom: row.validFrom, validTo: row.validTo }, month, row.freeDays ?? 0)
      if (days.first === null) continue
      const hire: HireToPrice = { agreementId: row.agreementId, productId: row.productId, serviceDate: days.first, chargedDays: days.charged, containerTypeId: row.containerTypeId, wasteFractionId: row.wasteFractionId }
      planned.push({
        ...hire,
        placementId: row.id,
        containerId: row.containerId,
        subscriptionId: row.subscriptionId,
        payerCustomerId: row.payerCustomerId,
        period: month,
        periodDays: daysOf(month),
        ...(await priceHire(tx, scope, hire)),
      })
    }
  }
  return planned
}

/** Mints the hires a run over the period on `today` charges, in the run's transaction; answers how many it wrote. */
export async function mintHireCharges(tx: Tx, scope: Scope, period: BillingPeriod, today: string, newId: IdMinter): Promise<number> {
  const planned = await planHireCharges(tx, scope, period, today)
  if (planned.length === 0) return 0
  const rows = planned.map((hire) => {
    const composed: ComposedEvent = {
      kind: "hire",
      agreementId: hire.agreementId,
      productId: hire.productId,
      quantity: hire.chargedDays,
      unitPriceMinor: hire.price?.unitPriceMinor ?? null,
      netMinor: hire.price?.netMinor ?? null,
      vatPercent: hire.price?.vatPercent ?? null,
      vatMinor: hire.price?.vatMinor ?? null,
      currency: hire.price?.currency ?? null,
      priceListRowId: hire.price?.priceListRowId ?? null,
      blockReason: hire.blockReason,
      routeId: null,
      pickupId: null,
      ticketId: null,
      reversesEventId: null,
      subscriptionId: hire.subscriptionId,
      sourceEventId: null,
      createdBy: null,
      overrideReason: null,
    }
    const issue = billableEventShapeIssue(composed)
    if (issue !== undefined) throw new Error(`hire charge: ${issue}`)
    return {
      id: newId(),
      companyId: scope.companyId,
      projectId: scope.projectId,
      ...composed,
      serviceDate: hire.serviceDate,
      chargePeriodFrom: hire.period.from,
      chargePeriodTo: hire.period.to,
      chargedDays: hire.chargedDays,
      periodDays: hire.periodDays,
      containerId: hire.containerId,
      placementId: hire.placementId,
    }
  })
  let written = 0
  // A statement's parameters are bounded (65 535), and a row binds some thirty.
  for (let at = 0; at < rows.length; at += MINT_CHUNK) written += (await tx.insert(billableEvent).values(rows.slice(at, at + MINT_CHUNK)).onConflictDoNothing().returning({ id: billableEvent.id })).length
  return written
}

/** The hires one insert writes. */
const MINT_CHUNK = 1000
