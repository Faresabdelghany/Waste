// Insight's closed list (#292, slice C26): how a report cuts its window of
// days into the intervals its series is counted over. A report reads rows
// that exist — pickups, routes, tickets — and stores nothing; what each count
// means is readings.ts, and how a window is cut is intervals.ts.
//
// Like every context's vocabulary, the contracts read the tuple into a
// `z.enum` (`ReportInterval`, @waste/contracts/reports), so the API's query
// and the web's period picker name the same three values.

/** How a report's series cuts its window: a day each, an ISO week (Monday to Sunday) each, a calendar month each. */
export const REPORT_INTERVALS = ["day", "week", "month"] as const

export type ReportInterval = (typeof REPORT_INTERVALS)[number]

/** Every list of this module by its name, for a test that walks them. */
export const INSIGHT_VOCABULARIES = {
  REPORT_INTERVALS,
} as const satisfies Record<string, readonly [string, ...string[]]>
