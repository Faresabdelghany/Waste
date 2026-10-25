// Payments on the adapter (#291 slice 6, #292 C6w): Commercial › Payments
// over `/payments`, registered by hand with the invoice it pays, matched to
// an invoice and its match undone by command, never edited; an invoice
// showing what its payments make of it; and the reads a surface asks — a
// statement's lines a batch at a time, a customer's statement. The bodies are
// held against the contracts' own zod schemas.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { Customer } from "@waste/contracts/customers"
import type { Invoice } from "@waste/contracts/invoices"
import type { Project } from "@waste/contracts/organisation"
import { AllocationCreate, BankLines, PaymentCreate, type Payment, type PaymentDetail } from "@waste/contracts/payments"
import { bankFileOf } from "@waste/domain/finance/payments"

import { FIXTURE_COMPANY_ID, getModuleDefinition, type BusinessRecord } from "../../data/business-modules"
import { createPaymentRecord, PAYMENT_FORM } from "../../data/commercial-forms"
import { problemSentence } from "../problem"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { invoiceAdapter } from "../records/billing"
import { isServerBacked, SERVER_MODULE_KEYS } from "../records/modules"
import { projectAdapter } from "../records/organisation"
import { customerStatement, importBankLines, PAYMENT_NEVER_CHANGES, paymentAdapter, paymentsModule, wireLinesOf } from "../records/payments"
import { customerAdapter } from "../records/registry"
import { commandRecord, loaded, loadModule, resolverOver, writeRecord, type ServerRecordsState } from "../records/server-records"
import { bodyOf, clientOver, json, problem, scripted } from "./scripted-fetch"

const NOW = new Date("2026-10-12T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const RECORDED = { recordedAt: "2026-10-12T08:00:00.000Z" }
const fixturesOf = (workspaceId: Parameters<typeof getModuleDefinition>[0]["workspaceId"], moduleId: string) => getModuleDefinition({ workspaceId, moduleId })?.records ?? []
const paymentFixtures = fixturesOf("commercial", "payments")

const copenhagen: Project = { id: "01a0d2a4-a280-7002-8000-000000000001", ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays", publicSlug: null, weightTolerancePercent: 5, paymentTermsDays: 30, paymentReferenceScheme: "fik-71", holdForReview: false }
const osterbro: Customer = { id: "01a0d2a4-a280-700b-8000-000000000002", ...STAMPS, kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: null, phone: null, billingAddress: null, serviceMessagesAllowed: true, paymentTermsDays: null, status: "active" }
const ADMIN = "01a0d2a4-a280-7003-8000-000000000001"
const invoice: Invoice = { ...RECORDED, id: "01a0d2a4-a280-7080-8000-000000000001", projectId: copenhagen.id, number: 26007188, label: "INV-26007188", kind: "invoice", customerId: osterbro.id, currency: "DKK", issuedOn: "2026-09-30", dueOn: "2026-10-30", periodFrom: "2026-09-01", periodTo: "2026-09-30", billingRunId: "01a0d2a4-a280-7070-8000-000000000001", creditsInvoiceId: null, creditReason: null, creditNote: null, netMinor: 66650, vatMinor: 16663, grossMinor: 83313, issuedBy: ADMIN, paymentReference: "000000260071881", paidMinor: 30000, outstandingMinor: 53313, paymentStatus: "partially-paid" }
const creditNote: Invoice = { ...invoice, id: "01a0d2a4-a280-7080-8000-000000000002", number: 26007189, label: "CN-26007189", kind: "credit-note", billingRunId: null, creditsInvoiceId: invoice.id, creditReason: "duplicate", paymentReference: null, paidMinor: 0, outstandingMinor: 0, paymentStatus: null, netMinor: -10000, vatMinor: -2500, grossMinor: -12500 }

const NO_CONTEXT = (fixtures: readonly BusinessRecord[]): MappingContext => ({ fixtures, resolve: NOTHING_RESOLVED, companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const moduleOf = (records: BusinessRecord[], ids: string[]) => loaded({ records, serverIds: new Map(records.map((record, index) => [record.id, ids[index]])) }, 1)
const copenhagenRecord = projectAdapter.toRecord(copenhagen, NO_CONTEXT(fixturesOf("configure", "organization")))
const osterbroRecord = customerAdapter.toRecord(osterbro, NO_CONTEXT(fixturesOf("customers", "contacts")))
const asRead = (document: Invoice) => ({ ...document, createdAt: document.recordedAt, updatedAt: document.recordedAt })
const base: ServerRecordsState = new Map([
  ["configure.organization", moduleOf([copenhagenRecord], [copenhagen.id])],
  ["configure.access", moduleOf([{ ...copenhagenRecord, id: `user-${ADMIN}`, name: "Fares Abdelghany", recordKind: "User" }], [ADMIN])],
  ["customers.contacts", moduleOf([osterbroRecord], [osterbro.id])],
])
const invoiceRecords = [invoice, creditNote].map((document) => invoiceAdapter.toRecord(asRead(document), { ...NO_CONTEXT(fixturesOf("commercial", "invoices")), resolve: resolverOver(base) }))
const state: ServerRecordsState = new Map([...base, ["commercial.invoices", moduleOf(invoiceRecords, [invoice.id, creditNote.id])]])
const context = (fixtures: readonly BusinessRecord[] = paymentFixtures): MappingContext => ({ fixtures, resolve: resolverOver(state), companyRecordId: FIXTURE_COMPANY_ID, now: NOW })
const [invoiceRecord, creditNoteRecord] = invoiceRecords

const payment: PaymentDetail = {
  id: "01a0d2a4-a280-7090-8000-000000000001",
  ...RECORDED,
  projectId: copenhagen.id,
  customerId: osterbro.id,
  amountMinor: 50000,
  currency: "DKK",
  paidOn: "2026-10-12",
  reference: "+71<000000260071881+85123456<",
  payerText: "Østerbro Housing",
  source: "bank-file",
  note: null,
  recordedBy: ADMIN,
  allocatedMinor: 30000,
  unallocatedMinor: 20000,
  allocations: [{ id: "01a0d2a4-a280-7091-8000-000000000001", ...RECORDED, paymentId: "01a0d2a4-a280-7090-8000-000000000001", invoiceId: invoice.id, amountMinor: 30000, reversesAllocationId: null, recordedBy: ADMIN }],
}
const loose: Payment = { ...payment, id: "01a0d2a4-a280-7090-8000-000000000002", customerId: null, reference: null, payerText: "Betaling okt", allocatedMinor: 0, unallocatedMinor: 55000, amountMinor: 55000 }
const pageOf = (items: unknown[]) => json({ items, nextCursor: null })

describe("an invoice's standing", () => {
  test("is what its payments make of it, beside its credit standing: a credit note has none", () => {
    assert.deepEqual([invoiceRecord.facts.Payment, invoiceRecord.facts.Paid, invoiceRecord.facts.Outstanding], ["Partially paid", "DKK 300.00", "DKK 533.13"])
    assert.equal(invoiceRecord.status, "Issued", "the status stays the credit standing")
    assert.equal(creditNoteRecord.facts.Payment, undefined)
    assert.equal(invoiceAdapter.toRecord(asRead({ ...invoice, paymentStatus: "overdue" }), context()).facts.Payment, "Overdue")
  })
})

describe("the payments module", () => {
  test("is switched after the invoices it pays and the customers who pay", () => {
    assert.ok(isServerBacked("commercial", "payments"))
    for (const before of ["commercial.invoices", "customers.contacts"]) assert.ok(SERVER_MODULE_KEYS.indexOf("commercial.payments") > SERVER_MODULE_KEYS.indexOf(before), before)
    assert.deepEqual(paymentsModule.resources, [paymentAdapter])
  })

  test("lists the payments: a matched one by its payer, an unmatched one by the bank's text, each by what its allocations apply", async () => {
    const { fetch, calls } = scripted([() => pageOf([payment, loose])])
    const result = await loadModule(clientOver(fetch), paymentsModule, { fixtures: paymentFixtures, state, now: NOW })
    assert.deepEqual(calls.map((call) => call.url), ["http://api.test/payments?limit=200"])
    const [matched, unmatched] = result.records
    assert.equal(matched.id, `payment-${payment.id}`)
    assert.equal(matched.name, "DKK 500.00 · 2026-10-12")
    assert.equal(matched.context, "Østerbro Housing · 2026-10-12")
    assert.equal(matched.status, "Partially allocated")
    assert.deepEqual([matched.facts.Source, matched.facts.Allocated, matched.facts.Unallocated, matched.facts["Recorded by"]], ["Bank statement", "DKK 300.00", "DKK 200.00", "Fares Abdelghany"])
    assert.equal(unmatched.status, "Unmatched")
    assert.equal(unmatched.context, "Betaling okt · 2026-10-12")
    assert.equal(unmatched.facts.Payer, "Nobody yet")
    const whole = paymentAdapter.toRecord({ ...payment, createdAt: payment.recordedAt, updatedAt: payment.recordedAt }, context())
    assert.deepEqual(whole.related, ["Østerbro Housing", "INV-26007188"], "a payment read whole names the invoices it pays")
  })

  test("registers a payment by hand with the invoice it pays, in the invoice's currency, and refuses what the API would", async () => {
    const values = { projectId: copenhagenRecord.id, invoiceId: invoiceRecord.id, customerId: "", amount: "250,00", paidOn: "2026-10-12", reference: "Kontant", note: "" }
    const record = createPaymentRecord(values, 1)
    const body = paymentAdapter.toCreateBody!(record, context())
    assert.deepEqual(body, { projectId: copenhagen.id, amountMinor: 25000, currency: "DKK", paidOn: "2026-10-12", invoiceId: invoice.id, reference: "Kontant" })
    assert.ok(PaymentCreate.safeParse(body).success)
    const fieldIds = PAYMENT_FORM.sections.flatMap((section) => section.fields.map((field) => field.id))
    assert.deepEqual(fieldIds.filter((id) => !(id in values)), [], "every field of the form is a key the adapter reads")
    const refuse = (changes: Record<string, string>) => paymentAdapter.toCreateBody!(createPaymentRecord({ ...values, ...changes }, 2), context())
    assert.deepEqual(refuse({ invoiceId: creditNoteRecord.id }), { path: "invoiceId", message: "Pick an invoice the API holds: a credit note is paid by nobody" })
    assert.deepEqual(refuse({ amount: "0" }), { path: "amount", message: "An amount in DKK, such as 18.50" })
    assert.deepEqual(refuse({ paidOn: "" }), { path: "paidOn", message: "Pick the day it was paid" })
    assert.deepEqual(paymentAdapter.toCreateBody!(createPaymentRecord({ ...values, invoiceId: "", customerId: osterbroRecord.id }, 3), context()), { projectId: copenhagen.id, amountMinor: 25000, currency: "DKK", paidOn: "2026-10-12", customerId: osterbro.id, reference: "Kontant" }, "without an invoice, in the project's currency")

    const { fetch, calls } = scripted([() => json({ ...payment, source: "manual" }, 201, { location: `/payments/${payment.id}` })])
    const outcome = await writeRecord(clientOver(fetch), paymentsModule, moduleOf([], []), record, { fixtures: paymentFixtures, state })
    assert.equal(calls[0].url, "http://api.test/payments")
    assert.equal(outcome.kind, "created")
  })

  test("is never edited: a wrong match is undone by its reversal", () => {
    const record = paymentAdapter.toRecord({ ...payment, createdAt: payment.recordedAt, updatedAt: payment.recordedAt }, context())
    assert.deepEqual(paymentAdapter.toPatchBody(record, { ...record, submittedValues: { ...record.submittedValues, paidOn: "2026-10-13" } }, context()), { path: "paidOn", message: PAYMENT_NEVER_CHANGES })
  })

  test("is matched to an invoice by command, all that remains where no amount is given, and its match undone by the allocation's reversal; both re-read the invoices", async () => {
    const record = paymentAdapter.toRecord({ ...loose, createdAt: loose.recordedAt, updatedAt: loose.recordedAt }, context())
    const current = moduleOf([record], [loose.id])
    const matchedDetail: PaymentDetail = { ...loose, customerId: osterbro.id, allocatedMinor: 55000, unallocatedMinor: 0, allocations: [{ ...payment.allocations[0], id: "01a0d2a4-a280-7091-8000-000000000002", paymentId: loose.id, amountMinor: 55000 }] }
    const { fetch, calls } = scripted([() => json(matchedDetail, 201), () => problem(409, "Invoice INV-26007188 owes only 533.13 DKK"), () => json({ ...matchedDetail, allocatedMinor: 0, unallocatedMinor: 55000 }, 201)])
    const options = { fixtures: paymentFixtures, state, now: NOW }
    const done = await commandRecord(clientOver(fetch), paymentsModule, current, record, "allocate", { invoiceId: invoiceRecord.id }, options)
    assert.equal(done.kind, "done")
    assert.equal(calls[0].url, `http://api.test/payments/${loose.id}/allocations`)
    assert.deepEqual(bodyOf(calls[0]), { invoiceId: invoice.id, amountMinor: 55000 })
    assert.ok(AllocationCreate.safeParse(bodyOf(calls[0])).success)
    if (done.kind === "done") {
      assert.equal(done.record.status, "Allocated")
      assert.deepEqual(done.touches, ["commercial.invoices"])
    }
    const refused = await commandRecord(clientOver(fetch), paymentsModule, current, record, "allocate", { invoiceId: invoiceRecord.id, amount: "600" }, options)
    assert.equal(refused.kind, "refused")
    if (refused.kind === "refused") assert.equal(problemSentence(refused.problem), "Invoice INV-26007188 owes only 533.13 DKK")
    assert.deepEqual(bodyOf(calls[1]), { invoiceId: invoice.id, amountMinor: 60000 })
    const undone = await commandRecord(clientOver(fetch), paymentsModule, current, record, "reverse", { allocationId: matchedDetail.allocations[0].id }, options)
    assert.equal(undone.kind, "done")
    assert.equal(calls[2].url, `http://api.test/payment-allocations/${matchedDetail.allocations[0].id}/reverse`)
    const unpicked = await commandRecord(clientOver(fetch), paymentsModule, current, record, "allocate", { invoiceId: creditNoteRecord.id }, options)
    assert.equal(unpicked.kind, "refused", "a credit note is matched by nobody")
    assert.equal(calls.length, 3)
  })
})

describe("the reads a payments surface asks", () => {
  test("sends a statement's lines as the browser read them, without the key the server computes", async () => {
    const file = bankFileOf("booked_on;amount;currency;reference;text\n2026-10-12;625,00;DKK;+71<000000260071881+85123456<;Østerbro Housing")
    const result = { dryRun: true, lines: [{ row: 2, outcome: "matched", paymentId: null, invoiceId: invoice.id, allocatedMinor: 53313, by: "reference" }], counts: { matched: 1, unmatched: 0, duplicate: 0 } }
    const { fetch, calls } = scripted([() => json(result)])
    const lines = wireLinesOf(file)
    const answer = await importBankLines(clientOver(fetch), { projectId: copenhagen.id, dryRun: true, lines })
    assert.equal(calls[0].url, "http://api.test/payments/bank-lines")
    assert.ok(BankLines.safeParse(bodyOf(calls[0])).success, "the body is the contract's: no key")
    assert.equal(answer.counts.matched, 1)
  })

  test("reads a customer's statement over a window in one currency", async () => {
    const { fetch, calls } = scripted([() => json({ customerId: osterbro.id, currency: "DKK", from: "2026-10-01", to: "2026-10-31", openingBalanceMinor: 0, lines: [], closingBalanceMinor: 0 })])
    await customerStatement(clientOver(fetch), osterbro.id, { currency: "DKK", from: "2026-10-01", to: "2026-10-31" })
    assert.equal(calls[0].url, `http://api.test/customers/${osterbro.id}/statement?currency=DKK&from=2026-10-01&to=2026-10-31`)
  })
})
