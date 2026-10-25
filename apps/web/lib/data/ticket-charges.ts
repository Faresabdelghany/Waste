// A project's ticket charges on the web (#291 C3): the product each ticket
// kind's work is charged at when a completion names none, as Settings ›
// Commercial › Ticket charges reads and writes it (`GET`/`PUT
// /ticket-charges`), and the products the completion's own "Charged at"
// offers. A product sold by the month is never offered — a recurring charge
// is not a ticket's work, the reference's own rule (400) — and a retired one
// is offered by its status, since a status gates a new reference and the
// API's 409 says why (#79). The set goes out whole, by the server's ids, a
// kind left at None charged at nothing.
import type { TicketCharges, TicketChargesSet } from "@waste/contracts/tickets"
import { TICKET_KINDS, type TicketKind } from "@waste/domain/resolution/vocabulary"

import type { LocalRefusal } from "@/lib/api/records/adapter"
import type { BusinessFormOption } from "@/lib/data/business-form-types"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { NO_ONE } from "@/lib/data/properties"
import { tokenOptions } from "@/lib/data/tickets"

/** The units a billing run charges by their period — a recurring charge's month, a hire's day (M14 of #293): never a ticket's work. */
const CHARGED_BY_PERIOD: readonly string[] = ["month", "day"]

/** The products of the project a ticket's work may be charged at, by the products module's records: never one sold by the month or the day, a retired one by its status. */
export function ticketWorkProductOptions(products: readonly BusinessRecord[], projectId: string | undefined): BusinessFormOption[] {
  return products
    .filter((record) => (projectId === undefined || (record.projectIds ?? []).includes(projectId)) && !CHARGED_BY_PERIOD.includes(String(record.submittedValues?.priceUnit)))
    .map((record) => ({ value: record.id, label: record.status === "Active" ? record.name : `${record.name} · ${record.status}` }))
}

/** The ticket kinds as the charges pane lists them: every kind once, in the vocabulary's order, by its label. */
export const TICKET_KIND_ROWS: readonly { kind: TicketKind; label: string }[] = tokenOptions(TICKET_KINDS).map((option) => ({ kind: option.value as TicketKind, label: option.label }))

/** A kind's pick in the pane: the product's web id, or None. */
export type TicketChargePicks = Partial<Record<TicketKind, string>>

/** The set as picks by the store's web ids; a product the store has not loaded is kept by its server id. */
export function picksOf(charges: TicketCharges, webIdOf: (serverId: string) => string | undefined): TicketChargePicks {
  return Object.fromEntries(charges.charges.map((charge) => [charge.kind, webIdOf(charge.productId) ?? charge.productId]))
}

/** The body the pane sends: every kind picked at a product, by the server's ids, in the kinds' order; a kind at None is left out and charged at nothing. */
export function ticketChargesBody(projectId: string, picks: TicketChargePicks, serverIdOf: (webId: string) => string | undefined): TicketChargesSet | LocalRefusal {
  const charges: TicketChargesSet["charges"] = []
  for (const { kind } of TICKET_KIND_ROWS) {
    const pick = picks[kind]
    if (pick === undefined || pick === NO_ONE || pick === "") continue
    const productId = serverIdOf(pick)
    if (productId === undefined) return { path: kind, message: "Pick a product the API holds" }
    charges.push({ kind, productId })
  }
  return { projectId, charges }
}
