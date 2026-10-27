// A caught-up event under the run's lock (#447): a run's catch-up chooses
// the earlier events by id before it takes their row locks, so the locked
// reading must be judged again on the row a cancellation committed while the
// run waited. Its own suite and tenant, since it holds a transaction open on
// one connection while another waits on it.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunDetail } from "@waste/contracts/billing"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { billableEvent } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { and, eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { selectBilling } from "../routes/billing-runs"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution } from "./execution-fixtures"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

/** The request's clock, past every period the suite runs. */
const NOON = new Date("2027-02-05T12:00:00Z")

describe("a caught-up event under the run's lock (#447)", { skip: database.skip || owner.skip }, () => {
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
  const manual = (overrides: Record<string, unknown> = {}) => ({ projectId: copenhagen, agreementId: fx.agreements.housingDkk.id, productId: fx.products.residual.id, quantity: 1, serviceDate: fx.day, ...overrides })
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
