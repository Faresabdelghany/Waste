// Payments and reconciliation (#291 slice 6, #292 C6): money as it arrived
// and what it pays. `GET /payments` lists the payments with what each has
// allocated, `GET /payments/:id` reads one with its allocations, and `POST
// /payments` registers one by hand — paid at the counter, a transfer the
// office read off the bank's site — paying the invoice it names, what that
// invoice owes at most. `POST /payments/:id/allocations` is the office's
// match of a payment to an invoice, `POST /payment-allocations/:id/reverse`
// undoes a wrong one, and `POST /payments/bank-lines` takes a bank
// statement's lines a batch at a time, matching each by the invoice's frozen
// FIK reference or by the one label its text names (@waste/domain/finance/
// payments, `matchBankLine`). `GET /customers/:id/statement` runs a payer's
// invoices, credit notes and payments from an opening balance to a closing
// one.
//
// Both tables are ledgers. A payment is never rewritten and never deleted;
// what it pays is its allocations', and a wrong allocation is undone by a
// negative row naming it, once. Money a payment has not allocated is a credit
// on its payer's balance — refunds are not here. A payment's payer may be
// unknown, a bank line nobody's: it lands unmatched in the project the
// statement was imported into, and once the office matches it, its
// allocations put it on the payer's statement. A statement imported twice is
// one payment per line, by the line's key (`bankLineKey`), which the server
// computes from what the line says and how many identical lines came before
// it in the file; the partial unique index behind it answers a race.
//
// "Within what the payment has and what the invoice owes" is the API's rule,
// read under row locks and written after (routes/shared.ts): the project's
// row first, since a payment, its allocations and the invoice they pay are
// all one project's, then the run that issued the invoice, whose lock a
// credit note against it takes too (routes/invoices.ts), so a credit note and
// a payment against one invoice take turns. Never the company's row: issuing
// a credit note numbers it under the company's row after its run's, and the
// other order here would deadlock with it. A statement's lines take their
// projects' locks and their invoices' runs' in id order. A dry run reads and
// holds nothing.
//
// Every statement carries the tenant and `inProjects`; the grant is
// `commercial.payments`, `view` to read and `create` for every write, each of
// which appends. No outbox event yet: `payment-recorded` waits for its first
// consumer (C15). A payment's `reference` and `payer_text` are what the bank
// said about a person, kept and erased with the customer's data (#381).
import { INVOICE_NUMBER_PREFIX } from "@waste/contracts/finance"
import { Page } from "@waste/contracts/pagination"
import {
  AllocationCreate,
  BankLines,
  BankLinesResult,
  CustomerStatement,
  CustomerStatementQuery,
  Payment,
  PaymentCreate,
  PaymentDetail,
  PaymentListQuery,
  type BankLineResult,
  type PaymentAllocation,
  type PaymentSource,
} from "@waste/contracts/payments"
import type { ProblemFieldError } from "@waste/contracts/problem"
import type { Tx } from "@waste/db/client"
import { customer } from "@waste/db/schema/customers"
import { billingRun, invoice, payment, paymentAllocation } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import { bankLineKey, bankLineLabels, bankLineReference, matchBankLine, minorDigitsOf, type OpenInvoice } from "@waste/domain/finance/payments"
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql, sum, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { invoiceColumns, invoiceScope, labelOf, standingsOf, type InvoiceRow, type InvoiceStanding } from "./billing-shapes"
import { noSuchCustomer } from "./customer-writes"
import { projectToday } from "./fleet-lookups"
import { requireCustomer } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, lockRows, refuseDuplicate } from "./shared"

const MODULE = "commercial.payments"

const PaymentPage = Page(Payment)

/** What a body naming an invoice outside the payment's project is told, at `invoiceId`. */
export const NOT_AN_INVOICE_OF_THE_PROJECT = "Not an invoice of this project"

/** What a body naming a credit note as the document paid is told, at `invoiceId`. */
export const A_CREDIT_NOTE_IS_NOT_PAID = "A credit note is paid by nobody; name the invoice"

/** What a registration naming a payer other than its invoice's is told, at `customerId`. */
export const NOT_THE_PAYER = "Not the invoice's payer"

/** What a match of a payer's payment to another payer's invoice is told, at `invoiceId`. */
export const NOT_THE_PAYMENTS_PAYER = "Not an invoice of the payment's payer"

/** What a body paying an invoice in another currency is told. */
export const inCurrency = (whose: "invoice" | "payment", currency: string): string => `The ${whose} is in ${currency}`

/** What a reversal of a reversal is told. */
export const A_REVERSAL_IS_NOT_REVERSED = "A reversal is not reversed; allocate the payment again"

/** What a second reversal of one allocation is told. */
export const ALREADY_REVERSED = "This allocation is reversed already"

/** What a statement's line already imported into a project this account does not work in is told. */
export const IMPORTED_ELSEWHERE = "A line of this batch was imported already, into a project this account does not work in"

/** An amount as a sentence spells it: `300.00 DKK`, the currency's minor digits after the point. */
function amountText(minor: number, currency: string): string {
  const digits = minorDigitsOf(currency)
  return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`
}

/** What a match of more than the payment has left is told. */
export const remainsOnly = (minor: number, currency: string): string => `Only ${amountText(minor, currency)} of the payment remains to allocate`

/** What a match of more than the invoice owes is told. */
export const owesOnly = (label: string, minor: number, currency: string): string => `Invoice ${label} owes only ${amountText(minor, currency)}`

export const noSuchPayment = (id: string) => problem(404, { detail: `No payment ${id} in the projects this account works in` })
export const noSuchAllocation = (id: string) => problem(404, { detail: `No payment allocation ${id} in the projects this account works in` })

const paymentColumns = {
  id: payment.id,
  recordedAt: payment.recordedAt,
  projectId: payment.projectId,
  customerId: payment.customerId,
  amountMinor: payment.amountMinor,
  currency: payment.currency,
  paidOn: payment.paidOn,
  reference: payment.reference,
  payerText: payment.payerText,
  source: payment.source,
  note: payment.note,
  recordedBy: payment.recordedBy,
}

const allocationColumns = {
  id: paymentAllocation.id,
  recordedAt: paymentAllocation.recordedAt,
  projectId: paymentAllocation.projectId,
  paymentId: paymentAllocation.paymentId,
  invoiceId: paymentAllocation.invoiceId,
  amountMinor: paymentAllocation.amountMinor,
  reversesAllocationId: paymentAllocation.reversesAllocationId,
  recordedBy: paymentAllocation.recordedBy,
}

type AllocationRow = Pick<typeof paymentAllocation.$inferSelect, keyof typeof allocationColumns>

/** The payments of this company, in the projects the caller works in. */
const paymentScope = (principal: Principal): SQL | undefined => and(eq(payment.companyId, principal.companyId), inProjects(payment.projectId, principal))

/**
 * Every payment is read through here: its row and what its allocations
 * apply, reversals taken off, summed LATERAL — one probe of the allocations'
 * index per payment — so a page, a read and a command's answer say the same.
 */
function paymentsFrom(tx: Tx, companyId: string) {
  const allocated = tx
    .select({ allocatedMinor: sql<string>`coalesce(sum(${paymentAllocation.amountMinor}), 0)`.as("allocated_minor") })
    .from(paymentAllocation)
    .where(and(eq(paymentAllocation.companyId, companyId), eq(paymentAllocation.paymentId, payment.id)))
    .as("allocated")
  const query = tx.select({ ...paymentColumns, allocatedMinor: allocated.allocatedMinor }).from(payment).leftJoinLateral(allocated, sql`true`)
  return { query, allocated }
}

type PaymentRow = Awaited<ReturnType<typeof paymentsFrom>["query"]>[number]

function paymentOf(row: PaymentRow): Payment {
  const allocatedMinor = Number(row.allocatedMinor)
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    customerId: row.customerId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    paidOn: row.paidOn,
    reference: row.reference,
    payerText: row.payerText,
    source: row.source as PaymentSource,
    note: row.note,
    recordedBy: row.recordedBy,
    allocatedMinor,
    unallocatedMinor: row.amountMinor - allocatedMinor,
  }
}

const allocationOf = (row: AllocationRow): PaymentAllocation => ({
  id: row.id,
  recordedAt: row.recordedAt.toISOString(),
  paymentId: row.paymentId,
  invoiceId: row.invoiceId,
  amountMinor: row.amountMinor,
  reversesAllocationId: row.reversesAllocationId,
  recordedBy: row.recordedBy,
})

/** One payment of this company by id, inside the caller's projects; undefined when it is neither. */
async function findPayment(tx: Tx, principal: Principal, id: string): Promise<PaymentRow | undefined> {
  const [row] = await paymentsFrom(tx, principal.companyId)
    .query.where(and(paymentScope(principal), eq(payment.id, id)))
    .limit(1)
  return row
}

/** The payment with its allocations in recording order, read under the caller's scope: what every command answers. */
async function paymentDetail(tx: Tx, principal: Principal, id: string): Promise<PaymentDetail> {
  const row = await findPayment(tx, principal, id)
  if (row === undefined) throw new Error(`payment ${id} was written in this request and is not read back`)
  const allocations = await tx
    .select(allocationColumns)
    .from(paymentAllocation)
    .where(and(eq(paymentAllocation.companyId, principal.companyId), eq(paymentAllocation.paymentId, id)))
    .orderBy(asc(paymentAllocation.id))
  return { ...paymentOf(row), allocations: allocations.map(allocationOf) }
}

/** One document of the caller's projects that a payment may pay, by id: the invoice, or undefined. */
async function findDocument(tx: Tx, principal: Principal, id: string): Promise<InvoiceRow | undefined> {
  const [row] = await tx
    .select(invoiceColumns)
    .from(invoice)
    .where(and(invoiceScope(principal), eq(invoice.id, id)))
    .limit(1)
  return row
}

/** The rows a payment's rule hangs off, parents before children, each table's in id order: the projects', then the runs' that issued the invoices paid. */
async function lockForPayment(tx: Tx, companyId: string, projectIds: readonly string[], invoices: readonly InvoiceRow[]): Promise<void> {
  await lockRows(tx, project, companyId, [...new Set(projectIds)])
  await lockRows(tx, billingRun, companyId, [...new Set(invoices.flatMap((row) => (row.billingRunId === null ? [] : [row.billingRunId])))])
}

/** The rows of one allocation appended: positive applies part of a payment to an invoice of its project. */
type AllocationDraft = { paymentId: string; invoiceId: string; projectId: string; amountMinor: number }

async function appendAllocations(tx: Tx, principal: Principal, drafts: readonly AllocationDraft[]): Promise<void> {
  if (drafts.length === 0) return
  await tx.insert(paymentAllocation).values(drafts.map((draft) => ({ id: newId(), companyId: principal.companyId, ...draft, reversesAllocationId: null, recordedBy: principal.user.id })))
}

/** Where a payment's line falls on its payer's statement, on one day: invoices, then credit notes, then payments. */
const STATEMENT_ORDER = { invoice: 0, "credit-note": 1, payment: 2 } as const

type Entry = CustomerStatement["lines"][number]

/**
 * A payer's statement in one currency over a window of days: every document
 * and payment up to `to` read once, those before `from` folded into the
 * opening balance. An invoice raises the balance by its gross, a credit note
 * lowers it by its own (negative) gross, a payment naming the payer lowers it
 * by its amount, allocated or not, and a payment of nobody's by what its
 * allocations put on this payer's invoices.
 */
async function statementOf(tx: Tx, principal: Principal, customerId: string, query: CustomerStatementQuery): Promise<CustomerStatement> {
  const { companyId } = principal
  const [documents, own, applied] = await Promise.all([
    tx
      .select({ id: invoice.id, kind: invoice.kind, number: invoice.number, issuedOn: invoice.issuedOn, grossMinor: invoice.grossMinor })
      .from(invoice)
      .where(and(invoiceScope(principal), eq(invoice.customerId, customerId), eq(invoice.currency, query.currency), lte(invoice.issuedOn, query.to))),
    tx
      .select({ id: payment.id, paidOn: payment.paidOn, reference: payment.reference, amountMinor: payment.amountMinor })
      .from(payment)
      .where(and(paymentScope(principal), eq(payment.customerId, customerId), eq(payment.currency, query.currency), lte(payment.paidOn, query.to))),
    tx
      .select({ id: payment.id, paidOn: payment.paidOn, reference: payment.reference, amountMinor: sum(paymentAllocation.amountMinor).mapWith(Number) })
      .from(paymentAllocation)
      .innerJoin(payment, and(eq(payment.companyId, paymentAllocation.companyId), eq(payment.id, paymentAllocation.paymentId)))
      .innerJoin(invoice, and(eq(invoice.companyId, paymentAllocation.companyId), eq(invoice.id, paymentAllocation.invoiceId)))
      .where(
        and(
          eq(paymentAllocation.companyId, companyId),
          inProjects(paymentAllocation.projectId, principal),
          isNull(payment.customerId),
          eq(invoice.customerId, customerId),
          eq(payment.currency, query.currency),
          lte(payment.paidOn, query.to),
        ),
      )
      .groupBy(payment.id, payment.paidOn, payment.reference),
  ])
  const entries: Omit<Entry, "balanceMinor">[] = [
    ...documents.map((row) => ({ on: row.issuedOn, kind: row.kind as "invoice" | "credit-note", documentId: row.id, label: labelOf(row), amountMinor: row.grossMinor })),
    ...[...own, ...applied.filter((row) => row.amountMinor !== 0)].map((row) => ({ on: row.paidOn, kind: "payment" as const, documentId: row.id, label: row.reference, amountMinor: -row.amountMinor })),
  ]
  const openingBalanceMinor = entries.filter((entry) => entry.on < query.from).reduce((total, entry) => total + entry.amountMinor, 0)
  let balance = openingBalanceMinor
  const lines = entries
    .filter((entry) => entry.on >= query.from)
    .sort((a, b) => a.on.localeCompare(b.on) || STATEMENT_ORDER[a.kind] - STATEMENT_ORDER[b.kind] || a.documentId.localeCompare(b.documentId))
    .map((entry) => ({ ...entry, balanceMinor: (balance += entry.amountMinor) }))
  return { customerId, currency: query.currency, from: query.from, to: query.to, openingBalanceMinor, lines, closingBalanceMinor: balance }
}

const problems = (action: "view" | "create", what = "payment") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
  404: describeProblem(`No ${what} with that id in the projects this account works in.`),
})

export function paymentRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  /** How each invoice stands on its project's day, the clock read once for the request. */
  const standings = (tx: Tx, companyId: string, rows: readonly InvoiceRow[]): Promise<Map<string, InvoiceStanding>> => {
    const at = now()
    return standingsOf(tx, companyId, rows, (projectId) => projectToday(tx, { companyId, projectId }, () => at)())
  }
  const outstandingOf = async (tx: Tx, companyId: string, row: InvoiceRow): Promise<number> => (await standings(tx, companyId, [row])).get(row.id)?.outstandingMinor ?? 0

  return new Hono<AuthEnv>()
    .get(
      "/payments",
      describeRoute({
        operationId: "listPayments",
        summary: "The payments of the caller's projects",
        description:
          "One page of payments, oldest first, from the projects the caller works in, each with what its allocations apply (`allocatedMinor`, reversals taken off) and what remains (`unallocatedMinor`), a credit on its payer's balance. `projectId` narrows it to one of those projects; `customerId` one payer's payments, held to a customer of this company (400 on the query); `invoiceId` the payments with an allocation to one invoice; `unmatched=true` only those not allocated in full; `from` and `to` a window over `paidOn`, both inclusive. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of payments.", PaymentPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, `projectId` is not a project this account works in, or `customerId` is not a customer of this company."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PaymentListQuery),
      async (c) => {
        const { limit, cursor, projectId, customerId, invoiceId, unmatched, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        if (customerId !== undefined) await requireCustomer(tx, principal.companyId, customerId, "customerId", "query")
        const { query, allocated } = paymentsFrom(tx, principal.companyId)
        const paying =
          invoiceId === undefined
            ? undefined
            : inArray(
                payment.id,
                tx
                  .select({ id: paymentAllocation.paymentId })
                  .from(paymentAllocation)
                  .where(and(eq(paymentAllocation.companyId, principal.companyId), eq(paymentAllocation.invoiceId, invoiceId))),
              )
        const rows = await query
          .where(
            and(
              paymentScope(principal),
              projectId === undefined ? undefined : eq(payment.projectId, projectId),
              customerId === undefined ? undefined : eq(payment.customerId, customerId),
              paying,
              unmatched === true ? sql`${allocated.allocatedMinor} < ${payment.amountMinor}` : undefined,
              from === undefined ? undefined : gte(payment.paidOn, from),
              to === undefined ? undefined : lte(payment.paidOn, to),
              after === undefined ? undefined : gt(payment.id, after),
            ),
          )
          .orderBy(asc(payment.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(paymentOf), limit))
      },
    )
    .get(
      "/payments/:id",
      describeRoute({
        operationId: "getPayment",
        summary: "One payment with its allocations",
        description:
          "One payment of a project the caller works in, as it arrived, with what it has allocated and what remains, and its allocations in recording order — each applying part of it to one invoice, or, negative, reversing one of them.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The payment with its allocations.", PaymentDetail),
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
        if ((await findPayment(tx, principal, id)) === undefined) throw noSuchPayment(id)
        return c.json(await paymentDetail(tx, principal, id))
      },
    )
    .post(
      "/payments",
      describeRoute({
        operationId: "createPayment",
        summary: "Register a payment by hand",
        description:
          "Registers money as it arrived — paid at the counter, a transfer read off the bank's site — in a project the caller works in, with its amount, currency and day, the reference the payer gave and a note. Named, `invoiceId` is the invoice it pays: an invoice of that project (400 at `invoiceId`, `Not an invoice of this project`), never a credit note (400), in the payment's currency (400 at `currency`); its payer is the payment's, and a `customerId` naming another is refused (400 at `customerId`, `Not the invoice's payer`). The payment is allocated to it up to what it owes on the project's day and the rest stays unallocated, a credit on the payer's balance. Without an invoice the payment is unmatched, its payer the `customerId` named or nobody's yet. `source` is `manual`. Under the row locks of the project and of the run that issued the invoice, which a credit note against it takes too, so what the invoice owes is read with nothing moving under it. No refunds here.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The payment with its allocation; read at `/payments/{id}`.", PaymentDetail),
          400: describeProblem("The body is missing a field, names a member the server owns, names a project this account does not work in, a customer that is not this company's, an invoice outside the project or a credit note, a currency other than the invoice's, or a payer other than the invoice's — each at the field that is wrong."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", PaymentCreate),
      async (c) => {
        const body: PaymentCreate = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        await requireCustomer(tx, principal.companyId, body.customerId)
        const paid = body.invoiceId === undefined ? undefined : await findDocument(tx, principal, body.invoiceId)
        if (body.invoiceId !== undefined) {
          const errors: ProblemFieldError[] = []
          if (paid === undefined || paid.projectId !== body.projectId) errors.push({ path: "invoiceId", message: NOT_AN_INVOICE_OF_THE_PROJECT })
          else {
            if (paid.kind !== "invoice") errors.push({ path: "invoiceId", message: A_CREDIT_NOTE_IS_NOT_PAID })
            if (paid.currency !== body.currency) errors.push({ path: "currency", message: inCurrency("invoice", paid.currency) })
            if (body.customerId !== undefined && body.customerId !== paid.customerId) errors.push({ path: "customerId", message: NOT_THE_PAYER })
          }
          if (errors.length > 0) throw invalidRequest("body", errors)
        }
        await lockForPayment(tx, principal.companyId, [body.projectId], paid === undefined ? [] : [paid])
        const id = newId()
        await tx.insert(payment).values({
          id,
          companyId: principal.companyId,
          projectId: body.projectId,
          customerId: body.customerId ?? paid?.customerId ?? null,
          amountMinor: body.amountMinor,
          currency: body.currency,
          paidOn: body.paidOn,
          reference: body.reference ?? null,
          payerText: null,
          source: "manual",
          bankLineKey: null,
          note: body.note ?? null,
          recordedBy: principal.user.id,
        })
        if (paid !== undefined) {
          const amountMinor = Math.min(body.amountMinor, await outstandingOf(tx, principal.companyId, paid))
          if (amountMinor > 0) await appendAllocations(tx, principal, [{ paymentId: id, invoiceId: paid.id, projectId: paid.projectId, amountMinor }])
        }
        return created(c, "/payments", await paymentDetail(tx, principal, id))
      },
    )
    .post(
      "/payments/:id/allocations",
      describeRoute({
        operationId: "allocatePayment",
        summary: "Match part of a payment to an invoice",
        description:
          "Applies `amountMinor` of a payment to one invoice: the office's match of an unmatched payment, or of what remains of one. The invoice is of the payment's project (400 at `invoiceId`), never a credit note (400), in the payment's currency (400 at `invoiceId`), and, where the payment names its payer, that payer's (400 at `invoiceId`, `Not an invoice of the payment's payer`). The amount is at most what the payment has left (409, `Only 300.00 DKK of the payment remains to allocate`) and at most what the invoice owes on the project's day (409, `Invoice INV-26007188 owes only 1250.00 DKK`). Answers 201 with the payment and its allocations and no `Location`, like the ledger's commands: an allocation is read on its payment. Under the row locks of the project and of the invoice's run.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The payment with its allocations, the new one last.", PaymentDetail),
          400: describeProblem("The path does not hold an id, or the body is missing a field, names a member the server owns, a positive amount it does not hold, or an invoice the payment may not pay — each at the field that is wrong."),
          ...problems("create"),
          409: describeProblem("The amount is more than the payment has left or than the invoice owes; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", AllocationCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const body: AllocationCreate = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await findPayment(tx, principal, id)
        if (current === undefined) throw noSuchPayment(id)
        const paid = await findDocument(tx, principal, body.invoiceId)
        const refuse = (message: string) => invalidRequest("body", [{ path: "invoiceId", message }])
        if (paid === undefined || paid.projectId !== current.projectId) throw refuse(NOT_AN_INVOICE_OF_THE_PROJECT)
        if (paid.kind !== "invoice") throw refuse(A_CREDIT_NOTE_IS_NOT_PAID)
        if (paid.currency !== current.currency) throw refuse(inCurrency("payment", current.currency))
        if (current.customerId !== null && current.customerId !== paid.customerId) throw refuse(NOT_THE_PAYMENTS_PAYER)
        await lockForPayment(tx, principal.companyId, [current.projectId], [paid])
        // Read again under the lock: what the payment has left is what other allocations left it.
        const locked = await findPayment(tx, principal, id)
        const remaining = locked === undefined ? 0 : paymentOf(locked).unallocatedMinor
        if (body.amountMinor > remaining) throw problem(409, { detail: remainsOnly(remaining, current.currency) })
        const owes = await outstandingOf(tx, principal.companyId, paid)
        if (body.amountMinor > owes) throw problem(409, { detail: owesOnly(labelOf(paid), owes, paid.currency) })
        await appendAllocations(tx, principal, [{ paymentId: id, invoiceId: paid.id, projectId: paid.projectId, amountMinor: body.amountMinor }])
        return c.json(await paymentDetail(tx, principal, id), 201)
      },
    )
    .post(
      "/payment-allocations/:id/reverse",
      describeRoute({
        operationId: "reversePaymentAllocation",
        summary: "Undo a wrong match",
        description:
          "Appends the negative of an allocation, naming it: the invoice owes that amount again and the payment has it back to allocate. An allocation is reversed once (409, `This allocation is reversed already`), and a reversal is not reversed (409, `A reversal is not reversed; allocate the payment again`). Answers 201 with the payment and its allocations and no `Location`, like the ledger's commands. Under the project's row lock.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The payment with its allocations, the reversal last.", PaymentDetail),
          400: describeProblem("The path does not hold an id."),
          ...problems("create", "payment allocation"),
          409: describeProblem("The allocation is a reversal, or is reversed already; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [current] = await tx
          .select(allocationColumns)
          .from(paymentAllocation)
          .where(and(eq(paymentAllocation.companyId, principal.companyId), inProjects(paymentAllocation.projectId, principal), eq(paymentAllocation.id, id)))
          .limit(1)
        if (current === undefined) throw noSuchAllocation(id)
        if (current.reversesAllocationId !== null) throw problem(409, { detail: A_REVERSAL_IS_NOT_REVERSED })
        await lockRow(tx, project, { companyId: principal.companyId, id: current.projectId })
        const [reversal] = await tx
          .select({ id: paymentAllocation.id })
          .from(paymentAllocation)
          .where(and(eq(paymentAllocation.companyId, principal.companyId), eq(paymentAllocation.reversesAllocationId, id)))
          .limit(1)
        if (reversal !== undefined) throw problem(409, { detail: ALREADY_REVERSED })
        await refuseDuplicate({ payment_allocation_reverses_allocation_id_idx: ALREADY_REVERSED }, () =>
          tx.insert(paymentAllocation).values({
            id: newId(),
            companyId: principal.companyId,
            projectId: current.projectId,
            paymentId: current.paymentId,
            invoiceId: current.invoiceId,
            amountMinor: -current.amountMinor,
            reversesAllocationId: current.id,
            recordedBy: principal.user.id,
          }),
        )
        return c.json(await paymentDetail(tx, principal, current.paymentId), 201)
      },
    )
    .post(
      "/payments/bank-lines",
      describeRoute({
        operationId: "importBankLines",
        summary: "Match a bank statement's lines to invoices",
        description:
          "Takes up to a batch of a bank statement's incoming lines, as the browser read them from our own CSV (`booked_on;amount;currency;reference;text`; ISO 20022 CAMT.053 maps onto it later), each with its row and how many identical lines the file held before it. Each line is a payment of `source = bank-file` on its booking day, its reference and text kept as the bank gave them. A line is matched to an open invoice of the caller's projects in its currency by the invoice's frozen payment reference — as the bank gives it, or inside a FI card's printed line `+71<…+creditor<` — or else by the one label its text names (`INV-26007188`); a match allocates what the invoice owes at most and lands the payment in the invoice's project under its payer, and anything else lands unmatched in `projectId`, nobody's yet. A line a statement already brought — the same booking day, amount, currency, reference, text and count of identical lines before it — is `duplicate`, answered with the payment it already is, so a statement imported twice adds nothing. `dryRun` answers what each line would be, 200, and writes and holds nothing; otherwise 201 with no `Location`, like the ledger's commands. Under the row locks of every project the lines land in and of the runs that issued the invoices they match, in id order.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("A dry run: what each line would be, nothing written.", BankLinesResult),
          201: describeJson("Each line's outcome in the body's order, with the payment it is, and the counts.", BankLinesResult),
          400: describeProblem("The body is missing a field, names a member the server owns, holds more lines than a batch or an outgoing line, or names a project this account does not work in — each at the field that is wrong."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
          409: describeProblem("A line of the batch was imported already into a project this account does not work in."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", BankLines),
      async (c) => {
        const body: BankLines = c.req.valid("json")
        const dryRun = body.dryRun === true
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { companyId } = principal
        requireProject(principal, body.projectId)
        const keyed = body.lines.map((line) => ({ line, key: bankLineKey(line, line.occurrence) }))
        // The invoices any line could pay, read once: by the references the lines carry, and by the invoice labels their texts name.
        const references = [...new Set(body.lines.flatMap((line) => bankLineReference(line.reference) ?? []))]
        const numbers = [
          ...new Set(
            body.lines.flatMap((line) =>
              bankLineLabels(line.text)
                .filter((label) => label.startsWith(INVOICE_NUMBER_PREFIX))
                .map((label) => Number(label.slice(INVOICE_NUMBER_PREFIX.length)))
                .filter((number) => number <= 2_147_483_647),
            ),
          ),
        ]
        const naming = or(references.length === 0 ? undefined : inArray(invoice.paymentReference, references), numbers.length === 0 ? undefined : inArray(invoice.number, numbers))
        const candidates =
          naming === undefined
            ? []
            : await tx
                .select(invoiceColumns)
                .from(invoice)
                .where(and(invoiceScope(principal), eq(invoice.kind, "invoice"), naming))
        if (!dryRun) await lockForPayment(tx, companyId, [body.projectId, ...candidates.map((row) => row.projectId)], candidates)
        const standing = await standings(tx, companyId, candidates)
        const byId = new Map(candidates.map((row) => [row.id, row]))
        const open: OpenInvoice[] = candidates.map((row) => ({ id: row.id, label: labelOf(row), paymentReference: row.paymentReference, currency: row.currency, outstandingMinor: standing.get(row.id)?.outstandingMinor ?? 0 }))
        const known = new Map<string, string | null>(
          (
            await tx
              .select({ id: payment.id, key: payment.bankLineKey })
              .from(payment)
              .where(and(paymentScope(principal), inArray(payment.bankLineKey, keyed.map(({ key }) => key))))
          ).map((row) => [row.key ?? "", row.id]),
        )
        const lines: BankLineResult[] = []
        const payments: (typeof payment.$inferInsert)[] = []
        const allocations: AllocationDraft[] = []
        for (const { line, key } of keyed) {
          if (known.has(key)) {
            lines.push({ row: line.row, outcome: "duplicate", paymentId: known.get(key) ?? null, invoiceId: null, allocatedMinor: 0, by: null })
            continue
          }
          const match = matchBankLine(line, open)
          const paid = match === null ? undefined : byId.get(match.invoiceId)
          const id = dryRun ? null : newId()
          known.set(key, id)
          if (id !== null)
            payments.push({
              id,
              companyId,
              projectId: paid?.projectId ?? body.projectId,
              customerId: paid?.customerId ?? null,
              amountMinor: line.amountMinor,
              currency: line.currency,
              paidOn: line.bookedOn,
              reference: line.reference === "" ? null : line.reference,
              payerText: line.text === "" ? null : line.text,
              source: "bank-file",
              bankLineKey: key,
              note: null,
              recordedBy: principal.user.id,
            })
          if (match === null || paid === undefined) {
            lines.push({ row: line.row, outcome: "unmatched", paymentId: id, invoiceId: null, allocatedMinor: 0, by: null })
            continue
          }
          // What this line pays, the next line paying the same invoice may not.
          const owed = open.find((candidate) => candidate.id === paid.id)
          if (owed !== undefined) owed.outstandingMinor -= match.amountMinor
          if (id !== null) allocations.push({ paymentId: id, invoiceId: paid.id, projectId: paid.projectId, amountMinor: match.amountMinor })
          lines.push({ row: line.row, outcome: "matched", paymentId: id, invoiceId: paid.id, allocatedMinor: match.amountMinor, by: match.by })
        }
        if (payments.length > 0) await refuseDuplicate({ payment_bank_line_key_idx: IMPORTED_ELSEWHERE }, () => tx.insert(payment).values(payments))
        await appendAllocations(tx, principal, allocations)
        const count = (outcome: BankLineResult["outcome"]) => lines.filter((line) => line.outcome === outcome).length
        const result: BankLinesResult = { dryRun, lines, counts: { matched: count("matched"), unmatched: count("unmatched"), duplicate: count("duplicate") } }
        return c.json(result, dryRun ? 200 : 201)
      },
    )
    .get(
      "/customers/:id/statement",
      describeRoute({
        operationId: "getCustomerStatement",
        summary: "A customer's statement",
        description:
          "A payer's invoices, credit notes and payments in one `currency` over `from`..`to`, both inclusive, from the projects the caller works in: the opening balance of everything before `from` — invoiced less credited less paid — then each line by day, invoices before credit notes before payments on one day, with the balance after it, and the closing balance. An invoice raises the balance by its gross and a credit note lowers it by its own; a payment naming the payer lowers it by its whole amount, what it has not allocated included, which is the payer's credit; a payment of nobody's counts by what its allocations put on this payer's invoices. A customer of another company is a customer that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The statement.", CustomerStatement),
          400: describeProblem("The path does not hold an id, or the query is missing the currency or the window, or the window runs backwards."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No customer with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", CustomerStatementQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const query: CustomerStatementQuery = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [found] = await tx
          .select({ id: customer.id })
          .from(customer)
          .where(and(eq(customer.companyId, principal.companyId), eq(customer.id, id)))
          .limit(1)
        if (found === undefined) throw noSuchCustomer(id)
        return c.json(await statementOf(tx, principal, id, query))
      },
    )
}
