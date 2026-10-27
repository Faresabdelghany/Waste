// A billing run's catch-up (#447): the ready events from earlier periods a
// completed run already reached — released from a hold, or repriced, after
// their own period's run — taken by the next run exactly once, back twelve
// months, in the room the period's own leave under the ceiling, and judged
// again on the row under the run's lock. A suite of its own, beside the
// billing-run endpoints', so each file stays inside the runner's timeout.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunDetail, BillingRunPreview } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { product } from "@waste/db/schema/catalogue"
import { outboxEvent } from "@waste/db/schema/execution"
import { billableEvent, billingRun, invoice } from "@waste/db/schema/finance"
import { company } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { and, count, eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { BILLING_RUN_MAX_EVENTS, selectBilling } from "../routes/billing-runs"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the invoices and lines the runs write, which `wms_api` may not delete. */
const owner = ownerUnderTest()

/** The request's clock: past every period the suite runs, since a run is for a closed period. */
const NOON = new Date("2027-02-05T12:00:00Z")

describe("a billing run's catch-up (#447)", { skip: database.skip || owner.skip }, () => {
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
  const manual = (overrides: Record<string, unknown> = {}) => ({ projectId: copenhagen, agreementId: fx.agreements.housingDkk.id, productId: fx.products.residual.id, quantity: 1, serviceDate: fx.day, ...overrides })
  const run = async (body: Record<string, unknown>): Promise<BillingRunDetail> => created(olivia, "/billing-runs", await olivia("/billing-runs", { method: "POST", body }), BillingRunDetail)
  const preview = async (body: Record<string, unknown>): Promise<BillingRunPreview> => {
    const response = await olivia("/billing-runs/preview", { method: "POST", body })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillingRunPreview.parse(await response.json())
  }
  const entered = async (body: Record<string, unknown>): Promise<BillableEvent> => {
    const response = await olivia("/billable-events", { method: "POST", body })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }
  const readEvent = async (id: string): Promise<BillableEvent> => {
    const response = await olivia(`/billable-events/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }
  const readInvoice = async (id: string): Promise<InvoiceDetail> => {
    const response = await olivia(`/invoices/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return InvoiceDetail.parse(await response.json())
  }
  /** What the company has written so far — runs, invoices, invoice events and the counter — to prove a preview writes nothing. */
  const written = () =>
    withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const [runs] = await tx.select({ rows: count() }).from(billingRun).where(eq(billingRun.companyId, a.companyId))
      const [invoices] = await tx.select({ rows: count() }).from(invoice).where(eq(invoice.companyId, a.companyId))
      const [issued] = await tx.select({ rows: count() }).from(outboxEvent).where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.kind, "invoice-issued")))
      const [counter] = await tx.select({ next: company.nextInvoiceNumber }).from(company).where(eq(company.id, a.companyId))
      return { runs: runs?.rows ?? 0, invoices: invoices?.rows ?? 0, issued: issued?.rows ?? 0, next: counter?.next }
    })

  test("takes an event released from a hold and one repriced after their month's run into the next month's run, each exactly once, and the preview lists them as catch-up lines", async () => {
    const july = period("2026-07-01", "2026-07-31")
    const august = period("2026-08-01", "2026-08-31")
    const own = await entered(manual({ serviceDate: "2026-07-01" }))
    const held = await entered(manual({ agreementId: fx.agreements.anna.id, serviceDate: "2026-07-14" }))
    assert.equal((await olivia(`/billable-events/${held.id}/hold`, { method: "POST", body: { reason: "Checked with the customer" } })).status, 200)
    const blocked = await entered(manual({ productId: fx.products.bulky.id, serviceDate: "2026-07-15" }))
    assert.deepEqual([blocked.status, blocked.blockReason], ["blocked", "no-vat-rate"])

    const first = await run(july)
    assert.deepEqual([first.eventCount, first.invoiceCount], [1, 1], "July's run takes its one ready event and passes over the held and the blocked")
    assert.equal((await readEvent(own.id)).status, "invoiced")

    // After July's run: the hold released, the bulky product given its rate and the event repriced.
    assert.equal((await olivia(`/billable-events/${held.id}/release`, { method: "POST", body: {} })).status, 200)
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.update(product).set({ vatPercent: 25 }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.bulky.id)))
    })
    try {
      const repriced = await olivia(`/billable-events/${blocked.id}/reprice`, { method: "POST", body: {} })
      assert.equal(repriced.status, 200, JSON.stringify(await repriced.clone().json()))
      assert.equal(BillableEvent.parse(await repriced.json()).status, "ready")
    } finally {
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.update(product).set({ vatPercent: null }).where(and(eq(product.companyId, a.companyId), eq(product.id, fx.products.bulky.id)))
      })
    }
    const ownAugust = await entered(manual({ agreementId: fx.agreements.anna.id, serviceDate: "2026-08-03" }))

    const before = await written()
    const previewed = await preview(august)
    assert.deepEqual(await written(), before, "a preview writes nothing")
    assert.deepEqual([previewed.eventCount, previewed.invoiceCount, previewed.catchUpDeferredCount], [3, 2, 0])
    assert.deepEqual(previewed.catchUp, [
      { billableEventId: held.id, kind: "manual", customerId: fx.customers.anna.id, description: "Restaffald 240 L · 2026-07-14", serviceDate: "2026-07-14", currency: "DKK", netMinor: 12_000, vatMinor: 3_000 },
      { billableEventId: blocked.id, kind: "manual", customerId: fx.customers.housing.id, description: "Bulky pickup · 2026-07-15", serviceDate: "2026-07-15", currency: "DKK", netMinor: 35_000, vatMinor: 8_750 },
    ])
    assert.deepEqual(previewed.totals, [{ currency: "DKK", netMinor: 12_000 + 35_000 + 12_000, vatMinor: 3_000 + 8_750 + 3_000 }], "the caught up count in the totals")

    const second = await run(august)
    assert.deepEqual([second.eventCount, second.invoiceCount, second.netMinor], [3, 2, 59_000])
    const invoices = await Promise.all(second.invoiceIds.map((id) => readInvoice(id)))
    const lines = invoices.flatMap((issued) => issued.lines.map((line) => [issued.customerId, line.billableEventId, line.serviceDate]))
    assert.deepEqual(
      lines.sort(),
      [
        [fx.customers.anna.id, held.id, "2026-07-14"],
        [fx.customers.anna.id, ownAugust.id, "2026-08-03"],
        [fx.customers.housing.id, blocked.id, "2026-07-15"],
      ].sort(),
      "each on its payer's invoice beside the month's own",
    )
    for (const event of [held, blocked, ownAugust]) assert.equal((await readEvent(event.id)).status, "invoiced")

    const september = await run(period("2026-09-01", "2026-09-30"))
    assert.deepEqual([september.eventCount, september.invoiceCount], [0, 0], "the next month's run finds them invoiced")
    const again = await run(august)
    assert.deepEqual([again.eventCount, again.invoiceCount], [0, 0], "and so does a second run over August")
    assert.deepEqual((await preview(period("2026-09-01", "2026-09-30"))).catchUp, [])
  })

  test("leaves an event whose period no run has covered for that period's own run: a later run does not reach back for it", async () => {
    const event = await entered(manual({ agreementId: fx.agreements.anna.id, serviceDate: "2026-05-12" }))
    assert.ok(!(await preview(period("2026-06-01", "2026-06-05"))).catchUp.some((line) => line.billableEventId === event.id), "May has had no run")
    const may = await run(period("2026-05-01", "2026-05-31"))
    assert.equal(may.eventCount, 1, "May's own run invoices it")
    assert.equal((await readEvent(event.id)).status, "invoiced")
  })

  test("reaches back twelve months from the period's first day and no further", async () => {
    await run(period("2026-01-31", "2026-02-01"))
    const inside = await entered(manual({ serviceDate: "2026-02-01" }))
    const outside = await entered(manual({ serviceDate: "2026-01-31" }))
    try {
      const caughtUp = (await preview(period("2027-02-01", "2027-02-05"))).catchUp.map((line) => line.billableEventId)
      assert.ok(caughtUp.includes(inside.id), "twelve months before 2027-02-01 is 2026-02-01, the window's first day")
      assert.ok(!caughtUp.includes(outside.id), "the day before it is past the reach")
    } finally {
      for (const event of [inside, outside]) assert.equal((await olivia(`/billable-events/${event.id}/cancel`, { method: "POST", body: { reason: "duplicate" } })).status, 200)
    }
  })

  test("takes the catch-up only in the room the period's own leave under the ceiling, oldest first, and counts the rest it leaves", async () => {
    const day = "2026-04-14"
    await run(period(day))
    const earlier = await Promise.all([1, 2, 3].map(() => entered(manual({ serviceDate: day }))))
    const scope = { companyId: a.companyId, projectId: copenhagen }
    // The period's own as many as leave room for two: the preview's planned charges count so, and so does a run's minted ones.
    const selection = await withCompany(pool.db, a.companyId, (tx: Tx) => selectBilling(tx, scope, { periodFrom: "2026-04-20", periodTo: "2026-04-30" }, { reserved: BILLING_RUN_MAX_EVENTS - 2 }))
    const oldest = earlier.map((event) => event.id).sort()
    assert.deepEqual(selection.catchUpIds, oldest.slice(0, 2), "oldest first, one day's by id")
    assert.equal(selection.catchUpDeferredCount, 1)
    assert.deepEqual(selection.events.filter((event) => event.catchUp).map((event) => event.id).sort(), oldest.slice(0, 2))
    // The day's own run takes the three, so no later run here reaches back for them.
    assert.equal((await run(period(day))).eventCount, 3)
  })

  test("judges a caught-up event on the row a cancellation committed while the run waited on its lock: it is not invoiced", async () => {
    // A cancellation holds the event's lock, its `cancelled_at` written and not yet committed, when the run's selection reaches the row: the run waits, and once the cancellation commits Postgres re-reads the run's `where` over the row it wrote. The ids the catch-up chose before the lock are not enough to name it.
    await run(period("2026-06-10"))
    const event = await entered(manual({ serviceDate: "2026-06-10" }))
    const scope = { companyId: a.companyId, projectId: copenhagen }
    const window = { periodFrom: "2026-06-15", periodTo: "2026-06-30" }
    const commit = Promise.withResolvers<void>()
    const written = Promise.withResolvers<number>()
    const cancelling = withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
      await tx.update(billableEvent).set({ cancelledAt: NOON, cancelReason: "duplicate", cancelledBy: a.users.olivia.id }).where(and(eq(billableEvent.companyId, a.companyId), eq(billableEvent.id, event.id)))
      written.resolve(pid)
      await commit.promise
    })
    let selecting: Promise<string[]> | undefined
    try {
      const pid = await written.promise
      selecting = withCompany(pool.db, a.companyId, async (tx: Tx) => (await selectBilling(tx, scope, window, { lock: true })).events.map((ready) => ready.id))
      const blocked = async (): Promise<boolean> => (await pool.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`).length > 0
      const deadline = Date.now() + 10_000
      while (!(await blocked())) {
        assert.ok(Date.now() < deadline, "the selection never waited on the cancellation's lock")
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } finally {
      commit.resolve()
      await cancelling
    }
    assert.ok(selecting, "the selection was made")
    assert.ok(!(await selecting).includes(event.id), "a cancelled event is not caught up")
    assert.equal((await readEvent(event.id)).status, "cancelled")
  })
})
