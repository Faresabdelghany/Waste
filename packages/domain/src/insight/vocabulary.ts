// Insight's closed lists (#292, slices C26 and O12; #291 slice 29; M13 of
// #293): how a report cuts its window of days into the intervals its series
// is counted over, what the waste-data report warns of beside its rows, and
// how the sustainability report weighed each stop and what it warns of. A report
// reads rows that exist — pickups, routes, tickets, invoices, unloads — and
// stores nothing; what each count means is readings.ts, how a window is cut
// is intervals.ts, and the waste-data report's file is waste-data.ts.
//
// Like every context's vocabulary, the contracts read the tuple into a
// `z.enum` (`ReportInterval`, @waste/contracts/reports), so the API's query
// and the web's period picker name the same three values.

/** How a report's series cuts its window: a day each, an ISO week (Monday to Sunday) each, a calendar month each. */
export const REPORT_INTERVALS = ["day", "week", "month"] as const

export type ReportInterval = (typeof REPORT_INTERVALS)[number]

/** What the waste-data report warns of: a fraction with no waste code to file it under, a project filed as a municipality that is not one, and unloads of the period nobody has reviewed, which it does not count. */
export const WASTE_DATA_WARNINGS = ["no-waste-code", "not-a-municipality", "not-reviewed"] as const

export type WasteDataWarningKind = (typeof WASTE_DATA_WARNINGS)[number]

/** How the sustainability report weighed a stop (M13 of #293), best first: its own weight, its share of its route's weighbridge kilograms by container volume, its container's volume by its fraction's density, or not at all — counted, never zero. */
export const WEIGHT_BASES = ["measured", "apportioned", "estimated", "unmeasured"] as const

export type WeightBasis = (typeof WEIGHT_BASES)[number]

/** What the sustainability report warns of: a fraction with no treatment, counted as not recycled, and a fraction with no emission factor in force, reported without CO₂e. */
export const SUSTAINABILITY_WARNINGS = ["no-treatment", "no-factor"] as const

export type SustainabilityWarningKind = (typeof SUSTAINABILITY_WARNINGS)[number]

/** Every list of this module by its name, for a test that walks them. */
export const INSIGHT_VOCABULARIES = {
  REPORT_INTERVALS,
  WASTE_DATA_WARNINGS,
  WEIGHT_BASES,
  SUSTAINABILITY_WARNINGS,
} as const satisfies Record<string, readonly [string, ...string[]]>
