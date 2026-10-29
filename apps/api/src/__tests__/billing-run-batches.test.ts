import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { type Database, type Tx } from "@waste/db/client"
import { billingRun, invoiceLine } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { and, asc, count, eq, inArray } from "drizzle-orm"

import { newId } from "../ids"
import { nextBatch, runBilling, runUnderWay, type Transact } from "../routes/billing-runs"
import { type BillingFixtures } from "./billing-fixtures"
import { billingRunCalls, NOON, setUpBillingRuns, tearDownBillingRuns, type BillingRunSuite } from "./billing-run-suite"
import { type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { type Tenant } from "./tenant"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()

// The runs over the seeded events and the held are billing-runs.test.ts, the ceiling and the lock billing-run-ceiling.test.ts.
describe("the billing run endpoints", { skip: database.skip || owner.skip }, () => {
  let suite: BillingRunSuite
  let pool: Database
  let a: Tenant
  let fx: BillingFixtures
  let olivia: Call
  let copenhagen: string

  before(async () => {
    suite = await setUpBillingRuns(database.url, owner.url)
    ;({ pool, a, fx, olivia, copenhagen } = suite)
  })

  after(() => tearDownBillingRuns(suite))

  const { refused, manual, entered, readInvoice, period } = billingRunCalls(() => suite)

  describe("a batch of payers at a time (#329)", () => {
    /** A run driven directly over one day, its batches as small as a test wants, through the opener it is handed. */
    const direct = (day: string, { transact, batchMax, staleAfterMs, periodTo = day }: { transact?: Transact; batchMax?: number; staleAfterMs?: number; periodTo?: string } = {}) =>
      runBilling(transact ?? ((work) => withCompany(pool.db, a.companyId, work)), { companyId: a.companyId, projectId: copenhagen, periodFrom: day, periodTo, note: null, requestedBy: a.users.olivia.id, newId, now: () => NOON, batchMax, staleAfterMs })
    /** An opener that dies at its `n`th transaction, before it opens: the process killed between two batches, which writes nothing more, not even a failed status. */
    const killedAt = (n: number): Transact => {
      let calls = 0
      return (work) => {
        if (++calls >= n) return Promise.reject(new Error("the process was killed"))
        return withCompany(pool.db, a.companyId, work)
      }
    }
    /** How many lines name each event, by event: once each is the rule a resumed run keeps. */
    const linesOf = (ids: readonly string[]) =>
      withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const rows = await tx.select({ id: invoiceLine.billableEventId, lines: count() }).from(invoiceLine).where(and(eq(invoiceLine.companyId, a.companyId), inArray(invoiceLine.billableEventId, [...ids]))).groupBy(invoiceLine.billableEventId)
        return Object.fromEntries(ids.map((id) => [id, rows.find((row) => row.id === id)?.lines ?? 0]))
      })
    const runRow = (id: string) => withCompany(pool.db, a.companyId, async (tx: Tx) => (await tx.select().from(billingRun).where(and(eq(billingRun.companyId, a.companyId), eq(billingRun.id, id))))[0])
    const runOver = (day: string) => withCompany(pool.db, a.companyId, async (tx: Tx) => (await tx.select().from(billingRun).where(and(eq(billingRun.companyId, a.companyId), eq(billingRun.periodFrom, day))).orderBy(asc(billingRun.id))).at(-1))

    test("plans a batch of the payers whose own events fit together, in id order, never an empty one while a payer is left, and refuses alone a payer above any batch", () => {
      const payers = [
        { customerId: "a", own: 2 },
        { customerId: "b", own: 7 },
        { customerId: "c", own: 1 },
        { customerId: "d", own: 3 },
      ]
      assert.deepEqual(nextBatch(payers, 3), { payers: ["a", "c"], tooMany: [{ customerId: "b", eventCount: 7 }] }, "b is refused alone and passed, c fits beside a, and the batch stops at d, the first that does not")
      assert.deepEqual(nextBatch(payers.slice(3), 3), { payers: ["d"], tooMany: [] }, "the next batch takes d")
      assert.deepEqual(nextBatch(payers, 20), { payers: ["a", "b", "c", "d"], tooMany: [] })
      assert.deepEqual(nextBatch([{ customerId: "z", own: 0 }], 3), { payers: ["z"], tooMany: [] }, "a payer with only events to catch up")
      assert.deepEqual(nextBatch([], 3), { payers: [], tooMany: [] })
    })

    test("issues each payer's invoice in its own batch where the payers do not fit one, numbered on, and completes the run with its counts and totals", async () => {
      const day = "2027-02-01"
      const events = [await entered(manual({ serviceDate: day })), await entered(manual({ serviceDate: day })), await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))]
      let transactions = 0
      const done = await direct(day, { batchMax: 2, transact: (work) => withCompany(pool.db, a.companyId, (tx: Tx) => ((transactions += 1), work(tx))) })
      assert.equal(transactions, 5, "the start, two batches, the batch that finds nobody left, and the finish")
      assert.deepEqual([done.run.status, done.run.eventCount, done.run.invoiceCount], ["completed", 3, 2])
      const issued = await Promise.all(done.invoiceIds.map((id) => readInvoice(id)))
      assert.deepEqual(issued.map((document) => document.lines.length).sort(), [1, 2])
      assert.equal(done.run.netMinor, issued.reduce((sum, document) => sum + document.netMinor, 0), "the totals read off the run's invoices")
      assert.deepEqual(Object.values(await linesOf(events.map((event) => event.id))), [1, 1, 1])
    })

    test("resumes a run killed between two batches where it stopped: the next run over the period finishes the same run, and no event is invoiced twice", async () => {
      const day = "2027-02-02"
      const events = [await entered(manual({ serviceDate: day })), await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))]
      // The start is the first transaction and the first batch the second: killed at the third, one payer is invoiced and the other is not.
      await assert.rejects(direct(day, { batchMax: 1, transact: killedAt(3) }), /the process was killed/)
      const left = await runOver(day)
      assert.ok(left)
      assert.deepEqual([left.status, left.invoiceCount, left.completedAt], ["requested", 1, null], "the first batch stands, its row touched with it")
      assert.deepEqual(Object.values(await linesOf(events.map((event) => event.id))).sort(), [0, 1])
      // Killed again, at the resumed run's start, then once more after its one batch: nothing a dead process left is redone.
      await assert.rejects(direct(day, { batchMax: 1, transact: killedAt(1) }), /the process was killed/)
      await assert.rejects(direct(day, { batchMax: 1, transact: killedAt(3) }), /the process was killed/)
      const resumed = await direct(day, { batchMax: 1 })
      assert.equal(resumed.run.id, left.id, "the same run, resumed")
      assert.deepEqual([resumed.run.status, resumed.run.eventCount, resumed.run.invoiceCount], ["completed", 2, 2])
      assert.deepEqual(Object.values(await linesOf(events.map((event) => event.id))), [1, 1], "each event on exactly one line")
      const customers = (await Promise.all(resumed.invoiceIds.map((id) => readInvoice(id)))).map((document) => document.customerId).sort()
      assert.deepEqual(customers, [fx.customers.anna.id, fx.customers.housing.id].sort(), "one invoice per payer, never a second")
      assert.deepEqual((await direct(day)).run.invoiceCount, 0, "a later run over the period finds nothing left")
    })

    test("refuses a run while another run of the project, over another period, is under way, and starts once that one is stale, writing it failed with what it issued", async () => {
      const stopped = "2027-01-25"
      const events = [await entered(manual({ serviceDate: stopped })), await entered(manual({ serviceDate: stopped, agreementId: fx.agreements.anna.id }))]
      await assert.rejects(direct(stopped, { batchMax: 1, transact: killedAt(3) }), /the process was killed/)
      const under = await runOver(stopped)
      assert.equal(under?.status, "requested")
      const day = "2027-02-04"
      await entered(manual({ serviceDate: day }))
      const refusal = await refused(await olivia("/billing-runs", { method: "POST", body: period(day) }), 409)
      assert.equal(refusal.detail, runUnderWay({ periodFrom: stopped, periodTo: stopped }))
      const later = await direct(day, { staleAfterMs: 0 })
      assert.equal(later.run.status, "completed")
      const failed = await runRow(under!.id)
      assert.deepEqual([failed.status, failed.invoiceCount, failed.completedAt], ["failed", 1, null], "what the dead run issued stands, and its row says it never finished")
      // Its payer left over is a later run's: by its own period's run again, or a later period's catch-up.
      await direct(stopped)
      assert.deepEqual(Object.values(await linesOf(events.map((event) => event.id))), [1, 1], "each event on exactly one line")
    })
  })
})
