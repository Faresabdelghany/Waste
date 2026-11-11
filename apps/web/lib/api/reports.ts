// What the Dashboard asks the API (#292, #291 slices 26 and 27): the two
// reports over a window of days and the caller's projects —
// `GET /reports/service` and `/reports/tickets`, Improve's Performance.
// Read-only, outside the record store: a report is an answer to a question,
// never a module's rows. The contracts are types here; a runtime zod import
// would land in the Dashboard's bundle.
import type { ReportInterval, ServiceReport, TicketReport } from "@waste/contracts/reports"

import { get, withQuery, type ApiClient } from "./client"

/** The window every report takes: one project's or every one the caller works in, two days both inclusive, the series' interval. */
export type ReportWindowQuery = { projectId?: string; from: string; to: string; interval: ReportInterval }

const query = (window: ReportWindowQuery, extra: Readonly<Record<string, string | undefined>> = {}) => ({
  projectId: window.projectId,
  from: window.from,
  to: window.to,
  interval: window.interval,
  ...extra,
})

export function reportKey(report: "service" | "tickets", window: ReportWindowQuery, filters: Readonly<Record<string, string | undefined>> = {}): string {
  return withQuery(`/reports/${report}`, query(window, filters))
}

/** How the routes ran and the stops were served. */
export function serviceReport(client: ApiClient, window: ReportWindowQuery, filters: { wasteFractionId?: string; routeSchemeId?: string } = {}): Promise<ServiceReport> {
  return get<ServiceReport>(client, withQuery("/reports/service", query(window, filters)))
}

/** How the tickets were opened and closed, and which are open now. */
export function ticketReport(client: ApiClient, window: ReportWindowQuery): Promise<TicketReport> {
  return get<TicketReport>(client, withQuery("/reports/tickets", query(window)))
}
