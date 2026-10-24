// A project's ticket charges through the client (#291 C3): Settings ›
// Commercial › Ticket charges' read and the replacement of its set. The set
// is a project's configuration and no row of a workspace's table, so it is no
// switched module: the pane asks the client itself, as Run billing's preview
// does.
import type { TicketCharges, TicketChargesSet } from "@waste/contracts/tickets"

import { get, put, withQuery, type ApiClient } from "./client"

/** `GET /ticket-charges`: the product each ticket kind of the project is charged at, a kind at most once. */
export function readTicketCharges(client: ApiClient, projectId: string): Promise<TicketCharges> {
  return get<TicketCharges>(client, withQuery("/ticket-charges", { projectId }))
}

/** `PUT /ticket-charges`: the project's set replaced whole; answers it as it now stands. */
export function replaceTicketCharges(client: ApiClient, body: TicketChargesSet): Promise<TicketCharges> {
  return put<TicketCharges>(client, "/ticket-charges", body)
}
