// An invoice's document on the wire (#291 slice 5, #292 C5): `GET
// /invoices/:id/document` answers the PDF the renderer makes of the ledger's
// rows — the same bytes for the same document, under an ETag of their own
// hash — with the parties frozen at issue, so a company that moves after an
// invoice was issued leaves that invoice's document as it was. A credit note
// has one too. The grant is the read's.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { BillingRunDetail } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** Noon on the fixtures' Monday: "today" on Copenhagen's clock is 2026-10-05. */
const NOON = new Date("2026-10-05T12:00:00Z")
const TODAY = "2026-10-05"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("an invoice's document (#291 C5)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let fx: BillingFixtures
  let olivia: Call
  let viewer: Call
  let copenhagen: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    const ex = await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a)))
    fx = await seedBilling(pool, a, ex)
    await withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(product).set({ vatPercent: 25 }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.residual.id))))
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const ok = async (response: Response, status = 200) => {
    assert.equal(response.status, status, response.headers.get("content-type")?.includes("json") ? JSON.stringify(await response.clone().json()) : String(response.status))
    return response
  }

  /** The housing association invoiced for one residual pickup today: the run's one document. */
  const issued = async (): Promise<InvoiceDetail> => {
    await ok(await olivia("/billable-events", { method: "POST", body: { projectId: copenhagen, agreementId: fx.agreements.housingDkk.id, productId: fx.products.residual.id, quantity: 1, serviceDate: TODAY, unitPriceMinor: 40_000, overrideReason: "Agreed by phone" } }), 201)
    const run = await created(olivia, "/billing-runs", await olivia("/billing-runs", { method: "POST", body: { projectId: copenhagen, periodFrom: TODAY, periodTo: TODAY } }), BillingRunDetail)
    assert.equal(run.invoiceIds.length, 1)
    return InvoiceDetail.parse(await (await ok(await olivia(`/invoices/${run.invoiceIds[0]}`))).json())
  }

  const documentOf = async (call: Call, id: string, headers?: Record<string, string>) => await call(`/invoices/${id}/document`, { headers })

  test("is the invoice's PDF, inline under its label, the same bytes every time under an ETag of their hash, a matching ETag answered 304", async () => {
    await ok(await olivia("/company", { method: "PATCH", body: { postalAddress: "Havnegade 4\n2100 København Ø", vatNumber: "DK12345678" } }))
    const invoice = await issued()
    const first = await ok(await documentOf(olivia, invoice.id))
    assert.equal(first.headers.get("content-type"), "application/pdf")
    assert.equal(first.headers.get("content-disposition"), `inline; filename="${invoice.label}.pdf"`)
    const bytes = new Uint8Array(await first.arrayBuffer())
    assert.equal(Buffer.from(bytes.subarray(0, 8)).toString("latin1"), "%PDF-1.7")
    assert.equal(first.headers.get("etag"), `"${sha256(bytes)}"`)

    const again = new Uint8Array(await (await ok(await documentOf(olivia, invoice.id))).arrayBuffer())
    assert.equal(sha256(again), sha256(bytes), "the same document, the same bytes")
    const unchanged = await documentOf(olivia, invoice.id, { "If-None-Match": `"${sha256(bytes)}"` })
    assert.equal(unchanged.status, 304)

    // The company moves after the invoice was issued: the invoice's document is the one it was.
    await ok(await olivia("/company", { method: "PATCH", body: { postalAddress: "Strandvejen 100\n2900 Hellerup" } }))
    const afterMove = new Uint8Array(await (await ok(await documentOf(olivia, invoice.id))).arrayBuffer())
    assert.equal(sha256(afterMove), sha256(bytes), "the parties were frozen at issue")
  })

  test("a credit note has one too, and a document nobody may read is the read's 404 and 403", async () => {
    const invoice = await issued()
    const credited = await ok(await olivia(`/invoices/${invoice.id}/credit-notes`, { method: "POST", body: { reason: "duplicate", lines: "all" } }), 201)
    const note = InvoiceDetail.parse(await credited.json())
    const response = await ok(await documentOf(olivia, note.id))
    assert.equal(response.headers.get("content-disposition"), `inline; filename="${note.label}.pdf"`)
    assert.ok((await response.arrayBuffer()).byteLength > 1_000)

    assert.equal((await documentOf(olivia, "01a0d3a5-e5e0-7000-8000-0000000000ff")).status, 404)
    assert.equal((await documentOf(viewer, invoice.id)).status, 403, "the viewer role does not read invoices")
  })
})
