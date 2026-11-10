// A project's ticket charges on the web (#291 C3): the product each ticket
// kind's or type's work is charged at when a completion names none, as
// Settings › Tickets › Charges reads and writes it (`GET`/`PUT
// /ticket-charges`), and the products the completion's own "Charged at"
// offers. A product sold by the month is never offered — a recurring charge
// is not a ticket's work, the reference's own rule (400) — and a retired one
// is offered by its status, since a status gates a new reference and the
// API's 409 says why (#79). The set goes out whole, by the server's ids, a
// kind left at None charged at nothing. Since #548 of #544 each ticket type
// listed has a row of its own beneath the kinds, its own product winning over
// its kind's, and a type left at "As its kind" charged at its kind's.
import type { TicketCharges, TicketChargesSet } from "@waste/contracts/tickets"
import { TICKET_KINDS, type TicketKind } from "@waste/domain/resolution/vocabulary"

import type { LocalRefusal } from "@/lib/records/fields"
import type { BusinessFormOption } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { NO_ONE } from "@/lib/data/properties"
import { scopeKey, typeLabel, typesListed, type TicketScope, type TypeChoices } from "@/lib/data/ticket-scope"
import { tokenOptions } from "@/lib/data/tickets"

/** The units a billing run charges by their period — a recurring charge's month, a hire's day (M14 of #293): never a ticket's work. */
const CHARGED_BY_PERIOD: readonly string[] = ["month", "day"]

export function ticketWorkProductOptions(products: readonly BusinessRecord[], projectId: string | undefined): BusinessFormOption[] {
  return products
    .filter((record) => (projectId === undefined || (record.projectIds ?? []).includes(projectId)) && !CHARGED_BY_PERIOD.includes(String(record.submittedValues?.priceUnit)))
    .map((record) => ({ value: record.id, label: record.status === "Active" ? record.name : `${record.name} · ${record.status}` }))
}

export const TICKET_KIND_ROWS: readonly { kind: TicketKind; label: string }[] = tokenOptions(TICKET_KINDS).map((option) => ({ kind: option.value as TicketKind, label: option.label }))

/** One row of the pane: a kind or a type (#548 of #544), by its key and its label. */
export type TicketChargeRow = TicketScope & { key: string; label: string }

export const typesPicked = (picks: TicketChargePicks): string[] => Object.keys(picks).flatMap((key) => (key.startsWith("type:") ? [key.slice("type:".length)] : []))

export function chargeRowsOf(types: TypeChoices, named: Iterable<string> = []): TicketChargeRow[] {
  const kinds = TICKET_KIND_ROWS.map(({ kind, label }) => ({ kind, ticketTypeId: null, key: scopeKey({ kind, ticketTypeId: null }), label }))
  return [...kinds, ...typesListed(types, named).map((type) => ({ kind: null, ticketTypeId: type.id, key: scopeKey({ kind: null, ticketTypeId: type.id }), label: typeLabel(type) }))]
}

/** A row's pick in the pane, by the row's key: the product's web id, or None — for a type, its kind's. */
export type TicketChargePicks = Partial<Record<string, string>>

/** The set as picks by the store's web ids; a product the store has not loaded is kept by its server id. */
export function picksOf(charges: TicketCharges, webIdOf: (serverId: string) => string | undefined): TicketChargePicks {
  return Object.fromEntries(charges.charges.map((charge) => [scopeKey(charge), webIdOf(charge.productId) ?? charge.productId]))
}

/** The body the pane sends: every row picked at a product, by the server's ids, in the rows' order; a kind at None is left out and charged at nothing, a type at its kind's. */
export function ticketChargesBody(projectId: string, picks: TicketChargePicks, serverIdOf: (webId: string) => string | undefined, rows: readonly TicketChargeRow[] = chargeRowsOf([])): TicketChargesSet | LocalRefusal {
  const charges: TicketChargesSet["charges"] = []
  for (const row of rows) {
    const pick = picks[row.key]
    if (pick === undefined || pick === NO_ONE || pick === "") continue
    const productId = serverIdOf(pick)
    if (productId === undefined) return { path: row.key, message: "Pick a product the API holds" }
    charges.push({ kind: row.kind, ticketTypeId: row.ticketTypeId, productId })
  }
  return { projectId, charges }
}
