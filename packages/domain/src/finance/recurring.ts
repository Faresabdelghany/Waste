// Recurring charges (#291 slice 2, #292 C2): a subscription whose product is
// sold by the month is charged in advance, prorated by day, by its
// agreement's billing cadence (the owner's decision on #291). Pure arithmetic
// over `YYYY-MM-DD` days, so the billing run (packages/db commands) and its
// preview mint and plan the same charges.
//
// A cadence's charge periods are calendar periods, half-open: a month, a
// quarter from January, April, July or October, a year; `manual` has none,
// its agreements charged by the office's own events. A billing run over a
// period charges every charge period that overlaps the period or the day
// after it: the next one in advance, since the run's window touches its first
// day, and one inside the run's period that was never charged — a
// subscription that began after its period's own run — in arrears. Nothing
// older is ever charged, so the first run after this ships bills its month and
// the next, never a backlog.
//
// A period's charged days are its days inside every period in force — the
// subscription's and its agreement's — and outside every pause of the
// subscription. Its unit price is the month's price times the period's months,
// prorated by those days over the period's, rounded half away from zero
// (money.ts): per unit, so a charge's net stays its unit price times its
// quantity, and a quantity above one differs from rounding the whole by at
// most an øre per unit. The months and the days are read off the period
// itself, never the cadence, so a charge priced again (`reprice`) is priced as
// it was minted whatever its agreement's cadence has become since.
import type { BillingCadence, ProductUnit } from "../registry/vocabulary"
import { addDays } from "../route-schemes/recurrence"
import type { BillingPeriod } from "./periods"
import { fitsMinor, roundHalfAwayFromZero, vatOf } from "./money"
import type { PricedAmounts } from "./pricing"

/** The unit a recurring product is sold in. */
export const RECURRING_UNIT: ProductUnit = "month"

/** A charge period: the first day charged, and the first day of the next period. */
export type ChargePeriod = { from: string; to: string }

/** A period in force, half-open: `validTo` the first day out, null while it runs. */
export type InForce = { validFrom: string; validTo: string | null }

/** The months a cadence's period holds. */
const MONTHS: Readonly<Record<Exclude<BillingCadence, "manual">, number>> = { monthly: 1, quarterly: 3, annual: 12 }

const firstOf = (year: number, month: number): string => new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10)

/** The charge period a day falls in, for a cadence that has periods. */
export function chargePeriodContaining(cadence: Exclude<BillingCadence, "manual">, day: string): ChargePeriod {
  const [year, month] = day.split("-").map(Number)
  const months = MONTHS[cadence]
  const startMonth = Math.floor((month - 1) / months) * months + 1
  return { from: firstOf(year, startMonth), to: firstOf(year, startMonth + months) }
}

/** The charge periods a billing run over `period` charges: those overlapping it or the day after it, oldest first; none for `manual`. */
export function chargePeriodsOfRun(cadence: BillingCadence, period: BillingPeriod): ChargePeriod[] {
  if (cadence === "manual") return []
  const windowEnd = addDays(period.periodTo, 2)
  const periods: ChargePeriod[] = []
  for (let current = chargePeriodContaining(cadence, period.periodFrom); current.from < windowEnd; current = chargePeriodContaining(cadence, current.to)) periods.push(current)
  return periods
}

const covers = (inForce: InForce, day: string): boolean => inForce.validFrom <= day && (inForce.validTo === null || inForce.validTo > day)

/** A period's charged days: inside every period in force, outside every pause; the first of them, null where there is none. */
export function chargedDays(period: ChargePeriod, inForce: readonly InForce[], pauses: readonly InForce[]): { first: string | null; days: number; periodDays: number } {
  let first: string | null = null
  let days = 0
  let periodDays = 0
  for (let day = period.from; day < period.to; day = addDays(day, 1)) {
    periodDays += 1
    if (!inForce.every((span) => covers(span, day)) || pauses.some((pause) => covers(pause, day))) continue
    days += 1
    first ??= day
  }
  return { first, days, periodDays }
}

/** The calendar months a charge period holds: one, three or twelve. */
const monthsOf = (period: ChargePeriod): number => {
  const [fromYear, fromMonth] = period.from.split("-").map(Number)
  const [toYear, toMonth] = period.to.split("-").map(Number)
  return (toYear - fromYear) * 12 + (toMonth - fromMonth)
}

const DAY_MS = 86_400_000

/** The days a charge period holds. */
const daysOf = (period: ChargePeriod): number => (Date.parse(`${period.to}T00:00:00Z`) - Date.parse(`${period.from}T00:00:00Z`)) / DAY_MS

/** A recurring charge's unit price: the month's price times the period's months, prorated by the charged days over the period's, rounded half away from zero. */
export function proratedUnitPrice(monthlyMinor: number, period: ChargePeriod, days: number): number {
  return roundHalfAwayFromZero((monthlyMinor * monthsOf(period) * days) / daysOf(period))
}

/**
 * A recurring charge's price from its month's — one unit of the product,
 * priced as a pickup is, on the first day charged: its unit prorated, the net
 * that unit times the quantity, the VAT on the net, on the month's row and
 * currency; an amount past the integer columns is `amount-too-large`.
 */
export function priceCharge(month: PricedAmounts, quantity: number, period: ChargePeriod, days: number): { blockReason: null; price: PricedAmounts } | { blockReason: "amount-too-large"; price: null } {
  const unitPriceMinor = proratedUnitPrice(month.unitPriceMinor, period, days)
  const netMinor = unitPriceMinor * quantity
  const vatMinor = vatOf(netMinor, month.vatPercent)
  if (![unitPriceMinor, netMinor, vatMinor].every(fitsMinor)) return { blockReason: "amount-too-large", price: null }
  return { blockReason: null, price: { priceListRowId: month.priceListRowId, unitPriceMinor, netMinor, vatPercent: month.vatPercent, vatMinor, currency: month.currency } }
}
