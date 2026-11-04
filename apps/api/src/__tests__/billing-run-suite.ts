import assert from "node:assert/strict"

import { BillableEvent } from "@waste/contracts/billable-events"
import { BillingRunDetail, BillingRunPreview } from "@waste/contracts/billing"
import { InvoiceDetail } from "@waste/contracts/invoices"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { outboxEvent } from "@waste/db/schema/execution"
import { billingRun, invoice } from "@waste/db/schema/finance"
import { company } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { and, asc, count, eq } from "drizzle-orm"

import { createApp } from "../app"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

// The billing run endpoints' suites share one setup: the run's tests are three files (#329), since node's test timeout bounds a whole file and one file of them all outgrew it on CI.

export const MODULE = "commercial.billing"

/** The instant the suite's clock stands at: past every period it runs, since a run is for a closed period (M14 of #293). */
export const NOON = new Date("2027-02-05T12:00:00Z")

export type BillingRunSuite = {
  pool: Database
  ownerPool: Database
  keys: SigningKeys
  a: Tenant
  b: Tenant
  ex: ExecutionFixtures
  fx: BillingFixtures
  app: ReturnType<typeof createApp>
  olivia: Call
  /** The custom role, granted the module, with Project Access to Copenhagen Central only. */
  viewer: Call
  /** The Service Provider Manager, granted the module: a role that reaches no project of the company. */
  lars: Call
  other: Call
  ungranted: Call
  copenhagen: string
  harbor: string
}

/** Two tenants, the first with its fleet, execution and billing fixtures, and the calls the suites make. */
export async function setUpBillingRuns(databaseUrl: string, ownerUrl: string): Promise<BillingRunSuite> {
  const pool = createDb(databaseUrl, { max: 4 })
  const ownerPool = createDb(ownerUrl, { max: 1 })
  const keys = await signingKeys()
  const a = await seedTenant(pool)
  const b = await seedTenant(pool)
  const fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
  const ex = await seedExecution(pool, a, fleet)
  const fx = await seedBilling(pool, a, ex)
  await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create"] }, { moduleKey: "commercial.invoices", actions: ["view"] }])
  await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view", "create"] }])
  const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
  return {
    pool,
    ownerPool,
    keys,
    a,
    b,
    ex,
    fx,
    app,
    olivia: callingAs(app, keys, a.users.olivia, a.companyId),
    viewer: callingAs(app, keys, a.users.viewer, a.companyId),
    lars: callingAs(app, keys, a.users.lars, a.companyId),
    other: callingAs(app, keys, b.users.olivia, b.companyId),
    ungranted: callingAs(app, keys, b.users.viewer, b.companyId),
    copenhagen: a.projects.copenhagen.id,
    harbor: a.projects.harbor.id,
  }
}

export async function tearDownBillingRuns(suite: BillingRunSuite | undefined): Promise<void> {
  if (!suite) return
  await dropTenant(suite.pool, suite.a.companyId, suite.ownerPool)
  await dropTenant(suite.pool, suite.b.companyId, suite.ownerPool)
  await suite.pool.close()
  await suite.ownerPool.close()
}

/** The suites' calls and reads, over the suite `of` answers once its `before` has run. */
export function billingRunCalls(of: () => BillingRunSuite) {
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  const manual = (overrides: Record<string, unknown> = {}) => {
    const { copenhagen, fx } = of()
    return { projectId: copenhagen, agreementId: fx.agreements.housingDkk.id, productId: fx.products.residual.id, quantity: 1, serviceDate: fx.day, ...overrides }
  }

  const entered = async (body: Record<string, unknown>): Promise<BillableEvent> => {
    const response = await of().olivia("/billable-events", { method: "POST", body })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }

  const readEvent = async (id: string): Promise<BillableEvent> => {
    const response = await of().olivia(`/billable-events/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillableEvent.parse(await response.json())
  }

  const readInvoice = async (id: string, call: Call = of().olivia): Promise<InvoiceDetail> => {
    const response = await call(`/invoices/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return InvoiceDetail.parse(await response.json())
  }

  const period = (periodFrom: string, periodTo: string = periodFrom, projectId: string = of().copenhagen) => ({ projectId, periodFrom, periodTo })

  const run = async (body: Record<string, unknown>, call: Call = of().olivia): Promise<BillingRunDetail> => created(call, "/billing-runs", await call("/billing-runs", { method: "POST", body }), BillingRunDetail)

  const preview = async (body: Record<string, unknown>, call: Call = of().olivia): Promise<BillingRunPreview> => {
    const response = await call("/billing-runs/preview", { method: "POST", body })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BillingRunPreview.parse(await response.json())
  }

  /** The outbox rows about one document, oldest first, read as `wms_api` under the fence. */
  const eventsAbout = async (aggregateId: string) => {
    const { pool, a } = of()
    return withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, projectId: outboxEvent.projectId, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )
  }

  /** What the company has written so far: runs, invoices, invoice events, and the counter — to prove a preview and a refused run write nothing. */
  const written = () => {
    const { pool, a } = of()
    return withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const [runs] = await tx.select({ rows: count() }).from(billingRun).where(eq(billingRun.companyId, a.companyId))
      const [invoices] = await tx.select({ rows: count() }).from(invoice).where(eq(invoice.companyId, a.companyId))
      const [issued] = await tx.select({ rows: count() }).from(outboxEvent).where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.kind, "invoice-issued")))
      const [counter] = await tx.select({ next: company.nextInvoiceNumber }).from(company).where(eq(company.id, a.companyId))
      return { runs: runs?.rows ?? 0, invoices: invoices?.rows ?? 0, issued: issued?.rows ?? 0, next: counter?.next }
    })
  }

  const byId = (x: { id: string }, y: { id: string }) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)

  return { refused, manual, entered, readEvent, readInvoice, period, run, preview, eventsAbout, written, byId }
}
