// The Invoice as the office reads and corrects it (Issue #112 §3, §5;
// ADR-0003): "an issued customer financial document" (CONTEXT.md). `GET
// /invoices` lists the documents, `GET /invoices/:id` reads one with its
// lines by position and the credit notes naming it, and `POST
// /invoices/:id/credit-notes` issues a credit note against it. No patch and
// no delete: "invoice number and original issued content are immutable", the
// row is a ledger's, and a correction is a credit note — itself an Invoice,
// of `kind = credit-note`, from the same series under its own prefix.
//
// A credit is by quantity, never by amount (§7.25): full — `lines: "all"`,
// every line by what remains of it — or partial, the named lines by the
// named quantities, each held to a line of this invoice (400 at
// `lines.N.lineId`) and to what remains of it after the credit notes already
// issued (400 at `lines.N.quantity`, `Only 2 of 5 remain to credit on line
// 3`). Each credit line copies the original's text, product, service date,
// unit price and rate, its quantity the credited one, its net and VAT
// negative, `creditsLineId` the original. A reversal's line — negative, the
// consumer's correction of an invoiced pickup — already gives the charge
// back and is not credited: `"all"` leaves it out and a body naming it is
// refused, since crediting a negative line would credit the customer twice.
// The invoice's own state is judged first: a credit note is not credited
// (409), and an invoice with nothing left to credit is 409 naming it. The
// events behind the credited lines stay `invoiced`: a credit corrects the
// document, not the occurrence, and what should have been charged instead is
// a new event. The credit note takes the next number of the company's
// series, `issuedOn` today on the project's clock, `dueOn` the same day, and
// `invoice-issued` is emitted with it (routes/invoice-writes.ts).
//
// The rule "at most what remains" is the API's, so it is held under a row
// lock and read afterwards (routes/shared.ts). The invoice itself is a ledger
// row the API role may not lock: `appendOnly` revokes UPDATE from it, and
// `SELECT … FOR UPDATE` needs UPDATE on the table. So the command takes the
// lock of the invoice's parent, the billing run that issued it (a
// `timestamps` row), and reads the lines and the quantities already credited
// underneath it — coarser than the invoice, since a run's invoices then
// credit one at a time, which a correction can bear; the invoice row itself
// never changes, so reading it before the lock is safe, and the run's id is
// what the lock is taken on.
//
// Every statement carries the tenant and `inProjects`; the grant is
// `commercial.invoices`, `view` to read, `create` to issue a credit note.
import { CreditNoteCreate, Invoice, InvoiceDetail, InvoiceListQuery } from "@waste/contracts/invoices"
import { Page } from "@waste/contracts/pagination"
import type { ProblemFieldError } from "@waste/contracts/problem"
import type { Tx } from "@waste/db/client"
import { billingRun, invoice, invoiceLine } from "@waste/db/schema/finance"
import { vatOf } from "@waste/domain/finance/money"
import { and, asc, eq, gt, gte, inArray, lte, sum } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { findInvoice, invoiceColumns, invoiceDetailOf, invoiceOf, invoiceScope, labelOf, linesOf, noSuchInvoice, type LineRow } from "./billing-shapes"
import { projectToday } from "./fleet-lookups"
import { issueInvoice, type LineDraft } from "./invoice-writes"
import { requireCustomer } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow } from "./shared"

const MODULE = "commercial.invoices"

const InvoicePage = Page(Invoice)

/** What a credit note against a credit note is told. */
export const CREDIT_NOTE_NOT_CREDITED = "A credit note is not credited; issue a new one against the invoice"

/** What a credit note against an invoice with nothing left to credit is told. */
export const fullyCredited = (label: string): string => `Invoice ${label} is fully credited`

/** What a body naming a line that is not this invoice's is told, at `lines.N.lineId`. */
export const NOT_A_LINE = "Not a line of this invoice"

/** What a body naming a reversal's line is told, at `lines.N.lineId`: a negative line gives the charge back already. */
export const REVERSAL_LINE_NOT_CREDITED = "A reversal's line is not credited; it already gives the charge back"

/** What a body crediting more of a line than remains is told, at `lines.N.quantity`. */
export const onlyRemain = (remaining: number, quantity: number, position: number): string => `Only ${remaining} of ${quantity} remain to credit on line ${position}`

/** A line of the invoice with what remains of it to credit. */
type Creditable = { line: LineRow; remaining: number }

/**
 * The quantity already credited of each line, by line: the credit lines of
 * every credit note naming this invoice's lines, summed. One statement; a
 * line nothing credited yet is not in the answer.
 */
async function creditedOf(tx: Tx, companyId: string, lines: readonly LineRow[]): Promise<Map<string, number>> {
  if (lines.length === 0) return new Map()
  const rows = await tx
    .select({ creditsLineId: invoiceLine.creditsLineId, credited: sum(invoiceLine.quantity) })
    .from(invoiceLine)
    .where(
      and(
        eq(invoiceLine.companyId, companyId),
        inArray(
          invoiceLine.creditsLineId,
          lines.map((line) => line.id),
        ),
      ),
    )
    .groupBy(invoiceLine.creditsLineId)
  return new Map(rows.map((row) => [row.creditsLineId ?? "", Number(row.credited ?? 0)]))
}

/** The credit line of one original by a quantity: the original's text, product, day, unit price and rate, the amounts negative. */
function creditLine(original: LineRow, quantity: number): LineDraft {
  const netMinor = -(original.unitPriceMinor * quantity)
  return {
    billableEventId: null,
    creditsLineId: original.id,
    description: original.description,
    productId: original.productId,
    serviceDate: original.serviceDate,
    quantity,
    unitPriceMinor: original.unitPriceMinor,
    netMinor,
    vatPercent: original.vatPercent,
    vatMinor: vatOf(netMinor, original.vatPercent),
  }
}

/**
 * The lines a credit note credits, by position: for `"all"`, every
 * creditable line with something left, by what remains; for a list, the
 * named lines by the named quantities, every refusal listed in one 400 — a
 * line that is not this invoice's, a reversal's line, a quantity above what
 * remains — so a client mending one is not told about the next on its next
 * try. A list naming nothing creditable (every line exhausted) is refused
 * line by line, since the caller chose the lines.
 */
function creditedLines(creditable: readonly Creditable[], body: CreditNoteCreate["lines"]): LineDraft[] {
  if (body === "all") return creditable.filter(({ remaining }) => remaining > 0).map(({ line, remaining }) => creditLine(line, remaining))
  const byId = new Map(creditable.map((entry) => [entry.line.id, entry]))
  const errors: ProblemFieldError[] = []
  const drafts: { position: number; draft: LineDraft }[] = []
  for (const [index, entry] of body.entries()) {
    const found = byId.get(entry.lineId)
    if (found === undefined) {
      errors.push({ path: `lines.${index}.lineId`, message: NOT_A_LINE })
      continue
    }
    if (found.line.netMinor < 0) {
      errors.push({ path: `lines.${index}.lineId`, message: REVERSAL_LINE_NOT_CREDITED })
      continue
    }
    if (entry.quantity > found.remaining) {
      errors.push({ path: `lines.${index}.quantity`, message: onlyRemain(found.remaining, found.line.quantity, found.line.position) })
      continue
    }
    drafts.push({ position: found.line.position, draft: creditLine(found.line, entry.quantity) })
  }
  if (errors.length > 0) throw invalidRequest("body", errors)
  return drafts.sort((a, b) => a.position - b.position).map(({ draft }) => draft)
}

const problems = (action: "view" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
  404: describeProblem("No invoice with that id in the projects this account works in."),
})

export function invoiceRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/invoices",
      describeRoute({
        operationId: "listInvoices",
        summary: "The invoices and credit notes of the caller's projects",
        description:
          "One page of documents, oldest first (ids are time-ordered, so a cursor over them is a cursor over numbering order), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `kind` is `invoice` or `credit-note`; `customerId` one payer's documents, held to a customer of this company (400 on the query); `billingRunId` the invoices one run issued; `creditsInvoiceId` the credit notes naming one invoice; `from` and `to` a window over `issuedOn`, both inclusive (`to` on or after `from`). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of documents.", InvoicePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, `projectId` is not a project this account works in, or `customerId` is not a customer of this company."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", InvoiceListQuery),
      async (c) => {
        const { limit, cursor, projectId, kind, customerId, billingRunId, creditsInvoiceId, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        if (customerId !== undefined) await requireCustomer(tx, principal.companyId, customerId, "customerId", "query")
        const rows = await tx
          .select(invoiceColumns)
          .from(invoice)
          .where(
            and(
              invoiceScope(principal),
              projectId === undefined ? undefined : eq(invoice.projectId, projectId),
              kind === undefined ? undefined : eq(invoice.kind, kind),
              customerId === undefined ? undefined : eq(invoice.customerId, customerId),
              billingRunId === undefined ? undefined : eq(invoice.billingRunId, billingRunId),
              creditsInvoiceId === undefined ? undefined : eq(invoice.creditsInvoiceId, creditsInvoiceId),
              from === undefined ? undefined : gte(invoice.issuedOn, from),
              to === undefined ? undefined : lte(invoice.issuedOn, to),
              after === undefined ? undefined : gt(invoice.id, after),
            ),
          )
          .orderBy(asc(invoice.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(invoiceOf), limit))
      },
    )
    .get(
      "/invoices/:id",
      describeRoute({
        operationId: "getInvoice",
        summary: "One document with its lines and the credit notes naming it",
        description:
          "One invoice or credit note of a project the caller works in, as issued and never changed: the document, its lines by position — each charging for one billable event or crediting one line of the invoice it corrects, with the frozen text and the amounts as issued — and the credit notes that credit it, in numbering order (none on a credit note). A document of another company, or of a project this account does not work in, is a document that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The document, its lines and its credit notes.", InvoiceDetail),
          400: describeProblem("The path does not hold an id."),
          ...problems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findInvoice(tx, principal, id)
        if (row === undefined) throw noSuchInvoice(id)
        return c.json(await invoiceDetailOf(tx, principal.companyId, row))
      },
    )
    .post(
      "/invoices/:id/credit-notes",
      describeRoute({
        operationId: "createCreditNote",
        summary: "Issue a credit note against an invoice",
        description:
          "Issues an Invoice of `kind = credit-note` against an invoice of `kind = invoice` — a credit note is not credited (409, `A credit note is not credited; issue a new one against the invoice`) — with a `reason` and a `note`. Full, `lines: \"all\"`, credits every line by what remains of it after the credit notes already issued; partial, `lines: [{ lineId, quantity }]`, credits the named lines by the named quantities, each a line of this invoice (400 at `lines.N.lineId`, `Not a line of this invoice`), each once, and each at most what remains of it (400 at `lines.N.quantity`, `Only 2 of 5 remain to credit on line 3`); every refusal is listed in one 400. A reversal's line — negative, the consumer's correction of an invoiced pickup — already gives the charge back and is not credited: `\"all\"` leaves it out and a body naming it is refused (400 at `lines.N.lineId`). An invoice with nothing left to credit is refused (409, `Invoice INV-26007188 is fully credited`). Each credit line copies the original's text, product, service date, unit price and VAT rate, its `quantity` the credited one, its `netMinor` and `vatMinor` negative, `creditsLineId` the original; the lines follow the originals' positions. The credit note takes the next number of the company's series (`CN-<n>`), `issuedOn` today on the project's clock, `dueOn` the same day, its totals the lines' sums, zero or negative; `invoice-issued` is emitted with it in the same transaction, carrying the credit note with its lines as `GET /invoices/{id}` answers it. The events behind the credited lines stay `invoiced`: a credit corrects the document, not the occurrence, and what should have been charged instead is a new event. Under the row lock of the run that issued the invoice, since an invoice is a ledger row the API role may not lock; the quantities already credited are read underneath it, so two credit notes against one invoice take turns.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The credit note as issued, with its lines; read at `/invoices/{id}`.", InvoiceDetail),
          400: describeProblem("The path does not hold an id, or the body is missing the reason or the lines, names a member the server owns, names a line twice, names a line that is not this invoice's or is a reversal's, or credits more of a line than remains — each at the field that is wrong."),
          ...problems("create"),
          409: describeProblem("The document is a credit note, or the invoice is fully credited; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", CreditNoteCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const body: CreditNoteCreate = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        // The invoice row never changes, so it is read before the lock; what moves under it — the credit lines naming its lines — is read after.
        const current = await findInvoice(tx, principal, id)
        if (current === undefined) throw noSuchInvoice(id)
        if (current.kind !== "invoice" || current.billingRunId === null) throw problem(409, { detail: CREDIT_NOTE_NOT_CREDITED })
        await lockRow(tx, billingRun, { companyId: principal.companyId, id: current.billingRunId })
        const lines = await linesOf(tx, principal.companyId, current.id)
        const credited = await creditedOf(tx, principal.companyId, lines)
        // A reversal's line has nothing to credit: it is the credit.
        const creditable: Creditable[] = lines.map((line) => ({ line, remaining: line.netMinor < 0 ? 0 : line.quantity - (credited.get(line.id) ?? 0) }))
        if (creditable.every(({ remaining }) => remaining <= 0)) throw problem(409, { detail: fullyCredited(labelOf(current)) })
        const drafts = creditedLines(creditable, body.lines)
        const at = now()
        const today = await projectToday(tx, { companyId: principal.companyId, projectId: current.projectId }, () => at)()
        const issued = await issueInvoice(tx, {
          companyId: principal.companyId,
          draft: {
            projectId: current.projectId,
            kind: "credit-note",
            customerId: current.customerId,
            currency: current.currency,
            issuedOn: today,
            dueOn: today,
            periodFrom: null,
            periodTo: null,
            billingRunId: null,
            creditsInvoiceId: current.id,
            creditReason: body.reason,
            creditNote: body.note ?? null,
            issuedBy: principal.user.id,
          },
          lines: drafts,
          newId,
          now: () => at,
        })
        return created(c, "/invoices", issued)
      },
    )
}
