// What an invoice's document is made of (#291 slice 5, #292 C5), read once
// for the API's `GET /invoices/:id/document` and, with C6, the worker's
// e-mail: the document's own row, its lines by position, the parties frozen
// on it at issue, its project's language, and, on a credit note, the label of
// the invoice it corrects. Every value is the ledger's as issued — nothing is
// read from the company or the payer as they stand now — so the domain's
// model (@waste/domain/finance/invoice-document) and the renderer
// (@waste/documents) make the same file of it whenever they are asked.
import { documentLanguageOf, type InvoiceDocumentInput } from "@waste/domain/finance/invoice-document"
import type { CreditReason } from "@waste/domain/finance/vocabulary"
import { and, eq } from "drizzle-orm"

import type { Tx } from "../client"
import { invoice } from "../schema/finance"
import { project } from "../schema/organisation"
import { labelOf, linesOf, type InvoiceRow } from "./billing-shapes"

/** The rows one document is rendered from, under its company. */
export async function invoiceDocumentInputOf(tx: Tx, companyId: string, row: InvoiceRow): Promise<InvoiceDocumentInput> {
  const [lines, [frozen], [scope], credited] = await Promise.all([
    linesOf(tx, companyId, row.id),
    tx.select({ parties: invoice.parties }).from(invoice).where(and(eq(invoice.companyId, companyId), eq(invoice.id, row.id))),
    tx.select({ language: project.language }).from(project).where(and(eq(project.companyId, companyId), eq(project.id, row.projectId))),
    row.creditsInvoiceId === null
      ? Promise.resolve([])
      : tx.select({ kind: invoice.kind, number: invoice.number }).from(invoice).where(and(eq(invoice.companyId, companyId), eq(invoice.id, row.creditsInvoiceId))),
  ])
  if (frozen === undefined || scope === undefined) throw new Error(`invoiceDocumentInputOf: ${labelOf(row)} has no row or no project under company ${companyId}`)
  const [original] = credited
  return {
    kind: row.kind as InvoiceDocumentInput["kind"],
    label: labelOf(row),
    language: documentLanguageOf(scope.language),
    currency: row.currency,
    issuedOn: row.issuedOn,
    dueOn: row.dueOn,
    periodFrom: row.periodFrom,
    periodTo: row.periodTo,
    paymentReference: row.paymentReference,
    credits: original === undefined ? null : { label: labelOf(original), reason: row.creditReason as CreditReason | null, note: row.creditNote },
    netMinor: row.netMinor,
    vatMinor: row.vatMinor,
    grossMinor: row.grossMinor,
    lines: lines.map((line) => ({
      description: line.description,
      serviceDate: line.serviceDate,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      netMinor: line.netMinor,
      vatPercent: line.vatPercent,
      vatMinor: line.vatMinor,
    })),
    parties: frozen.parties,
  }
}
