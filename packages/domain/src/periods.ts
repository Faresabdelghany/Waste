// An effective-dated row's period, read the one way ADR-0005 fixes:
// half-open, `validFrom` the first day in force and `validTo` the first day
// out of it, null for open-ended. A person reads an end as the last day in
// force, the day before the wire's `validTo`; `lastDayIn` and `firstDayOut`
// convert between the two, and nothing else spells the day before or after.
import { addDays } from "./days"

export type Period = { validFrom: string; validTo: string | null }

/** Where a period stands on a day: not yet begun, in force, or ended. */
export type PeriodStanding = "upcoming" | "in-force" | "ended"

export function periodOn(period: Period, day: string): PeriodStanding {
  if (period.validFrom > day) return "upcoming"
  if (period.validTo !== null && period.validTo <= day) return "ended"
  return "in-force"
}

/** Whether the period holds the day: on or after its first day in, before its first day out. */
export const inForceOn = (period: Period, day: string): boolean => period.validFrom <= day && (period.validTo === null || day < period.validTo)

/** The last day in force of a period whose first day out is `validTo`. */
export const lastDayIn = (validTo: string): string => addDays(validTo, -1)

/** The first day out of a period whose last day in force is `lastDay`: the `validTo` the wire carries. */
export const firstDayOut = (lastDay: string): string => addDays(lastDay, 1)

/** Whether a period runs forward: its end absent, null or after its start. A half-seen period is not judged, which is what a patch gives. */
export function validityOrdered(value: { validFrom?: string | null; validTo?: string | null }): boolean {
  const { validFrom, validTo } = value
  if (validFrom == null || validTo == null) return true
  return validTo > validFrom
}

/**
 * What a backwards period is told, wherever it is caught: a body that holds
 * both bounds at the boundary, and a patch that holds one against the stored
 * row the other, in the route that has the row.
 */
export const ENDS_AFTER_IT_STARTS = "validTo is the first day out of force, so it comes after validFrom"
