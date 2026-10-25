// The accounting export on the wire (#291 C7): a project's mapping read and
// replaced whole, every account it names one it lists and every product the
// project's; a preview naming the rows the mapping cannot book yet, and the
// export refused while one stands; an export booking each invoice, credit
// note and payment, and the allocation of a payment that named no customer,
// as one balanced voucher on its own day, each once ever, a late row going
// into the next export back-dated; and the file, our CSV, rendered from the
// frozen lines so a download is the same bytes after the mapping changes, or
// Danish SAF-T 2.1 (C7b), refused while the company or the mapping lacks what
// it needs and valid against Erhvervsstyrelsen's schema once they hold it.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AccountingExport, AccountingExportPreview, AccountingSettings, NOT_AN_ACCOUNT } from "@waste/contracts/accounting"
import { BillingRunDetail } from "@waste/contracts/billing"
import { Invoice, InvoiceDetail } from "@waste/contracts/invoices"
import { Page } from "@waste/contracts/pagination"
import { PaymentDetail } from "@waste/contracts/payments"
import { createDb, type Database } from "@waste/db/client"
import { NOTHING_TO_EXPORT } from "@waste/db/commands/accounting-exports"
import { ACCOUNTING_CSV_COLUMNS } from "@waste/domain/finance/accounting"
import { safTGapSentence } from "@waste/domain/finance/saf-t"

import { createApp } from "../app"
import { EXPORT_PERIOD_ENDS_BY_TODAY } from "../routes/accounting"
import { NOT_A_PRODUCT } from "../routes/references"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { safTSchemaUnderTest, schemaErrors } from "./saf-t-schema"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** ERST's schema a SAF-T file is validated against, fetched at its pinned commit. */
const schema = await safTSchemaUnderTest()
const ExportPage = Page(AccountingExport)
/** The owner sweeps the exports, invoices and payments, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** Noon on the fixtures' Monday: "today" on Copenhagen's clock is 2026-10-05. */
const NOON = new Date("2026-10-05T12:00:00Z")
const TODAY = "2026-10-05"

describe("the accounting export (#291 C7)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fx: BillingFixtures
  let olivia: Call
  /** A clock far ahead of every row's day, the database's own recording day among them: what reaches an allocation recorded as this suite runs. */
  let later: Call
  let copenhagen: string
  let harbor: string
  /** The housing association's invoice the gap held back, booked by the first export. */
  let held: Invoice
  /** The euro invoice an unmatched payment was allocated to, and that payment. */
  let euroLabel: string
  let looseId: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    harbor = a.projects.harbor.id
    const ex = await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a)))
    fx = await seedBilling(pool, a, ex)
    olivia = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON }), keys, a.users.olivia, a.companyId)
    later = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => new Date("2099-01-15T12:00:00Z") }), keys, a.users.olivia, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  /** The response, once its status is the one asked; its body read only to say why it is not, since a file is no JSON. */
  async function ok(response: Response, status = 200): Promise<Response> {
    if (response.status !== status) assert.fail(`${response.status}, not ${status}: ${await response.clone().text()}`)
    return response
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  /** One invoice of the project for one job priced by hand today, in the agreement's currency. */
  async function invoiced(agreementId: string, unitPriceMinor: number): Promise<Invoice> {
    await ok(await olivia("/billable-events", { method: "POST", body: { projectId: copenhagen, agreementId, productId: fx.products.residual.id, quantity: 1, serviceDate: TODAY, unitPriceMinor, overrideReason: "Agreed by phone" } }), 201)
    const run = await created(olivia, "/billing-runs", await olivia("/billing-runs", { method: "POST", body: { projectId: copenhagen, periodFrom: TODAY, periodTo: TODAY } }), BillingRunDetail)
    assert.equal(run.invoiceIds.length, 1)
    return InvoiceDetail.parse(await (await ok(await olivia(`/invoices/${run.invoiceIds[0]}`))).json())
  }

  const MAPPING = {
    accounts: [
      { number: "1010", name: "Salg af tømning", standardAccount: "1010" },
      { number: "1020", name: "Salg, øvrigt", standardAccount: null },
      { number: "5600", name: "Debitorer", standardAccount: "5600" },
      { number: "5820", name: "Bank", standardAccount: "5820" },
      { number: "5850", name: "Ubehandlede indbetalinger", standardAccount: null },
      { number: "6800", name: "Salgsmoms", standardAccount: "6800" },
    ],
    receivable: "5600",
    bank: "5820",
    suspense: "5850",
    revenue: "1020",
    exportsFrom: null,
    vatCodes: [{ vatPercent: 25, code: "U25", account: "6800", standardTaxCode: null as string | null }],
    productAccounts: [] as { productId: string; account: string }[],
  }
  const putMapping = (body: Record<string, unknown>, call: Call = olivia) => call("/accounting-settings", { method: "PUT", body: { projectId: copenhagen, ...MAPPING, ...body } })
  const exportBody = (periodFrom: string, periodTo: string) => ({ projectId: copenhagen, periodFrom, periodTo })
  /** The file as rows of fields: the byte-order mark off, the CRLF ends split, the last empty row dropped. */
  /** The file's bytes, which a Response's text() would strip the byte-order mark from. */
  const bytesOf = async (response: Response): Promise<Buffer> => Buffer.from(await response.arrayBuffer())
  /** The file as rows of fields: the byte-order mark asserted and dropped, the CRLF ends split, the last empty row dropped. */
  const rowsOf = (bytes: Buffer) => {
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "a byte-order mark")
    return bytes.subarray(3).toString("utf8").split("\r\n").slice(0, -1).map((row) => row.split(";"))
  }

  test("a project never set up reads empty; the mapping is replaced whole and reads back in number order, a product's account by product", async () => {
    const empty = AccountingSettings.parse(await (await ok(await olivia(`/accounting-settings?projectId=${copenhagen}`))).json())
    assert.deepEqual(empty, { projectId: copenhagen, accounts: [], receivable: null, bank: null, suspense: null, revenue: null, exportsFrom: null, vatCodes: [], productAccounts: [] })
    const set = AccountingSettings.parse(await (await ok(await putMapping({ accounts: [...MAPPING.accounts].reverse(), productAccounts: [{ productId: fx.products.residual.id, account: "1010" }] }))).json())
    assert.deepEqual(set.accounts.map((account) => account.number), ["1010", "1020", "5600", "5820", "5850", "6800"])
    assert.deepEqual([set.receivable, set.bank, set.suspense, set.revenue, set.vatCodes, set.productAccounts], ["5600", "5820", "5850", "1020", [{ vatPercent: 25, code: "U25", account: "6800", standardTaxCode: null }], [{ productId: fx.products.residual.id, account: "1010" }]])
    assert.deepEqual(AccountingSettings.parse(await (await ok(await olivia(`/accounting-settings?projectId=${copenhagen}`))).json()), set)
  })

  test("a mapping names each account once, lists every account it names, gives a rate one code, and names the project's products; each refusal at its path", async () => {
    const path = async (body: Record<string, unknown>) => (await refused(await putMapping(body), 400)).errors
    assert.equal((await path({ accounts: [...MAPPING.accounts, MAPPING.accounts[0]] }))?.[0]?.path, "accounts")
    assert.deepEqual((await path({ bank: "9999" }))?.[0], { path: "bank", message: NOT_AN_ACCOUNT })
    assert.deepEqual((await path({ vatCodes: [{ vatPercent: 25, code: "U25", account: "9999", standardTaxCode: null }] }))?.[0], { path: "vatCodes.0.account", message: NOT_AN_ACCOUNT })
    assert.equal((await path({ vatCodes: [{ vatPercent: 25, code: "U25", account: "6800", standardTaxCode: null }, { vatPercent: 25, code: "U26", account: "6800", standardTaxCode: null }] }))?.[0]?.path, "vatCodes")
    assert.equal((await path({ accounts: [{ number: "10 10", name: "Spaced", standardAccount: null }], receivable: null, bank: null, suspense: null, revenue: null, vatCodes: [] }))?.[0]?.path, "accounts.0.number")
    assert.deepEqual((await path({ productAccounts: [{ productId: fx.products.harborBulky.id, account: "1010" }] }))?.[0], { path: "productAccounts.0.productId", message: NOT_A_PRODUCT })
    assert.equal((await refused(await olivia("/accounting-settings", { method: "PUT", body: { ...MAPPING, projectId: "01a00000-0000-7000-8000-000000000000" } }), 400)).errors?.[0]?.path, "projectId")
  })

  test("a preview names every row the mapping cannot book with the sentence saying what to set up, and the export is refused with it while it stands", async () => {
    await ok(await putMapping({ vatCodes: [] }))
    const invoice = await invoiced(fx.agreements.housingDkk.id, 40_000)
    held = invoice
    const preview = AccountingExportPreview.parse(await (await ok(await olivia("/accounting-exports/preview", { method: "POST", body: exportBody(TODAY, TODAY) }))).json())
    assert.deepEqual(preview.gaps, [{ kind: "invoice", sourceId: invoice.id, document: invoice.label, sentence: "No VAT code is set up for 25 % VAT" }])
    assert.equal(preview.voucherCount, 0)
    const problem = await refused(await olivia("/accounting-exports", { method: "POST", body: exportBody(TODAY, TODAY) }), 409)
    assert.equal(problem.detail, `No VAT code is set up for 25 % VAT (${invoice.label}); set it up in Settings › Commercial › Accounting`)
    await ok(await putMapping({ productAccounts: [{ productId: fx.products.residual.id, account: "1010" }] }))
  })

  test("an export books each invoice, credit note and payment, and the allocation of a payment that named no customer, as one balanced voucher on its own day, and its file is our CSV", async () => {
    const credited = await invoiced(fx.agreements.anna.id, 20_000)
    const creditNote = await created(olivia, `/invoices/${credited.id}/credit-notes`, await olivia(`/invoices/${credited.id}/credit-notes`, { method: "POST", body: { reason: "duplicate", lines: "all" } }), InvoiceDetail, "/invoices")
    const euro = await invoiced(fx.agreements.housingEur.id, 1_600)
    const first = held
    const paid = await created(olivia, "/payments", await olivia("/payments", { method: "POST", body: { projectId: copenhagen, amountMinor: first.grossMinor, currency: "DKK", paidOn: TODAY, invoiceId: first.id } }), PaymentDetail)
    const loose = await created(olivia, "/payments", await olivia("/payments", { method: "POST", body: { projectId: copenhagen, amountMinor: euro.grossMinor, currency: "EUR", paidOn: TODAY, reference: "Faktura okt" } }), PaymentDetail)
    await ok(await olivia(`/payments/${loose.id}/allocations`, { method: "POST", body: { invoiceId: euro.id, amountMinor: euro.grossMinor } }), 201)
    euroLabel = euro.label
    looseId = loose.id

    // The match is booked on the day the database recorded it, which is after the period this clock is pinned to: a later export takes it.
    const preview = AccountingExportPreview.parse(await (await ok(await olivia("/accounting-exports/preview", { method: "POST", body: exportBody(TODAY, TODAY) }))).json())
    assert.deepEqual([preview.voucherCount, preview.byKind, preview.gaps, preview.backDatedCount], [6, { invoice: 3, "credit-note": 1, payment: 2, allocation: 0 }, [], 0], "the held invoice, Anna's and the euro one, the credit note and the two payments")
    const done = await created(olivia, "/accounting-exports", await olivia("/accounting-exports", { method: "POST", body: { ...exportBody(TODAY, TODAY), note: "October's first" } }), AccountingExport)
    assert.deepEqual([done.voucherFrom, done.voucherTo, done.voucherCount, done.byKind, done.backDatedCount, done.note], [1, 6, 6, { invoice: 3, "credit-note": 1, payment: 2, allocation: 0 }, 0, "October's first"])
    assert.deepEqual(done.totals.map((total) => total.currency), ["DKK", "EUR"])
    assert.deepEqual(AccountingExport.parse(await (await ok(await olivia(`/accounting-exports/${done.id}`))).json()), done)

    const file = await ok(await olivia(`/accounting-exports/${done.id}/file`))
    assert.equal(file.headers.get("content-type"), "text/csv; charset=utf-8")
    assert.match(file.headers.get("content-disposition") ?? "", /^attachment; filename="accounting-2026-10-05-2026-10-05-1-6\.csv"$/)
    const csv = await bytesOf(file)
    const [header, ...rows] = rowsOf(csv)
    assert.deepEqual(header, [...ACCOUNTING_CSV_COLUMNS])
    // Every voucher balances, in its own currency.
    const amount = (text: string) => Math.round(Number(text.replace(",", ".")) * 100)
    for (const voucher of new Set(rows.map((row) => row[0]))) assert.equal(rows.filter((row) => row[0] === voucher).reduce((sum, row) => sum + amount(row[5]), 0), 0, `voucher ${voucher}`)
    const bySource = (id: string) => rows.filter((row) => row[11] === id)
    assert.deepEqual(bySource(first.id).map((row) => [row[2], row[6], row[7]]), [["5600", "", "DKK"], ["1010", "U25", "DKK"], ["6800", "U25", "DKK"]], "receivables, the product's own revenue account, the VAT")
    assert.deepEqual(bySource(creditNote.id).map((row) => [row[2], amount(row[5]) < 0 ? "credit" : "debit"]), [["5600", "credit"], ["1010", "debit"], ["6800", "debit"]], "a credit note turns every sign")
    assert.equal(bySource(creditNote.id)[0][4], `${creditNote.label} ${bySource(creditNote.id)[0][8]} (credits ${credited.label})`, "its text names the invoice it credits")
    assert.deepEqual(bySource(paid.id).map((row) => row[2]), ["5820", "5600"], "a customer's payment: the bank and receivables")
    assert.deepEqual(bySource(loose.id).map((row) => [row[2], row[7]]), [["5820", "EUR"], ["5850", "EUR"]], "a payment that named no customer waits on the unmatched payments account, in its own currency")

    // The mapping renamed: the file is rendered from the lines as they were frozen.
    await ok(await putMapping({ accounts: MAPPING.accounts.map((account) => ({ ...account, name: `${account.name} (renamed)` })), productAccounts: [{ productId: fx.products.residual.id, account: "1010" }] }))
    assert.equal((await bytesOf(await ok(await olivia(`/accounting-exports/${done.id}/file`)))).toString("base64"), csv.toString("base64"), "the same bytes")
  })

  test("a row is exported once: the period again books nothing, and what arrived since — a payment registered later and dated in it, the unmatched payment's match — goes into the next export on its own day, back-dated, numbered on", async () => {
    const problem = await refused(await olivia("/accounting-exports", { method: "POST", body: exportBody(TODAY, TODAY) }), 409)
    assert.equal(problem.detail, NOTHING_TO_EXPORT)
    const late = await created(later, "/payments", await later("/payments", { method: "POST", body: { projectId: copenhagen, amountMinor: 5_000, currency: "DKK", paidOn: TODAY, customerId: fx.customers.anna.id } }), PaymentDetail)
    const next = await created(later, "/accounting-exports", await later("/accounting-exports", { method: "POST", body: exportBody("2099-01-01", "2099-01-15") }), AccountingExport)
    assert.deepEqual([next.voucherFrom, next.voucherTo, next.byKind, next.backDatedCount], [7, 8, { invoice: 0, "credit-note": 0, payment: 1, allocation: 1 }, 2])
    const [, ...rows] = rowsOf(await bytesOf(await ok(await later(`/accounting-exports/${next.id}/file`))))
    assert.deepEqual(rows.map((row) => [row[0], row[2], row[10]]), [["7", "5820", "payment"], ["7", "5600", "payment"], ["8", "5850", "allocation"], ["8", "5600", "allocation"]], "the late payment on its own day first, then the match: from unmatched payments to receivables")
    assert.deepEqual([rows[0][1], rows[0][11]], [TODAY, late.id], "the payment on the day it was paid")
    assert.deepEqual([rows[2][9], rows[2][7]], [euroLabel, "EUR"], "the match names the invoice it pays, in its currency")
    assert.ok(rows.every((row) => row[11] !== looseId), "the unmatched payment itself was booked by the first export")
    const page = ExportPage.parse(await (await ok(await later(`/accounting-exports?projectId=${copenhagen}`))).json())
    assert.deepEqual(page.items.map((item) => item.voucherFrom), [1, 7])
  })

  test("a period ending after the project's today is refused at periodTo, an export of a project this account does not work in reads as none, and the file is our CSV or SAF-T alone", async () => {
    for (const path of ["/accounting-exports/preview", "/accounting-exports"]) {
      assert.deepEqual((await refused(await olivia(path, { method: "POST", body: exportBody(TODAY, "2026-10-06") }), 400)).errors, [{ path: "periodTo", message: EXPORT_PERIOD_ENDS_BY_TODAY }], path)
    }
    const [one] = ExportPage.parse(await (await ok(await olivia(`/accounting-exports?projectId=${copenhagen}`))).json()).items
    assert.equal((await refused(await olivia(`/accounting-exports/${one.id}/file?format=xml`), 400)).errors?.[0]?.path, "format")
    await refused(await olivia("/accounting-exports/01a00000-0000-7000-8000-000000000001"), 404)
    assert.deepEqual(ExportPage.parse(await (await ok(await olivia(`/accounting-exports?projectId=${harbor}`))).json()).items, [], "Harbor Commercial exported nothing")
  })

  test("the file is Danish SAF-T 2.1 too, made on the project's today: refused while the company or the mapping lacks what it needs, then valid against ERST's schema, the euro vouchers left out and named (C7b)", { skip: schema.skip }, async () => {
    const [first] = ExportPage.parse(await (await ok(await olivia(`/accounting-exports?projectId=${copenhagen}`))).json()).items
    const saft = () => olivia(`/accounting-exports/${first.id}/file?format=saf-t`)
    assert.equal((await refused(await saft(), 409)).detail, safTGapSentence({ company: "address" }))
    await ok(await olivia("/company", { method: "PATCH", body: { postalAddress: "Havnegade 4\n2100 København Ø", vatNumber: "DK12345678" } }))
    assert.equal((await refused(await saft(), 409)).detail, safTGapSentence({ company: "bank" }))
    await ok(await olivia("/company", { method: "PATCH", body: { bankIban: "DK5000400440116243", bankBic: "DABADKKK" } }))

    // The mapping as it now stands types the accounts and gives their standard numbers.
    const productAccounts = [{ productId: fx.products.residual.id, account: "1010" }]
    await ok(await putMapping({ productAccounts, accounts: MAPPING.accounts.map((account) => (account.number === "6800" ? { ...account, standardAccount: null } : account)) }))
    assert.equal((await refused(await saft(), 409)).detail, safTGapSentence({ account: "6800", why: "no-standard-account" }))
    await ok(await putMapping({ productAccounts, revenue: "5600" }))
    assert.equal((await refused(await saft(), 409)).detail, safTGapSentence({ account: "5600", why: "two-types" }))
    await ok(await putMapping({ productAccounts, vatCodes: [{ vatPercent: 25, code: "U25", account: "6800", standardTaxCode: "S1" }] }))

    const file = await ok(await saft())
    assert.equal(file.headers.get("content-type"), "application/xml; charset=utf-8")
    assert.match(file.headers.get("content-disposition") ?? "", /^attachment; filename="accounting-2026-10-05-2026-10-05-1-6-saf-t\.xml"$/)
    const xml = await file.text()
    assert.equal(schemaErrors(schema.path, xml), null, "valid against Danish_SAF-T_Financial_Schema_v_2_1.xsd")
    assert.match(xml, /<AuditFileDateCreated>2026-10-05<\/AuditFileDateCreated>/)
    assert.match(xml, /<StreetName>Havnegade<\/StreetName>\s*<Number>4<\/Number>\s*<City>København Ø<\/City>\s*<PostalCode>2100<\/PostalCode>/)
    // The housing association's invoice, Anna's, the credit note and the payment; the euro invoice and the unmatched euro payment left out.
    assert.match(xml, /<NumberOfEntries>4<\/NumberOfEntries>/)
    assert.match(xml, /Left out, in another currency than DKK: vouchers \d+ \(EUR\), \d+ \(EUR\)\.<\/HeaderComment>/)
    assert.deepEqual([...xml.matchAll(/<AccountID>(\d+)<\/AccountID>\s*<AccountDescription>[^<]*<\/AccountDescription>\s*<StandardAccountID>\d+<\/StandardAccountID>\s*<AccountType>(\w+)<\/AccountType>/g)].map((match) => [match[1], match[2]]), [["1010", "Sale"], ["5600", "Asset"], ["5820", "Asset"], ["6800", "Liability"]])
    assert.match(xml, /<TaxCode>U25<\/TaxCode>\s*<StandardTaxCode>S1<\/StandardTaxCode>/)
  })
})
