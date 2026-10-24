// What the Dashboard asks the API (#292, #291 slices 26 and 27, #290 O12):
// the four reports over a window of days and the caller's projects —
// `GET /reports/service` and `/reports/tickets` (Improve's Performance),
// `/reports/tonnage` (Improve's Analytics) and `/reports/revenue` (the
// invoices' own grant). Read-only, outside the record store: a report is an
// answer to a question, never a module's rows. The contracts are types here;
// a runtime zod import would land in the Dashboard's bundle.
import type {
  ReportInterval,
  RevenueReport,
  ServiceReport,
  TicketReport,
  TonnageReport,
} from "@waste/contracts/reports"

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

/** What one read of a report is told apart by: the report and every parameter it is asked with, so a filter added to a query is in its key too. */
export function reportKey(report: "service" | "tickets" | "revenue" | "tonnage", window: ReportWindowQuery, filters: Readonly<Record<string, string | undefined>> = {}): string {
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

/** What was invoiced, by currency. */
export function revenueReport(client: ApiClient, window: ReportWindowQuery): Promise<RevenueReport> {
  return get<RevenueReport>(client, withQuery("/reports/revenue", query(window)))
}

/** What was unloaded at the stations and weighed at the kerb. */
export function tonnageReport(client: ApiClient, window: ReportWindowQuery, filters: { wasteFractionId?: string; unloadingStationId?: string } = {}): Promise<TonnageReport> {
  return get<TonnageReport>(client, withQuery("/reports/tonnage", query(window, filters)))
}
