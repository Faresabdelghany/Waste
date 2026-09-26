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
