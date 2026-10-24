import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillingRunDetail } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { Company, Project } from "@waste/contracts/organisation"
import { Customer } from "@waste/contracts/customers"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { withCompany } from "@waste/db/tenant"
import { paymentReference } from "@waste/domain/finance/payment"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { fikStillReferenced } from "../routes/company"
import { NO_FIK_CREDITOR } from "../routes/projects"
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
/** The owner sweeps the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** Noon on the fixtures' Monday: "today" on Copenhagen's clock is 2026-10-05. */
const NOON = new Date("2026-10-05T12:00:00Z")
const TODAY = "2026-10-05"

describe("finance settings on the wire (#291 C4)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fx: BillingFixtures
  let olivia: Call
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
    // Harbor's bulky pickup gets the rate a person's price needs beside it.
    await withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(product).set({ vatPercent: 25 }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.harborBulky.id))))
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const patched = async <T>(path: string, body: Record<string, unknown>, schema: { parse: (value: unknown) => T }): Promise<T> => {
    const response = await olivia(path, { method: "PATCH", body })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** A person's own price for one bulky job: ready at once, the agreement's payer invoiced. */
  const priced = async (projectId: string, agreementId: string, productId: string) => {
    const response = await olivia("/billable-events", { method: "POST", body: { projectId, agreementId, productId, quantity: 1, serviceDate: TODAY, unitPriceMinor: 40_000, overrideReason: "Agreed by phone" } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
  }
  const run = async (projectId: string): Promise<InvoiceDetail[]> => {
    const done = await created(olivia, "/billing-runs", await olivia("/billing-runs", { method: "POST", body: { projectId, periodFrom: TODAY, periodTo: TODAY } }), BillingRunDetail)
    return await Promise.all(
      done.invoiceIds.map(async (id) => {
        const response = await olivia(`/invoices/${id}`)
        return InvoiceDetail.parse(await response.json())
      }),
    )
  }

  test("the company's invoice identity is the administrator's to set and to clear; a project's terms and scheme are its own, a FI card's needing the creditor number", async () => {
    const identity = { vatNumber: "DK12345678", bankIban: "DK5000400440116243", bankBic: "DABADKKK" }
    assert.deepEqual(await patched("/company", identity, Company).then(({ vatNumber, bankIban, bankBic, fikCreditorNumber }) => ({ vatNumber, bankIban, bankBic, fikCreditorNumber })), { ...identity, fikCreditorNumber: null })

    // No creditor number yet: a FI card's scheme is refused, after the path's own 404.
    assert.equal((await refused(await olivia(`/projects/${copenhagen}`, { method: "PATCH", body: { paymentReferenceScheme: "fik-71" } }), 409)).detail, NO_FIK_CREDITOR)
    assert.equal((await olivia("/projects/01a0d3a5-e5e0-7000-8000-0000000000ff", { method: "PATCH", body: { paymentReferenceScheme: "fik-71" } })).status, 404)
    await patched("/company", { fikCreditorNumber: "85123456" }, Company)
    const set = await patched(`/projects/${copenhagen}`, { paymentTermsDays: 14, paymentReferenceScheme: "fik-71" }, Project)
    assert.deepEqual([set.paymentTermsDays, set.paymentReferenceScheme], [14, "fik-71"])

    // Clearing the number while Copenhagen Central references by it is refused, in its name.
    assert.equal((await refused(await olivia("/company", { method: "PATCH", body: { fikCreditorNumber: null } }), 409)).detail, fikStillReferenced(a.projects.copenhagen.name))
    assert.equal((await refused(await olivia("/company", { method: "PATCH", body: { bankIban: "DK50 0040" } }), 400)).errors?.[0]?.path, "bankIban")
    assert.equal((await refused(await olivia(`/projects/${copenhagen}`, { method: "PATCH", body: { paymentTermsDays: 400 } }), 400)).errors?.[0]?.path, "paymentTermsDays")
  })

  test("a run dates each invoice by its payer's own terms, else the project's, and freezes its reference under the project's scheme; a credit note is due on issue and referenced by nothing", async () => {
    // The housing association pays in eight days; Anna by Copenhagen Central's fourteen.
    const housing = await patched(`/customers/${fx.customers.housing.id}`, { paymentTermsDays: 8 }, Customer)
    assert.equal(housing.paymentTermsDays, 8)
    await priced(copenhagen, fx.agreements.housingDkk.id, fx.products.residual.id)
    await priced(copenhagen, fx.agreements.anna.id, fx.products.residual.id)
    const invoices = await run(copenhagen)
    const byPayer = new Map(invoices.map((document) => [document.customerId, document]))
    const housingInvoice = byPayer.get(fx.customers.housing.id)!
    const annaInvoice = byPayer.get(fx.customers.anna.id)!
    assert.deepEqual([housingInvoice.issuedOn, housingInvoice.dueOn], [TODAY, "2026-10-13"], "eight days, the payer's own")
    assert.deepEqual([annaInvoice.issuedOn, annaInvoice.dueOn], [TODAY, "2026-10-19"], "fourteen days, the project's")
    for (const document of invoices) assert.equal(document.paymentReference, paymentReference("fik-71", document.number), document.label)

    const credited = await olivia(`/invoices/${annaInvoice.id}/credit-notes`, { method: "POST", body: { reason: "duplicate", lines: "all" } })
    assert.equal(credited.status, 201, JSON.stringify(await credited.clone().json()))
    const note = InvoiceDetail.parse(await credited.json())
    assert.deepEqual([note.kind, note.dueOn, note.paymentReference], ["credit-note", note.issuedOn, null])
  })

  test("two projects' first invoices get distinct references under one creditor: the number is the company's one series, whatever project a document is of", async () => {
    await patched(`/projects/${harbor}`, { paymentReferenceScheme: "fik-71" }, Project)
    await priced(harbor, fx.agreements.harbor.id, fx.products.harborBulky.id)
    const [harborFirst] = await run(harbor)
    assert.ok(harborFirst !== undefined, "Harbor's first invoice")
    const copenhagenFirst = (await olivia(`/invoices?projectId=${copenhagen}&kind=invoice`).then(async (response) => (await response.json()) as { items: { number: number; paymentReference: string | null }[] })).items[0]
    assert.ok(copenhagenFirst !== undefined, "Copenhagen Central's first invoice")
    assert.notEqual(harborFirst.paymentReference, copenhagenFirst.paymentReference)
    assert.notEqual(harborFirst.number, copenhagenFirst.number)
    assert.equal(harborFirst.dueOn, "2026-11-04", "Harbor keeps the thirty days a project nobody has set has")
  })
})
