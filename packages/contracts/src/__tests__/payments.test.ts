// Payments and reconciliation on the wire (#291 C6): a payment as it arrived
// with what it has allocated, its allocations, the office's register and
// match, a bank statement's lines as the browser read them, and a customer's
// statement. Each shape refuses what the database would.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IMPORT_BATCH_MAX } from "@waste/domain/imports/vocabulary"

import { AllocationCreate, BankLines, BankLinesResult, CustomerStatement, InvoicePaymentStatus, Payment, PaymentCreate, PaymentDetail, PaymentListQuery, PaymentSource } from "../payments"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMP = { recordedAt: "2026-10-12T09:30:00.000Z" }

const payment = {
  id: ID,
  ...STAMP,
  projectId: ID,
  customerId: OTHER,
  amountMinor: 62_500,
  currency: "DKK",
  paidOn: "2026-10-12",
  reference: "000000260071881",
  payerText: "Østerbro Housing",
  source: "bank-file",
  note: null,
  recordedBy: ID,
  allocatedMinor: 62_500,
  unallocatedMinor: 0,
}

const issues = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) => result.error?.issues.map((issue) => issue.path.join(".")) ?? []

describe("a payment on the wire", () => {
  test("is the money as it arrived, its payer where known, and what it has allocated and has not", () => {
    assert.deepEqual(Payment.parse(payment), payment)
    assert.deepEqual(Payment.parse({ ...payment, customerId: null, reference: null, payerText: null }).customerId, null, "a bank line nobody's yet")
    assert.deepEqual(issues(Payment.safeParse({ ...payment, amountMinor: 0 })), ["amountMinor"], "money that arrived is more than nothing")
    assert.deepEqual(issues(Payment.safeParse({ ...payment, source: "card" })), ["source"])
    assert.deepEqual(PaymentSource.options, ["manual", "bank-file"])
    const allocation = { id: OTHER, ...STAMP, paymentId: ID, invoiceId: OTHER, amountMinor: 62_500, reversesAllocationId: null, recordedBy: ID }
    assert.equal(PaymentDetail.parse({ ...payment, allocations: [allocation, { ...allocation, id: ID, amountMinor: -62_500, reversesAllocationId: OTHER }] }).allocations.length, 2)
  })

  test("is registered by hand naming its project, amount, currency and day, and the invoice it pays if the office knows it; nothing the server owns", () => {
    const body = { projectId: ID, amountMinor: 62_500, currency: "DKK", paidOn: "2026-10-12", invoiceId: OTHER, note: "Paid at the counter" }
    assert.deepEqual(PaymentCreate.parse(body), body)
    assert.deepEqual(issues(PaymentCreate.safeParse({ ...body, amountMinor: -5 })), ["amountMinor"])
    assert.deepEqual(issues(PaymentCreate.safeParse({ ...body, source: "manual" })), [""], "the source is the server's")
    assert.deepEqual(issues(PaymentCreate.safeParse({ ...body, currency: "dkk" })), ["currency"])
  })

  test("is matched by hand to one invoice by a positive amount", () => {
    assert.deepEqual(AllocationCreate.parse({ invoiceId: ID, amountMinor: 10_000 }), { invoiceId: ID, amountMinor: 10_000 })
    assert.deepEqual(issues(AllocationCreate.safeParse({ invoiceId: ID, amountMinor: 0 })), ["amountMinor"], "an allocation is undone by its reversal, never by a zero")
  })

  test("is listed by project, payer, invoice, the unmatched alone, and a window of days", () => {
    assert.deepEqual(PaymentListQuery.parse({ projectId: ID, unmatched: "true", from: "2026-10-01", to: "2026-10-31" }), { limit: 50, projectId: ID, unmatched: true, from: "2026-10-01", to: "2026-10-31" })
    assert.deepEqual(issues(PaymentListQuery.safeParse({ from: "2026-10-31", to: "2026-10-01" })), ["to"])
  })
})

describe("a bank statement's lines", () => {
  const line = { row: 2, bookedOn: "2026-10-12", amountMinor: 62_500, currency: "DKK", reference: "000000260071881", text: "Østerbro Housing", occurrence: 0 }

  test("travel as the browser read them, at most a batch at a time, into the project unmatched money lands in", () => {
    assert.equal(BankLines.parse({ projectId: ID, lines: [line] }).lines.length, 1)
    assert.equal(BankLines.parse({ projectId: ID, dryRun: true, lines: [line] }).dryRun, true)
    assert.deepEqual(issues(BankLines.safeParse({ projectId: ID, lines: Array.from({ length: IMPORT_BATCH_MAX + 1 }, (_, index) => ({ ...line, row: index + 2 })) })), ["lines"])
    assert.deepEqual(issues(BankLines.safeParse({ projectId: ID, lines: [{ ...line, amountMinor: -80 }] })), ["lines.0.amountMinor"], "an outgoing line never leaves the browser")
    assert.deepEqual(issues(BankLines.safeParse({ projectId: ID, lines: [{ ...line, key: "x" }] })), ["lines.0"], "the key is the server's to compute")
  })

  test("answer line by line: matched to an invoice and how much of it, unmatched, or a line already imported", () => {
    const result = {
      dryRun: false,
      lines: [
        { row: 2, outcome: "matched", paymentId: ID, invoiceId: OTHER, allocatedMinor: 62_500, by: "reference" },
        { row: 3, outcome: "unmatched", paymentId: OTHER, invoiceId: null, allocatedMinor: 0, by: null },
        { row: 4, outcome: "duplicate", paymentId: ID, invoiceId: null, allocatedMinor: 0, by: null },
      ],
      counts: { matched: 1, unmatched: 1, duplicate: 1 },
    }
    assert.deepEqual(BankLinesResult.parse(result), result)
  })
})

describe("a customer's statement", () => {
  test("opens with a balance, runs line by line through invoices, credit notes and payments, and closes with the balance", () => {
    const statement = {
      customerId: ID,
      currency: "DKK",
      from: "2026-10-01",
      to: "2026-10-31",
      openingBalanceMinor: 0,
      lines: [
        { on: "2026-10-05", kind: "invoice", documentId: ID, label: "INV-26007188", amountMinor: 125_000, balanceMinor: 125_000 },
        { on: "2026-10-12", kind: "payment", documentId: OTHER, label: "000000260071881", amountMinor: -62_500, balanceMinor: 62_500 },
      ],
      closingBalanceMinor: 62_500,
    }
    assert.deepEqual(CustomerStatement.parse(statement), statement)
    assert.deepEqual(InvoicePaymentStatus.options, ["open", "partially-paid", "paid", "overdue", "credited"])
  })
})
