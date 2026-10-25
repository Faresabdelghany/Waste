// Payments and reconciliation on the wire (#291 C6): a payment registered by
// hand pays the invoice it names, what that invoice owes at most, the rest a
// credit on the payer's balance; the office matches an unmatched payment and
// undoes a wrong match by its reversal; a bank statement's lines are matched
// by an invoice's FIK reference or by the one label their text names, a line
// imported twice is one payment, and what matches nothing lands unmatched in
// the project named. An invoice reads open, partially paid, paid or overdue
// from its allocations on the project's day, and a customer's statement runs
// from an opening balance to a closing one.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillingRunDetail } from "@waste/contracts/billing"
import { Invoice, InvoiceDetail } from "@waste/contracts/invoices"
import { BankLinesResult, CustomerStatement, PaymentDetail } from "@waste/contracts/payments"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { withCompany } from "@waste/db/tenant"
import { bankFileOf } from "@waste/domain/finance/payments"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { A_REVERSAL_IS_NOT_REVERSED, ALREADY_REVERSED, NOT_AN_INVOICE_OF_THE_PROJECT, NOT_THE_PAYER, owesOnly, remainsOnly } from "../routes/payments"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the payments, invoices and lines, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** Noon on the fixtures' Monday: "today" on Copenhagen's clock is 2026-10-05. */
const NOON = new Date("2026-10-05T12:00:00Z")
const TODAY = "2026-10-05"

describe("payments and reconciliation (#291 C6)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fx: BillingFixtures
  let olivia: Call
  let later: Call
  let viewer: Call
  let copenhagen: string
  let harbor: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    harbor = a.projects.harbor.id
    const ex = await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a)))
    fx = await seedBilling(pool, a, ex)
    await withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(product).set({ vatPercent: 25 }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.harborBulky.id))))
    olivia = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON }), keys, a.users.olivia, a.companyId)
    // Six weeks on: every invoice issued today is past its due day.
    later = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => new Date("2026-11-16T12:00:00Z") }), keys, a.users.olivia, a.companyId)
    viewer = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON }), keys, a.users.viewer, a.companyId)
    // Copenhagen Central's invoices carry a FI card's reference.
    await ok(await olivia("/company", { method: "PATCH", body: { fikCreditorNumber: "85123456" } }))
    await ok(await olivia(`/projects/${copenhagen}`, { method: "PATCH", body: { paymentReferenceScheme: "fik-71" } }))
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  async function ok(response: Response, status = 200): Promise<Response> {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return response
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const invoiceRead = async (call: Call, id: string) => InvoiceDetail.parse(await (await ok(await call(`/invoices/${id}`))).json())

  /** One invoice of the project for one job priced by hand today: the payer's run document. */
  async function invoiced(projectId: string, agreementId: string, productId: string, unitPriceMinor = 40_000): Promise<Invoice> {
    await ok(await olivia("/billable-events", { method: "POST", body: { projectId, agreementId, productId, quantity: 1, serviceDate: TODAY, unitPriceMinor, overrideReason: "Agreed by phone" } }), 201)
    const run = await created(olivia, "/billing-runs", await olivia("/billing-runs", { method: "POST", body: { projectId, periodFrom: TODAY, periodTo: TODAY } }), BillingRunDetail)
    assert.equal(run.invoiceIds.length, 1, "one payer, one document")
    return await invoiceRead(olivia, run.invoiceIds[0])
  }

  test("a payment registered by hand pays the invoice it names, what the invoice owes at most, and the rest stays a credit; the invoice reads partially paid, then paid", async () => {
    const invoice = await invoiced(copenhagen, fx.agreements.housingDkk.id, fx.products.residual.id)
    assert.deepEqual([invoice.paymentStatus, invoice.paidMinor, invoice.outstandingMinor], ["open", 0, invoice.grossMinor])

    const part = await created(olivia, "/payments", await olivia("/payments", { method: "POST", body: { projectId: copenhagen, amountMinor: 20_000, currency: "DKK", paidOn: TODAY, invoiceId: invoice.id, note: "At the counter" } }), PaymentDetail)
    assert.deepEqual([part.source, part.customerId, part.allocatedMinor, part.unallocatedMinor], ["manual", invoice.customerId, 20_000, 0], "the payer is the invoice's")
    assert.deepEqual(part.allocations.map((allocation) => [allocation.invoiceId, allocation.amountMinor]), [[invoice.id, 20_000]])
    const partly = await invoiceRead(olivia, invoice.id)
    assert.deepEqual([partly.paymentStatus, partly.paidMinor, partly.outstandingMinor], ["partially-paid", 20_000, invoice.grossMinor - 20_000])

    const rest = await created(olivia, "/payments", await olivia("/payments", { method: "POST", body: { projectId: copenhagen, amountMinor: invoice.grossMinor, currency: "DKK", paidOn: TODAY, invoiceId: invoice.id } }), PaymentDetail)
    assert.deepEqual([rest.allocatedMinor, rest.unallocatedMinor], [invoice.grossMinor - 20_000, 20_000], "what the invoice did not owe stays on the payer's balance")
    const paid = await invoiceRead(later, invoice.id)
    assert.deepEqual([paid.paymentStatus, paid.outstandingMinor], ["paid", 0], "paid in full is never overdue")
  })

  test("a registration names an invoice of its project, never a credit note, in its currency, and the invoice's payer if any", async () => {
    const invoice = await invoiced(copenhagen, fx.agreements.anna.id, fx.products.residual.id)
    const body = { projectId: copenhagen, amountMinor: 1_000, currency: "DKK", paidOn: TODAY }
    const path = async (extra: Record<string, unknown>) => (await refused(await olivia("/payments", { method: "POST", body: { ...body, ...extra } }), 400)).errors?.[0]
    assert.deepEqual(await path({ projectId: harbor, invoiceId: invoice.id }), { path: "invoiceId", message: NOT_AN_INVOICE_OF_THE_PROJECT })
    assert.equal((await path({ currency: "EUR", invoiceId: invoice.id }))?.path, "currency")
    assert.deepEqual(await path({ invoiceId: invoice.id, customerId: fx.customers.housing.id }), { path: "customerId", message: NOT_THE_PAYER })
    const credited = InvoiceDetail.parse(await (await ok(await olivia(`/invoices/${invoice.id}/credit-notes`, { method: "POST", body: { reason: "duplicate", lines: "all" } }), 201)).json())
    assert.equal((await path({ invoiceId: credited.id }))?.path, "invoiceId", "a credit note is paid by nobody")
    // Credited in full, it owes nothing.
    assert.deepEqual([(await invoiceRead(later, invoice.id)).paymentStatus], ["credited"])
  })

  test("the office matches an unmatched payment within what it has and what the invoice owes, and undoes a wrong match by its reversal, once", async () => {
    const invoice = await invoiced(copenhagen, fx.agreements.housingDkk.id, fx.products.residual.id)
    const loose = await created(olivia, "/payments", await olivia("/payments", { method: "POST", body: { projectId: copenhagen, amountMinor: 30_000, currency: "DKK", paidOn: TODAY, reference: "Faktura okt" } }), PaymentDetail)
    assert.deepEqual([loose.customerId, loose.allocations.length, loose.unallocatedMinor], [null, 0, 30_000])

    assert.equal((await refused(await olivia(`/payments/${loose.id}/allocations`, { method: "POST", body: { invoiceId: invoice.id, amountMinor: 30_001 } }), 409)).detail, remainsOnly(30_000, "DKK"))
    const matched = PaymentDetail.parse(await (await ok(await olivia(`/payments/${loose.id}/allocations`, { method: "POST", body: { invoiceId: invoice.id, amountMinor: 30_000 } }), 201)).json())
    assert.deepEqual([matched.allocatedMinor, matched.unallocatedMinor], [30_000, 0])
    const [allocation] = matched.allocations

    const second = await created(olivia, "/payments", await olivia("/payments", { method: "POST", body: { projectId: copenhagen, amountMinor: 900_000, currency: "DKK", paidOn: TODAY } }), PaymentDetail)
    const owes = invoice.grossMinor - 30_000
    assert.equal((await refused(await olivia(`/payments/${second.id}/allocations`, { method: "POST", body: { invoiceId: invoice.id, amountMinor: owes + 1 } }), 409)).detail, owesOnly(invoice.label, owes, "DKK"))

    const reversed = PaymentDetail.parse(await (await ok(await olivia(`/payment-allocations/${allocation.id}/reverse`, { method: "POST" }), 201)).json())
    assert.deepEqual(reversed.allocations.map((row) => [row.amountMinor, row.reversesAllocationId]), [[30_000, null], [-30_000, allocation.id]])
    assert.deepEqual([reversed.allocatedMinor, reversed.unallocatedMinor], [0, 30_000])
    assert.equal((await invoiceRead(olivia, invoice.id)).paidMinor, 0, "the invoice owes it again")
    assert.equal((await refused(await olivia(`/payment-allocations/${allocation.id}/reverse`, { method: "POST" }), 409)).detail, ALREADY_REVERSED)
    assert.equal((await refused(await olivia(`/payment-allocations/${reversed.allocations[1].id}/reverse`, { method: "POST" }), 409)).detail, A_REVERSAL_IS_NOT_REVERSED)
  })

  test("a bank statement's lines are matched by FIK reference or by the one label their text names, a dry run writes nothing, a line imported twice is one payment, and the unmatched land in the project named", async () => {
    const byReference = await invoiced(copenhagen, fx.agreements.housingDkk.id, fx.products.residual.id)
    const byLabel = await invoiced(harbor, fx.agreements.harbor.id, fx.products.harborBulky.id)
    assert.ok(byReference.paymentReference !== null, "Copenhagen Central references by FI card")
    const file = bankFileOf(
      [
        "booked_on;amount;currency;reference;text",
        `2026-10-12;${byReference.grossMinor / 100};DKK;+71<${byReference.paymentReference}+85123456<;Østerbro Housing`,
        `2026-10-12;100,00;DKK;;Betaling ${byLabel.label}`,
        "2026-10-12;55,00;DKK;;Nobody we know",
      ].join("\n"),
    )
    assert.deepEqual(file.refusals, [])
    const send = async (dryRun: boolean) => BankLinesResult.parse(await (await ok(await olivia("/payments/bank-lines", { method: "POST", body: { projectId: copenhagen, dryRun, lines: file.lines.map(({ key: _key, ...line }) => line) } }), dryRun ? 200 : 201)).json())

    const dry = await send(true)
    assert.deepEqual(dry.lines.map((line) => [line.outcome, line.invoiceId, line.by, line.paymentId]), [
      ["matched", byReference.id, "reference", null],
      ["matched", byLabel.id, "label", null],
      ["unmatched", null, null, null],
    ])
    assert.equal((await invoiceRead(olivia, byReference.id)).paidMinor, 0, "a dry run writes nothing")

    const run = await send(false)
    assert.deepEqual(run.counts, { matched: 2, unmatched: 1, duplicate: 0 })
    assert.equal((await invoiceRead(olivia, byReference.id)).paymentStatus, "paid")
    assert.equal((await invoiceRead(olivia, byLabel.id)).paidMinor, 10_000)
    const loose = PaymentDetail.parse(await (await ok(await olivia(`/payments/${run.lines[2].paymentId}`))).json())
    assert.deepEqual([loose.projectId, loose.customerId, loose.source, loose.payerText, loose.unallocatedMinor], [copenhagen, null, "bank-file", "Nobody we know", 5_500])
    const harborPayment = PaymentDetail.parse(await (await ok(await olivia(`/payments/${run.lines[1].paymentId}`))).json())
    assert.equal(harborPayment.projectId, harbor, "a matched line is its invoice's project's")

    const again = await send(false)
    assert.deepEqual(again.counts, { matched: 0, unmatched: 0, duplicate: 3 })
    assert.deepEqual(again.lines.map((line) => line.paymentId), run.lines.map((line) => line.paymentId), "each line answered with the payment it already is")
  })

  test("an invoice not paid by its due day reads overdue, and a customer's statement runs from an opening balance through invoices, credit notes and payments to a closing one", async () => {
    const invoice = await invoiced(copenhagen, fx.agreements.anna.id, fx.products.residual.id, 50_000)
    assert.equal((await invoiceRead(later, invoice.id)).paymentStatus, "overdue")
    await created(olivia, "/payments", await olivia("/payments", { method: "POST", body: { projectId: copenhagen, amountMinor: 10_000, currency: "DKK", paidOn: TODAY, invoiceId: invoice.id } }), PaymentDetail)
    assert.equal((await invoiceRead(later, invoice.id)).paymentStatus, "overdue", "a part paid does not keep it in time")

    const statement = CustomerStatement.parse(await (await ok(await olivia(`/customers/${fx.customers.anna.id}/statement?currency=DKK&from=${TODAY}&to=${TODAY}`))).json())
    assert.equal(statement.lines.at(-1)?.balanceMinor, statement.closingBalanceMinor)
    const mine = statement.lines.filter((line) => line.documentId === invoice.id || line.kind === "payment")
    assert.ok(mine.some((line) => line.documentId === invoice.id && line.kind === "invoice" && line.amountMinor === invoice.grossMinor))
    assert.ok(mine.some((line) => line.kind === "payment" && line.amountMinor === -10_000))
    // Every line moves the balance by its amount.
    let balance = statement.openingBalanceMinor
    for (const line of statement.lines) {
      balance += line.amountMinor
      assert.equal(line.balanceMinor, balance)
    }
  })

  test("payments are the payments module's: a role that does not read them is refused", async () => {
    assert.equal((await viewer("/payments")).status, 403)
  })
})
