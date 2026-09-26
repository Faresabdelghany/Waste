// The invoice-issuing statements, once (Issue #112 §3; lifted here from
// `apps/api/src/routes/invoice-writes.ts` with the commands the worker runs,
// part B): the one function that writes an `invoice` row with its lines and
// publishes it. The billing run (billing-runs.ts) issues one per payer and
// currency — from the office's request or the worker's schedule — and the
// credit note command (`apps/api/src/routes/invoices.ts`) one per correction,
// and both go through `issueInvoice`, so a document is numbered, written and
// published one way whichever door made it — the `appendEvent` rule (#101):
// every invoice written is followed by its `invoice-issued` in the same
// transaction, so the outbox is complete by construction.
//
// The number is `nextNumber` (shared.ts), the ticket's statement over the
// company's other counter: one `update … returning` under the company's row
// lock, one document at a time — a run of a thousand invoices numbers them in
// one transaction, the lock held for the rest of it, and a run that fails
// rolls its numbers back with its rows, so the company's series is unbroken.
// A credit note takes its number from the same series (§7.13): one series,
// two prefixes, the contracts' `invoiceLabel`.
//
// Every line's shape is checked before the insert (`invoiceLineShapeIssue`):
// the server composes every line itself — from an event, or from the line it
// credits — so a line that disagrees with its source or its amounts is a bug
// in a route or a job and thrown as one, never left for the table's checks to
// answer as a 500. The one constraint a door foresees is the partial unique
// index behind the run's selection, an event on one line of one invoice: two
// runs racing over one event is what the project's lock prevents, and the
// refusal here is its backstop — a `Refused` 409 the API's error handler
// answers as such.
import type { InvoiceDetail } from "@waste/contracts/invoices"
import { vatOf } from "@waste/domain/finance/money"
import type { CreditReason, InvoiceKind } from "@waste/domain/finance/vocabulary"

import type { Tx } from "../client"
import type { IdMinter } from "../ids"
import { invoice, invoiceLine } from "../schema/finance"
import { invoiceColumns, invoiceOf, lineColumns, lineOf } from "./billing-shapes"
import { emit } from "./outbox"
import { nextNumber, refuseDuplicate } from "./shared"

/** `invoice_line_billable_event_id_idx`: an event is on one line of one invoice, the database's word behind the run's selection. */
export const EVENT_ON_ONE_LINE = "invoice_line_billable_event_id_idx"

/** What a run whose selection another run invoiced under it is told: the backstop behind the project's lock. */
export const INVOICED_BY_ANOTHER_RUN = "An event in the selection was invoiced by another run; run again"

/** The document as a door composes it: everything but the number, the totals, the id and the stamp, which are the write's. */
export type InvoiceDraft = {
  projectId: string
  kind: InvoiceKind
  /** The payer. */
  customerId: string
  currency: string
  issuedOn: string
  dueOn: string
  /** The run's period on an invoice; null on a credit note. */
  periodFrom: string | null
  periodTo: string | null
  billingRunId: string | null
  creditsInvoiceId: string | null
  creditReason: CreditReason | null
  creditNote: string | null
  /** The caller; null for the worker's run. */
  issuedBy: string | null
}

/** One line as a door composes it: its source, its frozen text, and its amounts; the position is its place in the list. */
export type LineDraft = {
  billableEventId: string | null
  creditsLineId: string | null
  description: string
  productId: string | null
  serviceDate: string | null
  quantity: number
  unitPriceMinor: number
  netMinor: number
  vatPercent: number
  vatMinor: number
}

/**
 * The table's shape rules over a composed line, each named for the check it
 * spells, or undefined where the line holds: one source and not two or none;
 * the net's magnitude the unit price times the quantity, a credit line never
 * positive; the VAT the domain's `vatOf`; a quantity of one or more.
 */
export function invoiceLineShapeIssue(line: LineDraft): string | undefined {
  if ((line.billableEventId !== null) === (line.creditsLineId !== null)) return "a line charges for one billable event or credits one line (invoice_line_source_exactly_one)"
  if (!Number.isInteger(line.quantity) || line.quantity < 1) return "a line's quantity is a whole number of one or more (invoice_line_quantity_positive)"
  if (Math.abs(line.netMinor) !== line.unitPriceMinor * line.quantity) return "the net's magnitude is the unit price times the quantity (invoice_line_amounts_shape)"
  if (line.creditsLineId !== null && line.netMinor > 0) return "a credit line is never positive (invoice_line_amounts_shape)"
  if (line.vatMinor !== vatOf(line.netMinor, line.vatPercent)) return "the VAT is round(net × rate / 100), half away from zero (invoice_line_vat_shape)"
  return undefined
}

export type IssueInvoiceInput = {
  companyId: string
  draft: InvoiceDraft
  /** In position order, one or more. */
  lines: readonly LineDraft[]
  /** Mints the document's and the lines' ids: the API's process minter, or the worker's. */
  newId: IdMinter
  /** The instant the document is issued: the `invoice-issued` event's `occurredAt`. */
  now: () => Date
}

/**
 * Issues one document: the lines' shapes checked, the number taken, the row
 * written with its totals summed from the lines, the lines written 1..n in
 * the order given, the `invoice-issued` event emitted with the detail as the
 * read answers it — in the caller's transaction, so a refusal anywhere leaves
 * nothing behind, the counter's step included. Answers that detail, which is
 * what the route answers too.
 */
export async function issueInvoice(tx: Tx, input: IssueInvoiceInput): Promise<InvoiceDetail> {
  const { companyId, draft, lines } = input
  if (lines.length === 0) throw new Error("issueInvoice: a document has at least one line")
  for (const [index, line] of lines.entries()) {
    const issue = invoiceLineShapeIssue(line)
    if (issue !== undefined) throw new Error(`invoice line ${index + 1}: ${issue}`)
  }
  const netMinor = lines.reduce((sum, line) => sum + line.netMinor, 0)
  const vatMinor = lines.reduce((sum, line) => sum + line.vatMinor, 0)
  const number = await nextNumber(tx, companyId, "nextInvoiceNumber")
  const [row] = await tx
    .insert(invoice)
    .values({ id: input.newId(), companyId, ...draft, number, netMinor, vatMinor, grossMinor: netMinor + vatMinor })
    .returning(invoiceColumns)
  const written = await refuseDuplicate({ [EVENT_ON_ONE_LINE]: INVOICED_BY_ANOTHER_RUN }, () =>
    tx
      .insert(invoiceLine)
      .values(lines.map((line, index) => ({ id: input.newId(), companyId, projectId: draft.projectId, invoiceId: row.id, position: index + 1, ...line })))
      .returning(lineColumns),
  )
  const detail: InvoiceDetail = { ...invoiceOf(row), lines: written.sort((a, b) => a.position - b.position).map(lineOf), creditNotes: [] }
  await emit(tx, { companyId }, { aggregate: "invoice", aggregateId: row.id, kind: "invoice-issued", payload: detail, projectId: draft.projectId, occurredAt: input.now() })
  return detail
}
