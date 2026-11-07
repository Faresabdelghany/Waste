// A Billing Run's period (#112, M14 of #293): its first and last day, both
// inclusive, the last on or after the first, and ended by the project's
// today, since a run is for a closed period — which only the server, holding
// the project's clock, can judge (`@waste/db/commands/billing-runs`).

/** What a period whose last day comes before its first is told. */
export const PERIOD_ORDERED = "periodTo is the last day of the period, so it comes on or after periodFrom"

/** Both days inclusive, so one day is a period; comparing two `YYYY-MM-DD` strings compares the days. */
export const periodOrdered = (period: { periodFrom: string; periodTo: string }): boolean => period.periodTo >= period.periodFrom

/** What a run or a preview whose period ends after its project's today is told. */
export const PERIOD_ENDS_BY_TODAY = "A run's period ends by today"
