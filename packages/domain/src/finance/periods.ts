// The period a scheduled billing run bills (Issue #112 part B): the calendar
// month before the day the run happens on, on the project's clock. The
// worker's `finance.run-billing` fires on the first of each month and asks,
// per project, for the month that just ended — `2026-10-01` on the project's
// clock bills September, `periodFrom` its first day and `periodTo` its last,
// both inclusive as `BillingRunCreate` spells a period. Pure string
// arithmetic over a `YYYY-MM-DD` day, so the worker reads the day on the
// project's clock (`dayInTimezone`) and hands it here; a day that is not one
// is refused, since a month before "today" is not a question this module can
// answer.
//
// A run also catches up (#447): a ready event from before its period that no
// invoice line names — released from a hold, or repriced, after its own
// period's run — is taken by the next run, back to `catchUpFrom`, the day
// `BILLING_CATCH_UP_MONTHS` months before the period's first. Past that, an
// event waits for a run the office asks over its own period.
import { isIsoDate } from "../route-schemes/recurrence"

/** A billing period as the contracts spell one: both days inclusive. */
export type BillingPeriod = { periodFrom: string; periodTo: string }

/** The calendar month before the one `day` falls in: its first day and its last. */
export function monthBefore(day: string): BillingPeriod {
  if (!isIsoDate(day)) throw new Error(`monthBefore: "${day}" is not a YYYY-MM-DD day`)
  const [year, month] = day.split("-").map(Number)
  // The last day of the month before is the day before this month's first; Date's day 0 is that day.
  const last = new Date(Date.UTC(year, month - 1, 0))
  const first = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 1))
  return { periodFrom: first.toISOString().slice(0, 10), periodTo: last.toISOString().slice(0, 10) }
}

/** How far back a run reaches for the ready events earlier runs left (#447), in months before its first day. */
export const BILLING_CATCH_UP_MONTHS = 12

/** The first day a run over a period starting `periodFrom` catches up from: `BILLING_CATCH_UP_MONTHS` months before it, on the same day of the month or the month's last where it is shorter (29 February reaches back to 28 February). */
export function catchUpFrom(periodFrom: string): string {
  if (!isIsoDate(periodFrom)) throw new Error(`catchUpFrom: "${periodFrom}" is not a YYYY-MM-DD day`)
  const [year, month, day] = periodFrom.split("-").map(Number)
  const months = year * 12 + (month - 1) - BILLING_CATCH_UP_MONTHS
  const [toYear, toMonth] = [Math.floor(months / 12), (months % 12) + 1]
  // Date's day 0 of the month after is the month's last day.
  const last = new Date(Date.UTC(toYear, toMonth, 0)).getUTCDate()
  return `${String(toYear).padStart(4, "0")}-${String(toMonth).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`
}
