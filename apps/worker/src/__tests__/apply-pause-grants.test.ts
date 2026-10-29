// A granted pause, applied (M11 of #293): the Registry's consumer of
// `application-decided` pauses the subscription a granted `pause` names over
// the granted period, cut to today on and to the subscription's own; nothing
// for a refusal or another kind; once however often the event is delivered;
// and an office pause already over those days stands. The deciding account
// is the audit trail's actor, with the Application's number as the reason.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Application } from "@waste/contracts/applications"
import { createDb, type Database } from "@waste/db/client"
import { auditEvent } from "@waste/db/schema/audit"
import { subscriptionPause } from "@waste/db/schema/agreements"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import type { JobContext } from "../jobs"
import { applyPauseGrant, grantReason } from "../jobs/apply-pause-grants"
import type { RelayedEvent } from "../outbox/subscribe"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { dropFinanceTenant, placeBin, seedFinanceTenant, testId, type FinanceTenant } from "./finance-tenant"
import { fakeRouting, settlesNothing } from "./routing-context"

const database = databaseUnderTest()
const owner = ownerUnderTest()

/** 20 October 2026, noon in Copenhagen: the project's today is the 20th. */
const NOON = new Date("2026-10-20T10:00:00Z")

describe("registry.apply-pause-grants against Postgres (M11 of #293)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let admin: Database
  let tenant: FinanceTenant
  const lines: string[] = []
  const context = (): JobContext => ({ api: pool, worker: pool, now: () => NOON, log: (message) => void lines.push(message), send: async () => null, complete: settlesNothing, routing: fakeRouting() })

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    admin = createDb(owner.url, { max: 1 })
    tenant = await seedFinanceTenant(pool)
  })
  after(async () => {
    await dropFinanceTenant(pool, admin, tenant.companyId)
    await pool.close()
    await admin.close()
  })

  let number = 0
  /** The decided Application as the API answers it, and the event the relay hands the queue. */
  const decided = (subscriptionId: string | null, decision: Partial<NonNullable<Application["decision"]>> & Pick<NonNullable<Application["decision"]>, "outcome">, kind: Application["kind"] = "pause"): RelayedEvent => {
    number += 1
    const applicationId = testId()
    const application: Application = {
      id: applicationId,
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-20T09:00:00.000Z",
      projectId: tenant.projects.copenhagen.id,
      number,
      kind,
      status: "decided",
      channel: "letter",
      receivedOn: "2026-10-01",
      customerId: tenant.customers.anna.id,
      propertyId: null,
      sharedCollectionPointId: null,
      subscriptionId,
      statement: "The summer house stands empty this winter",
      decision: { id: testId(), applicationId, conditions: null, validFrom: null, validTo: null, appealText: null, decidedBy: tenant.users.olivia.id, decidedAt: "2026-10-20T09:00:00.000Z", ...decision },
    }
    return { id: testId(), kind: "application-decided", aggregateKind: "application", aggregateId: applicationId, projectId: tenant.projects.copenhagen.id, occurredAt: "2026-10-20T09:00:00.000Z", payload: application, publishedAt: "2026-10-20T09:00:05.000Z", createdAt: "2026-10-20T09:00:00.000Z", updatedAt: "2026-10-20T09:00:05.000Z", companyId: tenant.companyId } as RelayedEvent
  }

  const pausesOf = (subscriptionId: string) =>
    withCompany(pool.db, tenant.companyId, (tx) => tx.select({ id: subscriptionPause.id, validFrom: subscriptionPause.validFrom, validTo: subscriptionPause.validTo }).from(subscriptionPause).where(eq(subscriptionPause.subscriptionId, subscriptionId)))

  test("a grant of a pause naming a subscription pauses it over the granted period, written once however often it is delivered, as the deciding account", async () => {
    const bin = await placeBin(pool, tenant, "PAUSE-1", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    const event = decided(bin.subscriptionId, { outcome: "granted", validFrom: "2026-11-01", validTo: "2027-04-01" })
    const first = await applyPauseGrant(event, context())
    assert.equal(first.did, "paused")
    assert.deepEqual(await pausesOf(bin.subscriptionId), [{ id: (event.payload as Application).decision!.id, validFrom: "2026-11-01", validTo: "2027-04-01" }])
    assert.equal((await applyPauseGrant(event, context())).did, "replayed", "the pause's id is the decision's")
    assert.equal((await pausesOf(bin.subscriptionId)).length, 1)
    const [trail] = await admin.db.select().from(auditEvent).where(and(eq(auditEvent.companyId, tenant.companyId), eq(auditEvent.tableName, "subscription_pause"), eq(auditEvent.rowId, first.pauseId!)))
    assert.deepEqual([trail?.actorUserAccountId, trail?.reason], [tenant.users.olivia.id, grantReason((event.payload as Application).number)])
  })

  test("a grant decided after its first day pauses from today; a partial grant pauses too; a refusal, another kind or none named pauses nothing", async () => {
    const late = await placeBin(pool, tenant, "PAUSE-2", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    assert.equal((await applyPauseGrant(decided(late.subscriptionId, { outcome: "partly-granted", validFrom: "2026-10-01", validTo: null }), context())).did, "paused")
    assert.deepEqual((await pausesOf(late.subscriptionId)).map((pause) => [pause.validFrom, pause.validTo]), [["2026-10-20", null]], "from today, never the days gone")

    const other = await placeBin(pool, tenant, "PAUSE-3", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    assert.equal((await applyPauseGrant(decided(other.subscriptionId, { outcome: "refused" }), context())).did, "nothing")
    assert.equal((await applyPauseGrant(decided(other.subscriptionId, { outcome: "granted", validFrom: "2026-11-01" }, "home-composting"), context())).did, "nothing")
    assert.equal((await applyPauseGrant(decided(null, { outcome: "granted", validFrom: "2026-11-01" }), context())).did, "nothing")
    assert.equal((await applyPauseGrant(decided(other.subscriptionId, { outcome: "granted", validFrom: "2026-09-01", validTo: "2026-10-01" }), context())).did, "nothing", "over before today")
    assert.deepEqual(await pausesOf(other.subscriptionId), [])
  })

  test("the office's own pause over the same days stands, and the grant writes none beside it", async () => {
    const bin = await placeBin(pool, tenant, "PAUSE-4", { agreementId: tenant.agreements.anna.id, productId: tenant.products.residual.id })
    await withCompany(pool.db, tenant.companyId, (tx) => tx.insert(subscriptionPause).values({ id: testId(), companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, subscriptionId: bin.subscriptionId, validFrom: "2026-11-15", validTo: "2026-12-01" }))
    assert.equal((await applyPauseGrant(decided(bin.subscriptionId, { outcome: "granted", validFrom: "2026-11-01", validTo: "2027-01-01" }), context())).did, "already-paused")
    assert.deepEqual((await pausesOf(bin.subscriptionId)).map((pause) => [pause.validFrom, pause.validTo]), [["2026-11-15", "2026-12-01"]])
    assert.ok(lines.some((line) => line.endsWith("→ already-paused")))
  })
})
