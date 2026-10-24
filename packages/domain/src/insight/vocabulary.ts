// Insight's closed lists (#292, slices C26 and O12; #291 slice 29): how a
// report cuts its window of days into the intervals its series is counted
// over, and what the waste-data report warns of beside its rows. A report
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

/** Every list of this module by its name, for a test that walks them. */
export const INSIGHT_VOCABULARIES = {
  REPORT_INTERVALS,
  WASTE_DATA_WARNINGS,
} as const satisfies Record<string, readonly [string, ...string[]]>
