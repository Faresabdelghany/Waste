// The recycling-centre visits' reads and the check-in through the client
// (#393, M4 of #293). The check-in, the sites and the addresses it picks from
// and the likely trades are no rows of a workspace's table, so they are no
// switched module: the attendant's page and the ledger's Likely trades ask
// the client themselves. The ledger's rows and Void are the adapter's
// (records/site-visits.ts).
import type { FrequentVisitors, SiteVisitCheckIn, SiteVisitCheckInAnswer, VisitAddress, VisitAddresses, VisitSite, VisitSites } from "@waste/contracts/site-visits"

import { create, get, withQuery, type ApiClient } from "./client"

/** `GET /site-visits/sites`: the project's active recycling centres, each with the fractions it takes by name. */
export function readVisitSites(client: ApiClient, projectId: string): Promise<VisitSite[]> {
  return get<VisitSites>(client, withQuery("/site-visits/sites", { projectId })).then((answer) => answer.items)
}

/** `GET /site-visits/addresses`: the project's Properties whose name or address holds `q`, at most twenty. */
export function searchVisitAddresses(client: ApiClient, projectId: string, q: string): Promise<VisitAddress[]> {
  return get<VisitAddresses>(client, withQuery("/site-visits/addresses", { projectId, q })).then((answer) => answer.items)
}

/** `POST /site-visits`: the attendant's check-in; answers the visit as recorded and, for an admitted one, what it costs. */
export function checkInVisit(client: ApiClient, body: SiteVisitCheckIn): Promise<SiteVisitCheckInAnswer> {
  return create<SiteVisitCheckInAnswer>(client, "/site-visits", body).then((answer) => answer.body)
}

/** `GET /site-visits/frequent`: the project's likely trades on a day, its today when absent. */
export function readFrequentVisitors(client: ApiClient, projectId: string, on?: string): Promise<FrequentVisitors> {
  return get<FrequentVisitors>(client, withQuery("/site-visits/frequent", { projectId, ...(on === undefined ? {} : { on }) }))
}
