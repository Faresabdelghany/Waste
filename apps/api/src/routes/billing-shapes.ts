// What the billing half of Finance & Contracting's route modules share
// (Issue #112): the office's scope every statement is bounded by — the
// tenant and `inProjects` — the family's 404s, and the reads that need a
// Principal, so routes/billable-events.ts, routes/billing-runs.ts and
// routes/invoices.ts each say only which route does what, the way
// routes/resolution-shapes.ts holds Resolution's shapes for its modules. The
// shapes themselves — the rows of `billable_event`, `billing_run`,
// `billing_run_exclusion`, `invoice` and `invoice_line` on the wire, the one
// statement a billable event is read through (`eventsFrom`) and its status
// as a `where` (`statusIs`) — moved to `@waste/db/commands/billing-shapes`
// with the commands the worker runs (part B), which read and answer the same
// rows with no request in hand; they are re-exported here so the routes read
// them from the path they always did.
import type { BillingRunDetail } from "@waste/contracts/billing"
import type { Tx } from "@waste/db/client"
import { eventsFrom, exclusionColumns, exclusionOf, invoiceColumns, runColumns, runOf, type EventReading, type InvoiceRow, type RunRow } from "@waste/db/commands/billing-shapes"
import { billableEvent, billingRun, billingRunExclusion, invoice } from "@waste/db/schema/finance"
import { and, asc, eq, type SQL } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { inProjects } from "../auth/projects"
import { problem } from "../problem"

export {
  creditNotesOf,
  eventColumns,
  eventOf,
  eventsFrom,
  exclusionColumns,
  exclusionOf,
  invoiceColumns,
  invoiceDetailOf,
  invoiceOf,
  labelOf,
  lineColumns,
  lineOf,
  linesOf,
  linksOf,
  runColumns,
  runOf,
  statusIs,
  statusOf,
  UNNAMED,
  type EventReading,
  type EventRow,
  type ExclusionRow,
  type InvoiceRow,
  type LineRow,
  type RunRow,
} from "@waste/db/commands/billing-shapes"

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

/** The run with the payers it excluded, in recording order, and the ids of the invoices it issued, in numbering order. */
export async function runDetailOf(tx: Tx, companyId: string, row: RunRow): Promise<BillingRunDetail> {
  const [exclusions, invoices] = await Promise.all([
    tx
      .select(exclusionColumns)
      .from(billingRunExclusion)
      .where(and(eq(billingRunExclusion.companyId, companyId), eq(billingRunExclusion.billingRunId, row.id)))
      .orderBy(asc(billingRunExclusion.id)),
    tx
      .select({ id: invoice.id })
      .from(invoice)
      .where(and(eq(invoice.companyId, companyId), eq(invoice.billingRunId, row.id)))
      .orderBy(asc(invoice.id)),
  ])
  return { ...runOf(row), exclusions: exclusions.map(exclusionOf), invoiceIds: invoices.map((found) => found.id) }
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
