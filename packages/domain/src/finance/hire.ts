// Container hire (M14 of #293): a subscription to a product sold by the day
// is charged for the days its containers stand on site, each placement's
// first free days not charged. Pure arithmetic over `YYYY-MM-DD` days, so the
// billing run (packages/db commands) and its preview mint and plan the same
// charges.
//
// A container's days on site are its placement's, half-open (ADR-0005): from
// the day it was delivered to the day it was taken back, the issue and the
// return of the stock ledger. They are charged in arrears by calendar month,
// one charge per placement and month: a month is due once it has ended, or
// once the placement has (a return mid-month closes its last month at once),
// both by the day after the run's period and by today — a run over a period
// still running charges no day still to come, since a month charged is never
// charged again, which the database's key on the placement and the month
// holds. A billing run charges the due months that overlap its period, as a
// recurring charge is charged for the periods its run overlaps: a month not
// yet due falls to the next run whose period overlaps it, and a month no
// run's period overlaps is never charged, so a project's runs are laid end to
// end. A subscription's pause does not stop a hire: the bin is still on site.
//
// The free days are the placement's first days, counted from its first day
// across the months, so a hire of fourteen free days delivered on the 25th
// spends seven in its first month and seven in its second. Each charge is
// priced as a pickup is, its charged days the quantity, so its net is the
// day's price times the days, rounded nowhere.
import type { ProductUnit } from "../registry/vocabulary"
import { addDays } from "../route-schemes/recurrence"
import type { BillingPeriod } from "./periods"
import { chargePeriodContaining, type ChargePeriod, type InForce } from "./recurring"

/** The unit a hire product is sold in. */
export const HIRE_UNIT: ProductUnit = "day"

/** The most free days a hire product may give: a year, which no hire runs past free. */
export const FREE_DAYS_MAX = 366

/** The calendar month a day falls in, half-open: a monthly cadence's charge period. */
export const monthOf = (day: string): ChargePeriod => chargePeriodContaining("monthly", day)

/** How many days a period holds. */
export const daysOf = (period: ChargePeriod): number => Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000)

/**
 * The months a billing run over `period` on `today` charges a placement for:
 * each month the placement stood on site in that overlaps the run's period
 * and is due — ended, or holding the placement's own end, by the day after
 * the period and by today — oldest first.
 */
export function hireMonthsDue(placement: InForce, period: BillingPeriod, today: string): ChargePeriod[] {
  const dayAfter = addDays(period.periodTo, 1)
  const dueBy = today < dayAfter ? today : dayAfter
  const months: ChargePeriod[] = []
  for (let month = monthOf(period.periodFrom); month.from <= period.periodTo; month = monthOf(month.to)) {
    const standing = placement.validFrom < month.to && (placement.validTo === null || placement.validTo > month.from)
    if (!standing) continue
    const ended = month.to <= dueBy
    const returned = placement.validTo !== null && placement.validTo <= month.to && placement.validTo <= dueBy
    if (ended || returned) months.push(month)
  }
  return months
}

/** A placement's days on site in a month: those it stood, the free ones among them (its first `freeDays` days overall), and the charged ones; `first` the first charged day, null where none is. */
export function hireDays(placement: InForce, month: ChargePeriod, freeDays: number): { onSite: number; free: number; charged: number; first: string | null } {
  const freeUntil = addDays(placement.validFrom, Math.max(0, freeDays))
  let onSite = 0
  let free = 0
  let first: string | null = null
  for (let day = month.from; day < month.to; day = addDays(day, 1)) {
    if (day < placement.validFrom || (placement.validTo !== null && day >= placement.validTo)) continue
    onSite += 1
    if (day < freeUntil) free += 1
    else first ??= day
  }
  return { onSite, free, charged: onSite - free, first }
}
