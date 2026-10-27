// An invoice's lines are written a thousand to a statement (#447): a run's
// invoice may carry up to the run's ceiling of lines, past the 65 534
// parameters one statement binds at fifteen a line. A suite of its own, since
// the rows it writes cost its tenant's removal more than the runner's
// timeout leaves the billing-run endpoints' suite.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillingRunDetail } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { billableEvent } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"

import { createApp } from "../app"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** The request's clock: past the day the suite runs, since a run is for a closed period. */
const NOON = new Date("2027-02-05T12:00:00Z")

describe("an invoice's lines, written in batches (#447)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let fx: BillingFixtures
  let olivia: Call
  let copenhagen: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    const ex = await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a)))
    fx = await seedBilling(pool, a, ex)
    olivia = callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON }), keys, a.users.olivia, a.companyId)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const period = (periodFrom: string, periodTo: string = periodFrom) => ({ projectId: copenhagen, periodFrom, periodTo })
  const run = async (body: Record<string, unknown>): Promise<BillingRunDetail> => created(olivia, "/billing-runs", await olivia("/billing-runs", { method: "POST", body }), BillingRunDetail)
  const readInvoice = async (id: string): Promise<InvoiceDetail> => {
    const response = await olivia(`/invoices/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return InvoiceDetail.parse(await response.json())
  }
  test("writes an invoice's lines a thousand to a statement: one invoice of more lines than that is whole, its positions in order", async () => {
    // A run's invoice may carry up to the ceiling's lines, past the 65 534 parameters one statement binds at fifteen a line; the batches cross the thousand here.
    const day = "2027-01-20"
    const lines = 1_001
    const rows = Array.from({ length: lines }, () => ({ id: testId(), companyId: a.companyId, projectId: copenhagen, kind: "manual", serviceDate: day, agreementId: fx.agreements.anna.id, productId: fx.products.residual.id, quantity: 1, unitPriceMinor: 12_000, netMinor: 12_000, vatPercent: 25, vatMinor: 3_000, currency: "DKK", priceListRowId: fx.rows.residual.id, createdBy: a.users.olivia.id }))
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      for (let start = 0; start < rows.length; start += 500) await tx.insert(billableEvent).values(rows.slice(start, start + 500))
    })
    const done = await run(period(day))
    assert.deepEqual([done.eventCount, done.invoiceCount], [lines, 1])
    const issued = await readInvoice(done.invoiceIds[0])
    assert.deepEqual(issued.lines.map((line) => line.position), Array.from({ length: lines }, (_, index) => index + 1))
    assert.equal(issued.netMinor, lines * 12_000)
  })
})
