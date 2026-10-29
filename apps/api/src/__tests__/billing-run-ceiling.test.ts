import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillingRun, BillingRunDetail, PERIOD_ORDERED } from "@waste/contracts/billing"
import { Page } from "@waste/contracts/pagination"
import { DAY_WINDOW_ORDERED } from "@waste/contracts/queries"
import { type Database, type Tx } from "@waste/db/client"
import { billableEvent, billingRun, invoiceLine } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { and, count, eq, inArray, sql } from "drizzle-orm"

import { newId, type IdMinter } from "../ids"
import { notCancelled } from "../routes/billable-events"
import { BILLING_RUN_MAX_EVENTS, runBilling, type Transact } from "../routes/billing-runs"
import { type BillingFixtures } from "./billing-fixtures"
import { billingRunCalls, NOON, setUpBillingRuns, tearDownBillingRuns, type BillingRunSuite } from "./billing-run-suite"
import { type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { testId, type Tenant } from "./tenant"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures append and the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const RunPage = Page(BillingRun)

// The runs over the seeded events and the held are billing-runs.test.ts, the batches billing-run-batches.test.ts.
describe("the billing run endpoints", { skip: database.skip || owner.skip }, () => {
  let suite: BillingRunSuite
  let pool: Database
  let a: Tenant
  let fx: BillingFixtures
  let olivia: Call
  let viewer: Call
  let lars: Call
  let other: Call
  let ungranted: Call
  let copenhagen: string
  let harbor: string

  before(async () => {
    suite = await setUpBillingRuns(database.url, owner.url)
    ;({ pool, a, fx, olivia, viewer, lars, other, ungranted, copenhagen, harbor } = suite)
  })

  after(() => tearDownBillingRuns(suite))

  const { refused, manual, entered, readEvent, readInvoice, period, run, preview, written, byId } = billingRunCalls(() => suite)

  describe("the ceiling, the lock and the scope", () => {
    test("excludes alone a payer whose own ready events are more than one batch takes, too-many-events, and invoices every other payer; the preview says the same (#329)", async () => {
      assert.equal(BILLING_RUN_MAX_EVENTS, 5_000)
      const day = "2027-01-05"
      const rows = Array.from({ length: BILLING_RUN_MAX_EVENTS + 1 }, () => ({
        id: testId(),
        companyId: a.companyId,
        projectId: copenhagen,
        kind: "manual",
        serviceDate: day,
        agreementId: fx.agreements.anna.id,
        productId: fx.products.residual.id,
        quantity: 1,
        unitPriceMinor: 12_000,
        netMinor: 12_000,
        vatPercent: 25,
        vatMinor: 3_000,
        currency: "DKK",
        priceListRowId: fx.rows.residual.id,
        createdBy: a.users.olivia.id,
      }))
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        for (let start = 0; start < rows.length; start += 500) await tx.insert(billableEvent).values(rows.slice(start, start + 500))
      })
      const housing = await entered(manual({ serviceDate: day }))
      try {
        const january = period("2027-01-01", "2027-01-31")
        const previewed = await preview(january)
        const done = await run(january)
        assert.equal(done.status, "completed")
        assert.deepEqual([done.eventCount, done.invoiceCount], [1, 1], "the housing association's one event, on its one invoice")
        assert.equal((await readInvoice(done.invoiceIds[0])).customerId, fx.customers.housing.id)
        assert.deepEqual(
          done.exclusions.filter((exclusion) => exclusion.reason === "too-many-events").map((exclusion) => [exclusion.customerId, exclusion.eventCount]),
          [[fx.customers.anna.id, BILLING_RUN_MAX_EVENTS + 1]],
          "Anna's 5 001 alone, refused rather than split across invoices",
        )
        assert.deepEqual([previewed.eventCount, previewed.invoiceCount], [1, 1], "the preview answers the run")
        assert.deepEqual(
          previewed.exclusions.filter((exclusion) => exclusion.reason === "too-many-events").map((exclusion) => [exclusion.customerId, exclusion.eventCount]),
          [[fx.customers.anna.id, BILLING_RUN_MAX_EVENTS + 1]],
        )
        assert.equal((await readEvent(housing.id)).status, "invoiced")
        assert.equal((await readEvent(rows[0].id)).status, "ready", "a refused payer's events wait for the office")
      } finally {
        // Out of every later run's reach: no catch-up of a later test finds them.
        await withCompany(pool.db, a.companyId, (tx: Tx) =>
          tx
            .update(billableEvent)
            .set({ cancelledAt: NOON, cancelReason: "other", cancelledBy: a.users.olivia.id })
            .where(inArray(billableEvent.id, rows.map((row) => row.id))),
        )
      }
    })

    test("serialises two runs of one project over one period on the project's lock: the second joins the first while it is under way, or finds only what it left, and each event is invoiced once", async () => {
      const day = "2026-11-02"
      const housing = await entered(manual({ serviceDate: day }))
      const anna = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))
      const [first, second] = await Promise.all([olivia("/billing-runs", { method: "POST", body: period("2026-11-01", "2026-11-03") }), olivia("/billing-runs", { method: "POST", body: period("2026-11-01", "2026-11-03") })])
      assert.deepEqual([first.status, second.status], [201, 201])
      const runs = new Map([BillingRunDetail.parse(await first.json()), BillingRunDetail.parse(await second.json())].map((done) => [done.id, done]))
      assert.equal([...runs.values()].reduce((sum, done) => sum + done.invoiceCount, 0), 2, "both invoices, once: one run, or one and an empty one")
      assert.deepEqual([(await readEvent(housing.id)).status, (await readEvent(anna.id)).status], ["invoiced", "invoiced"])
    })

    test("locks the events it invoices: a cancellation sent while a batch holds them waits for the batch and is then refused as invoiced, so no event is both invoiced and cancelled", async () => {
      // The batch is held open after its work and before its commit — the project locked, the ready events read `for update`, the invoice written and not yet visible (READ COMMITTED) — through the opener the run is handed, so a cancellation that found the row unlocked would stamp `cancelled_at` on an event the batch has invoiced, a line the customer pays for a row the office thinks is gone. With the lock the cancellation waits: the batch commits only once Postgres reports the cancellation blocked behind it (`pg_blocking_pids`, the driver suite's precedent), and the cancellation then reads the line the batch wrote.
      const day = "2026-12-07"
      const event = await entered(manual({ serviceDate: day }))
      assert.equal(event.status, "ready")
      const proceed = Promise.withResolvers<void>()
      const selected = Promise.withResolvers<number>()
      let calls = 0
      const holding: Transact = (work) =>
        withCompany(pool.db, a.companyId, async (tx: Tx) => {
          const call = ++calls
          const answer = await work(tx)
          // The first batch is the second transaction, after the start.
          if (call === 2) {
            const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
            selected.resolve(pid)
            await proceed.promise
          }
          return answer
        })
      const running = runBilling(holding, { companyId: a.companyId, projectId: copenhagen, periodFrom: day, periodTo: day, note: null, requestedBy: a.users.olivia.id, newId, now: () => NOON })
      /** Rejects if the run ends before it is let go — a statement refused, say — so a broken run fails the test instead of hanging it on the pid. */
      const endedEarly = running.then(() => Promise.reject(new Error("the run ended before its batch was released")))
      void endedEarly.catch(() => undefined)
      let cancelling: Promise<Response> | undefined
      try {
        const pid = await Promise.race([selected.promise, endedEarly])
        cancelling = olivia(`/billable-events/${event.id}/cancel`, { method: "POST", body: { reason: "not-delivered" } })
        const blocked = async (): Promise<boolean> => (await pool.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`).length > 0
        const deadline = Date.now() + 10_000
        while (!(await blocked())) {
          assert.ok(Date.now() < deadline, "the cancellation never waited on the batch: the selection took no lock on the events")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } finally {
        proceed.resolve()
        await running.catch(() => undefined)
        await cancelling?.catch(() => undefined)
      }
      const done = await running
      assert.ok(cancelling, "the cancellation was sent")
      assert.deepEqual([done.run.eventCount, done.invoiceIds.length], [1, 1], "the run invoiced the event")
      assert.equal((await refused(await cancelling, 409)).detail, notCancelled(event.id, "invoiced"), "the cancellation read the line the batch wrote")
      const charged = await readEvent(event.id)
      assert.deepEqual([charged.status, charged.cancelledAt, charged.cancelReason, charged.invoiceLineId !== null], ["invoiced", null, null, true], "invoiced and never cancelled")
    })

    test("rolls a failed batch back whole: a batch that fails after its first invoice is written leaves no invoice, line, invoice-issued or number of its own, and the run stays requested for the next to finish", async () => {
      // The failure is provoked inside the one batch both payers fit in: a minter that gives out once the batch has minted the first invoice's id and its line's, so the first document has been written when the batch dies, and everything the batch holds has to go with it.
      const day = "2026-12-14"
      const housing = await entered(manual({ serviceDate: day }))
      const anna = await entered(manual({ serviceDate: day, agreementId: fx.agreements.anna.id }))
      const lines = () =>
        withCompany(pool.db, a.companyId, async (tx: Tx) => (await tx.select({ rows: count() }).from(invoiceLine).where(and(eq(invoiceLine.companyId, a.companyId), inArray(invoiceLine.billableEventId, [housing.id, anna.id]))))[0]?.rows ?? 0)
      const before = await written()
      let calls = 0
      let minted = 0
      const counting: Transact = (work) =>
        withCompany(pool.db, a.companyId, (tx: Tx) => {
          calls += 1
          return work(tx)
        })
      const givesOut: IdMinter = () => {
        // The start's (its run's id, and any charge it mints) are spent freely; the batch's third id fails.
        if (calls === 2 && ++minted > 2) throw new Error("the minter gave out")
        return newId()
      }
      await assert.rejects(runBilling(counting, { companyId: a.companyId, projectId: copenhagen, periodFrom: day, periodTo: day, note: null, requestedBy: a.users.olivia.id, newId: givesOut, now: () => NOON }), /the minter gave out/)
      const after = await written()
      assert.deepEqual([after.runs, after.invoices, after.issued, after.next], [before.runs + 1, before.invoices, before.issued, before.next], "the run's row alone stands: no invoice, no invoice-issued, and the counter where it was")
      assert.equal(await lines(), 0, "neither event is on a line")
      const [left] = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.select({ id: billingRun.id, status: billingRun.status }).from(billingRun).where(and(eq(billingRun.companyId, a.companyId), eq(billingRun.periodFrom, day), eq(billingRun.periodTo, day))))
      assert.equal(left.status, "requested", "resumable rather than rolled back whole")
      const done = await run(period(day))
      assert.equal(done.id, left.id, "the next run over the period finishes the one left requested")
      assert.deepEqual([done.status, done.eventCount, done.invoiceCount], ["completed", 2, 2])
      assert.equal(await lines(), 2)
    })

    test("holds the body to the caller's projects and its period to its order, and refuses a member the server owns", async () => {
      const outside = await refused(await viewer("/billing-runs", { method: "POST", body: period("2026-10-01", "2026-10-10", harbor) }), 400)
      assert.deepEqual(outside.errors?.map((error) => error.path), ["projectId"])
      const none = await refused(await lars("/billing-runs", { method: "POST", body: period("2026-10-01", "2026-10-10") }), 400)
      assert.deepEqual(none.errors?.map((error) => error.path), ["projectId"])
      const backwards = await refused(await olivia("/billing-runs", { method: "POST", body: period("2026-10-10", "2026-10-01") }), 400)
      assert.deepEqual(backwards.errors, [{ path: "periodTo", message: PERIOD_ORDERED }])
      const owned = await refused(await olivia("/billing-runs", { method: "POST", body: { ...period("2026-10-01"), status: "completed" } }), 400)
      assert.deepEqual(owned.errors?.map((error) => error.path), ["status"])
      await refused(await ungranted("/billing-runs", { method: "POST", body: period("2026-10-01") }), 403)
    })

    test("lists the runs of the caller's projects by status and by a window over the period's start, reads one, and is the family's 404 across tenants", async () => {
      const harbors = await run(period("2026-10-01", "2026-10-31", harbor))
      const listed = await olivia("/billing-runs?status=completed&limit=200")
      assert.equal(listed.status, 200)
      const page = RunPage.parse(await listed.json())
      assert.ok(page.items.some((item) => item.id === harbors.id))
      assert.ok(page.items.every((item) => item.status === "completed"))
      assert.deepEqual([...page.items].sort(byId).map((item) => item.id), page.items.map((item) => item.id), "oldest first")

      const viewers = await viewer("/billing-runs?limit=200")
      assert.equal(viewers.status, 200)
      const viewed = RunPage.parse(await viewers.json())
      assert.ok(viewed.items.length > 0 && viewed.items.every((item) => item.projectId === copenhagen), "Copenhagen Central only")
      assert.ok(!viewed.items.some((item) => item.id === harbors.id))
      await refused(await viewer(`/billing-runs/${harbors.id}`), 404)
      await refused(await other(`/billing-runs/${harbors.id}`), 404)
      await refused(await ungranted(`/billing-runs/${harbors.id}`), 403)

      const windowed = await olivia("/billing-runs?from=2026-10-01&to=2026-10-01&limit=200")
      assert.ok(RunPage.parse(await windowed.json()).items.every((item) => item.periodFrom === "2026-10-01"))
      const backwards = await refused(await olivia("/billing-runs?from=2026-10-10&to=2026-10-01"), 400)
      assert.deepEqual(backwards.errors, [{ path: "to", message: DAY_WINDOW_ORDERED }])
      const larsPage = await lars("/billing-runs")
      assert.equal(larsPage.status, 200)
      assert.deepEqual(await larsPage.json(), { items: [], nextCursor: null })
    })
  })

})
