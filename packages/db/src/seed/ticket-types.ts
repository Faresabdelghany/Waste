// The demo company's Ticket Types (#545 of #544): the default type per kind
// every company starts with (@waste/domain/resolution/ticket-types),
// company-wide. The migration gave them to every company it found, on ids of
// its own minting, so a kind whose default the company already holds is left
// as it stands rather than written again under the seed's id; the types are
// the tenant's once there — the office renames them and adds its own beside —
// so nothing is ever restored, and a run that finds them writes nothing.
import type { Tx } from "../client"
import { defaultTicketTypeRows } from "../commands/ticket-types"
import { ticketType } from "../schema/resolution"
import { counted, DEMO_COMPANY_ID } from "./ids"

const ROWS: readonly (typeof ticketType.$inferInsert)[] = defaultTicketTypeRows(DEMO_COMPANY_ID, counted("ticketType"))

/** Every default ticket type id the seed writes, by kind. */
export const TICKET_TYPE_IDS: Readonly<Record<string, string>> = Object.fromEntries(ROWS.map((row) => [row.kind, row.id as string]))

export const TICKET_TYPES_COUNTS = { ticketTypes: ROWS.length }
export type TicketTypesCounts = typeof TICKET_TYPES_COUNTS

/** Writes the default types the company lacks into an open transaction, and answers how many it wrote: none where it holds a default for every kind. */
export async function applyTicketTypes(tx: Tx): Promise<number> {
  const written = await tx.insert(ticketType).values([...ROWS]).onConflictDoNothing().returning({ id: ticketType.id })
  return written.length
}
