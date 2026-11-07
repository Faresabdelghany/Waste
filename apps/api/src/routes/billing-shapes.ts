// What the billing half of Finance & Contracting's route modules share
// (Issue #112) beside the rows on the wire, which are `@waste/db/shapes/`'
// (billable events, billing runs, invoices), since the commands the worker
// runs read and answer them too: the office's scope every statement is
// bounded by — the tenant and `inProjects` — the family's 404s, and the reads
// that need a Principal, so routes/billable-events.ts, routes/billing-runs.ts
// and routes/invoices.ts each say only which route does what.
import type { Tx } from "@waste/db/client"
import { billableEvent, billingRun, invoice } from "@waste/db/schema/finance"
import { and, eq, type SQL } from "drizzle-orm"
import { eventsFrom, type EventReading } from "@waste/db/shapes/billable-events"
import { runColumns, type RunRow } from "@waste/db/shapes/billing-runs"
import { invoiceColumns, type InvoiceRow } from "@waste/db/shapes/invoices"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { problem } from "../problem"

export const noSuchEvent = (id: string) => problem(404, { detail: `No billable event ${id} in the projects this account works in` })
export const noSuchRun = (id: string) => problem(404, { detail: `No billing run ${id} in the projects this account works in` })
export const noSuchInvoice = (id: string) => problem(404, { detail: `No invoice ${id} in the projects this account works in` })

/** The events of this company, in the projects the caller works in: what every billable event statement is bounded by. */
export const eventScope = (principal: Principal): SQL | undefined => and(eq(billableEvent.companyId, principal.companyId), inProjects(billableEvent.projectId, principal))

/** One billable event of this company by id, inside the caller's projects, with its reading; undefined when it is neither. */
export async function findEvent(tx: Tx, principal: Principal, id: string): Promise<EventReading | undefined> {
  const [row] = await eventsFrom(tx, principal.companyId)
    .query.where(and(eventScope(principal), eq(billableEvent.id, id)))
    .limit(1)
  return row
}

/** The runs of this company, in the projects the caller works in. */
export const runScope = (principal: Principal): SQL | undefined => and(eq(billingRun.companyId, principal.companyId), inProjects(billingRun.projectId, principal))

/** One run of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findRun(tx: Tx, principal: Principal, id: string): Promise<RunRow | undefined> {
  const [row] = await tx
    .select(runColumns)
    .from(billingRun)
    .where(and(runScope(principal), eq(billingRun.id, id)))
    .limit(1)
  return row
}

/** The documents of this company, in the projects the caller works in. */
export const invoiceScope = (principal: Principal): SQL | undefined => and(eq(invoice.companyId, principal.companyId), inProjects(invoice.projectId, principal))

/** One document of this company by id, inside the caller's projects; undefined when it is neither. */
export async function findInvoice(tx: Tx, principal: Principal, id: string): Promise<InvoiceRow | undefined> {
  const [row] = await tx
    .select(invoiceColumns)
    .from(invoice)
    .where(and(invoiceScope(principal), eq(invoice.id, id)))
    .limit(1)
  return row
}
