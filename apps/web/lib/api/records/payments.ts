// Commercial › Payments on the Pilot (#291 slice 6, #292 C6w): money as it
// arrived and what it pays, read and written through `/payments`
// (apps/api/src/routes/payments.ts). A payment is `payment-<uuid>` from the
// start, a ledger row stamped with its `recordedAt` as both of a resource's
// stamps, and never edited: every patch is refused, a wrong match undone by
// its reversal. It reads Unmatched, Partially allocated or Allocated by what
// its allocations apply (`paymentRecordStatus`), the rest a credit on its
// payer's balance.
//
// Register payment is the module's create: a project, the amount and the day,
// the reference the payer gave, and the invoice it pays where the office
// knows it, whose currency and payer it takes. Two commands move a row:
// `allocate`, the office's match of what remains to an invoice, and
// `reverse`, an allocation's undoing; both change what the invoices owe, so
// the invoices are read again after either. A bank statement's lines and a
// customer's statement are reads the surfaces ask through the client
// (`importBankLines`, `customerStatement`), as Run billing's preview is.
import type { BankLine, BankLines, BankLinesResult, CustomerStatement, Payment, PaymentDetail } from "@waste/contracts/payments"
import type { BankFile } from "@waste/domain/finance/payments"

import { formatMinor, minorOf } from "@/lib/commercial/money"
import { FIXTURE_COMPANY_ID } from "@/lib/data/business-modules"
import { INVOICE_PREFIX, INVOICES_MODULE, isInvoiceDocument, isPaymentRecord, PAYMENT_PREFIX, PAYMENT_RECORD_KIND, PAYMENT_SOURCE_LABELS, PAYMENTS_MODULE, paymentRecordStatus } from "@/lib/data/commercial"

import { command, create, get, listAll } from "../client"
import { inheritedPresentation, moduleKeyOf, said, stampFacts, typed, webIdOf, type Client, type ResourceAdapter, type ServerModule } from "./adapter"
import { amountRefusal, firstMoved, named, projectOf } from "./billing"
import { refusal } from "./places"
import { nameVia, typedReference } from "./references"

/** What an edit of a payment is told. */
export const PAYMENT_NEVER_CHANGES = "A payment is never edited: undo a wrong match by its reversal"

/** A payment as the module reads it: a ledger row with a resource's stamps, its allocations where it was read whole. */
export type PaymentResource = (Payment | PaymentDetail) & { createdAt: string; updatedAt: string }

const stamped = <Read extends Payment | PaymentDetail>(payment: Read): Read & { createdAt: string; updatedAt: string } => ({ ...payment, createdAt: payment.recordedAt, updatedAt: payment.recordedAt })

/** `GET /payments/:id`: the payment with its allocations, in recording order. */
export function paymentDetail(client: Client, serverId: string): Promise<PaymentDetail> {
  return get<PaymentDetail>(client, `/payments/${serverId}`)
}

/** `GET /payments?invoiceId=`: the payments with an allocation to one invoice. */
export function paymentsOfInvoice(client: Client, invoiceServerId: string): Promise<Payment[]> {
  return listAll<Payment>(client, "/payments", { invoiceId: invoiceServerId })
}

/** A file's lines as the wire carries them: what each says, its row and how many identical lines came before it, never the key the server computes again. */
export const wireLinesOf = (file: BankFile): BankLine[] =>
  file.lines.map((line) => ({ row: line.row, bookedOn: line.bookedOn, amountMinor: line.amountMinor, currency: line.currency, reference: line.reference, text: line.text, occurrence: line.occurrence }))

/** `POST /payments/bank-lines`: a batch of a statement's lines, matched; a dry run writes nothing. */
export function importBankLines(client: Client, body: BankLines): Promise<BankLinesResult> {
  return command<BankLinesResult>(client, "/payments/bank-lines", body)
}

/** `GET /customers/:id/statement`: a payer's invoices, credit notes and payments in one currency over a window. */
export function customerStatement(client: Client, customerServerId: string, query: { currency: string; from: string; to: string }): Promise<CustomerStatement> {
  const search = new URLSearchParams(query)
  return get<CustomerStatement>(client, `/customers/${customerServerId}/statement?${search.toString()}`)
}

/** What a match of a payment to an invoice carries, as the store's command input names it. */
const ALLOCATION_KEYS = { invoiceId: "invoiceId", amount: "amount", allocationId: "allocationId" } as const

export const paymentAdapter: ResourceAdapter<PaymentResource> = {
  prefix: PAYMENT_PREFIX,
  owns: isPaymentRecord,
  statuses: undefined,
  list: (client) => listAll<Payment>(client, "/payments").then((payments) => payments.map(stamped)),
  read: (client, serverId) => paymentDetail(client, serverId).then(stamped),
  toRecord: (payment, context) => {
    const project = projectOf(context, payment.projectId)
    const payer = named(context, "customer", payment.customerId)
    const money = (minor: number) => formatMinor(minor, payment.currency)
    const status = paymentRecordStatus(payment)
    const allocations = "allocations" in payment ? payment.allocations : undefined
    const invoices = [...new Set((allocations ?? []).map((allocation) => allocation.invoiceId))].flatMap((id) => named(context, INVOICE_PREFIX, id) ?? [])
    const from = payer?.name ?? payment.payerText ?? "Nobody yet"
    return {
      id: webIdOf(PAYMENT_PREFIX, payment.id),
      name: `${money(payment.amountMinor)} · ${payment.paidOn}`,
      context: `${from} · ${payment.paidOn}`,
      status,
      ...inheritedPresentation(undefined),
      ...stampFacts(payment, context.now),
      value: money(payment.amountMinor),
      description:
        status === "Unmatched"
          ? `Paid on ${payment.paidOn} and matched to no invoice yet: match it to the invoice it pays.`
          : status === "Allocated"
            ? `Paid on ${payment.paidOn}, all of it allocated.`
            : `Paid on ${payment.paidOn}; ${money(payment.unallocatedMinor)} is a credit on ${payer?.name ?? "the payer"}'s balance.`,
      facts: {
        Kind: PAYMENT_RECORD_KIND,
        Source: PAYMENT_SOURCE_LABELS[payment.source],
        "Paid on": payment.paidOn,
        Payer: payer?.name ?? "Nobody yet",
        Currency: payment.currency,
        ...(payment.reference === null ? {} : { Reference: payment.reference }),
        ...(payment.payerText === null ? {} : { "Bank text": payment.payerText }),
        ...(payment.note === null ? {} : { Note: payment.note }),
        Amount: money(payment.amountMinor),
        Allocated: money(payment.allocatedMinor),
        Unallocated: money(payment.unallocatedMinor),
        ...(payment.recordedBy === null ? {} : { "Recorded by": nameVia(context, "user", payment.recordedBy) }),
      },
      related: [...(payer === undefined ? [] : [payer.name]), ...invoices.map((invoice) => invoice.name)],
      allowedTransitions: [],
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: PAYMENT_RECORD_KIND,
      submittedValues: {
        projectId: project.webId,
        ...(payer === undefined ? {} : { customerId: payer.id }),
        currency: payment.currency,
        paidOn: payment.paidOn,
        unallocatedMinor: String(payment.unallocatedMinor),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectWebId = typed(record, "projectId") ?? record.projectIds?.[0]
    const projectId = projectWebId === undefined ? undefined : context.resolve.serverIdOf(projectWebId)
    if (projectId === undefined) return refusal("projectId", "Pick a project the API holds")
    // The invoice it pays lends it its currency; without one, the project's.
    const invoiceWebId = typed(record, "invoiceId")
    let invoiceId: string | undefined
    let currency = projectOf(context, projectId).currency ?? "DKK"
    if (invoiceWebId !== undefined) {
      invoiceId = context.resolve.serverIdOf(invoiceWebId)
      const invoice = invoiceId === undefined ? undefined : context.resolve.byServerId(invoiceId)
      if (invoiceId === undefined || invoice === undefined || !isInvoiceDocument(invoice) || typed(invoice, "kind") !== "invoice") return refusal("invoiceId", "Pick an invoice the API holds: a credit note is paid by nobody")
      currency = typed(invoice, "currency") ?? currency
    }
    const customerId = typedReference(record, "customerId", "customer", context, "Pick a customer the API holds")
    if (typeof customerId === "object") return customerId
    const amount = typed(record, "amount")
    const amountMinor = amount === undefined ? Number.NaN : minorOf(amount, currency)
    if (Number.isNaN(amountMinor) || amountMinor <= 0) return amountRefusal("amount", currency)
    const paidOn = typed(record, "paidOn")
    if (paidOn === undefined) return refusal("paidOn", "Pick the day it was paid")
    const reference = typed(record, "reference")
    const note = typed(record, "note")
    return {
      projectId,
      amountMinor,
      currency,
      paidOn,
      ...(customerId === undefined ? {} : { customerId }),
      ...(invoiceId === undefined ? {} : { invoiceId }),
      ...(reference === undefined ? {} : { reference }),
      ...(note === undefined ? {} : { note }),
    }
  },
  toPatchBody: (before, after) => refusal(firstMoved(before, after), PAYMENT_NEVER_CHANGES),
  create: (client, body) => create<PaymentDetail>(client, "/payments", body).then((created) => stamped(created.body)),
  update: () => Promise.reject(new Error("A payment has no patch route")),
  commands: {
    // The office's match: what remains of the payment, or part of it, to one invoice of its project.
    allocate: {
      toBody: (input, record, context) => {
        const invoiceWebId = said(input, ALLOCATION_KEYS.invoiceId)
        const invoiceId = invoiceWebId === undefined ? undefined : context.resolve.serverIdOf(invoiceWebId)
        const invoice = invoiceId === undefined ? undefined : context.resolve.byServerId(invoiceId)
        if (invoiceId === undefined || invoice === undefined || !isInvoiceDocument(invoice) || typed(invoice, "kind") !== "invoice") return refusal(ALLOCATION_KEYS.invoiceId, "Pick an invoice the API holds")
        const currency = typed(record, "currency") ?? "DKK"
        const amount = said(input, ALLOCATION_KEYS.amount)
        const amountMinor = amount === undefined ? Number(typed(record, "unallocatedMinor")) : minorOf(amount, currency)
        if (Number.isNaN(amountMinor) || amountMinor <= 0) return amountRefusal(ALLOCATION_KEYS.amount, currency)
        return { invoiceId, amountMinor }
      },
      run: (client, serverId, body) => command<PaymentDetail>(client, `/payments/${serverId}/allocations`, body).then(stamped),
      refused: (record) => `${record.name} was not matched`,
      touches: [moduleKeyOf(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId)],
    },
    // A wrong match undone: the allocation's negative, naming it. The row is the payment; the allocation travels in the body.
    reverse: {
      toBody: (input) => {
        const allocationId = said(input, ALLOCATION_KEYS.allocationId)
        return allocationId === undefined ? refusal(ALLOCATION_KEYS.allocationId, "Pick the match to undo") : { allocationId }
      },
      run: (client, _serverId, body) => command<PaymentDetail>(client, `/payment-allocations/${(body as { allocationId: string }).allocationId}/reverse`).then(stamped),
      refused: (record) => `${record.name}'s match was not undone`,
      touches: [moduleKeyOf(INVOICES_MODULE.workspaceId, INVOICES_MODULE.moduleId)],
    },
  },
}

/** Commercial › Payments: the payments, after the invoices they pay and the customers who pay them. */
export const paymentsModule: ServerModule = { workspaceId: PAYMENTS_MODULE.workspaceId, moduleId: PAYMENTS_MODULE.moduleId, resources: [paymentAdapter] }
