// What the Dashboard asks the API (#292, #291 slices 26, 27 and 29, #290
// O12): the four reports over a window of days and the caller's projects —
// `GET /reports/service` and `/reports/tickets` (Improve's Performance),
// `/reports/tonnage` (Improve's Analytics) and `/reports/revenue` (the
// invoices' own grant) — and the waste-data report over a filing's period,
// `/reports/waste-data` and its file (Improve's Compliance), and the fleet's
// emissions, `/reports/emissions` (M10 of #293). Read-only,
// outside the record store: a report is an answer to a question, never a
// module's rows. The contracts are types here; a runtime zod import would
// land in the Dashboard's bundle.
import type {
  ReportInterval,
  RevenueReport,
  ServiceReport,
  TicketReport,
  TonnageReport,
  WasteDataFileQuery,
  WasteDataReport,
} from "@waste/contracts/reports"

import type { EmissionsReport } from "@waste/contracts/emissions"

import { get, getFile, withQuery, type ApiClient, type ApiFile } from "./client"

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

/** The waste-data report's question: one project's or every one the caller works in, a filing's period of days both inclusive, no series. */
export type WasteDataQuery = { projectId?: string; from: string; to: string }

/** How the file separates its fields: commas, or semicolons for a spreadsheet under a Danish locale. */
export type FileSeparator = WasteDataFileQuery["separator"]

const periodQuery = (query: WasteDataQuery) => ({ projectId: query.projectId, from: query.from, to: query.to })

/** What one read of the waste-data report is told apart by. */
export const wasteDataKey = (query: WasteDataQuery): string => withQuery("/reports/waste-data", periodQuery(query))

/** A period's approved unloads by municipality, station and fraction, with the warnings to read before filing. */
export function wasteDataReport(client: ApiClient, query: WasteDataQuery): Promise<WasteDataReport> {
  return get<WasteDataReport>(client, wasteDataKey(query))
}

/** The same report as the API's file, its bytes as written (the byte-order mark kept) and the name it gives it. */
export function wasteDataFile(client: ApiClient, query: WasteDataQuery, separator: FileSeparator): Promise<ApiFile> {
  return getFile(client, withQuery("/reports/waste-data.csv", { ...periodQuery(query), separator }), "text/csv")
}

/** What was unloaded at the stations and weighed at the kerb. */
export function tonnageReport(client: ApiClient, window: ReportWindowQuery, filters: { wasteFractionId?: string; unloadingStationId?: string } = {}): Promise<TonnageReport> {
  return get<TonnageReport>(client, withQuery("/reports/tonnage", query(window, filters)))
}

/** The fleet's planned emissions over a window (M10 of #293): no series, so the window's interval is not asked with it — the query is strict. */
export const emissionsKey = (window: ReportWindowQuery): string => withQuery("/reports/emissions", { projectId: window.projectId, from: window.from, to: window.to })

export function emissionsReport(client: ApiClient, window: ReportWindowQuery): Promise<EmissionsReport> {
  return get<EmissionsReport>(client, emissionsKey(window))
}
