// The positions' purge (O8 of #290): every position fixed more than the
// retention days ago is deleted, however long ago it crossed them, in
// batches until none is left; a younger one stays; unset, the days are the
// ceiling of thirty; and the worker's DELETE is the only way a position
// leaves — the API role may neither delete nor update one, and the worker
// may neither insert nor update. The sweep crosses companies as the worker
// role, so the suite runs on a database of its own.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { migrateDatabase } from "@waste/db/migrate"
import { session, sessionPosition } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { and, eq, sql } from "drizzle-orm"

import type { JobContext } from "../jobs/definition"
import { PURGE_BATCH, purgePositions } from "../jobs/purge-positions"
import { seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type SeededRoute } from "./consumer-fixtures"
import { rolesUnderTest, withDatabaseName } from "./database"

const roles = rolesUnderTest()

const NOW = new Date("2031-01-15T03:30:00.000Z")
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS)
const POINT = { type: "Point" as const, coordinates: [12.5683, 55.6761] as [number, number] }

/** The Postgres error code a refused statement carries, wherever drizzle wrapped it. */
const codeOf = (error: unknown): string | undefined => {
  const found = error as { code?: string; cause?: { code?: string } }
  return found.cause?.code ?? found.code
}

describe("execution.purge-positions", { skip: roles.skip }, () => {
  const name = `waste_worker_positions_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let owner: Database
  let api: Database
  let worker: Database
  let tenant: ConsumerTenant
  let route: SeededRoute
  const sessionId = testId()
  const lines: string[] = []
  const context = (overrides: Partial<JobContext> = {}) => ({ api, worker, now: () => NOW, log: (line: string) => void lines.push(line), ...overrides }) as JobContext

  /** One position of the session fixed `days` ago, written as the driver door writes it. */
  const position = (days: number) =>
    withCompany(api.db, tenant.companyId, (tx) =>
      tx.insert(sessionPosition).values({ companyId: tenant.companyId, projectId: tenant.projectId, routeId: route.id, sessionId, driverId: tenant.driverId, fixedAt: daysAgo(days), location: POINT, accuracyM: 10 }),
    )
  /** The days ago of every position left, oldest first. */
  const left = async (): Promise<number[]> => {
    const rows = await owner.db.select({ fixedAt: sessionPosition.fixedAt }).from(sessionPosition).orderBy(sessionPosition.fixedAt)
    return rows.map((row) => Math.round((NOW.getTime() - row.fixedAt.getTime()) / DAY_MS))
  }

  before(async () => {
    if (roles.skip) return
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    owner = createDb(withDatabaseName(roles.adminUrl, name), { max: 1 })
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 2 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    tenant = await seedConsumerTenant(api)
    route = await seedRoute(api, tenant)
    await withCompany(api.db, tenant.companyId, (tx) =>
      tx.insert(session).values({ id: sessionId, companyId: tenant.companyId, projectId: tenant.projectId, routeId: route.id, driverId: tenant.driverId, vehicleId: tenant.vehicleId, deviceId: "device-mads-1", startedAt: daysAgo(60), endedAt: daysAgo(60), lastSeenAt: daysAgo(60) }),
    )
  })
  after(async () => {
    await Promise.allSettled([api?.close(), worker?.close(), owner?.close()])
    try {
      await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin?.close()
    }
  })

  test("deletes every position fixed more than the setting's days ago, however long ago, and keeps the younger ones", async () => {
    for (const days of [45, 8, 7.5, 6, 1]) await position(days)
    assert.deepEqual(await purgePositions(context({ positionRetentionDays: 7 })), { removed: 3, days: 7 })
    assert.deepEqual(await left(), [6, 1])
    assert.equal(lines.at(-1), "positions: removed 3 fixed more than 7 days ago")
    assert.deepEqual(await purgePositions(context({ positionRetentionDays: 7 })), { removed: 0, days: 7 }, "a night run again finds nothing new")
  })

  test("unset, the days are the ceiling of thirty, and the log says so", async () => {
    await position(31)
    await position(29)
    assert.deepEqual(await purgePositions(context()), { removed: 1, days: 30 })
    assert.deepEqual(await left(), [29, 6, 1])
    assert.equal(lines.at(-1), "positions: removed 1 fixed more than 30 days ago (POSITION_RETENTION_DAYS is unset: the ceiling)")
  })

  test("a backlog larger than one batch goes in batches until none is left", async () => {
    // Written as the owner, in one statement: a month of a busy fleet's backlog.
    await owner.sql`
      insert into wms.session_position (company_id, project_id, route_id, session_id, driver_id, fixed_at, location, accuracy_m)
      select ${tenant.companyId}, ${tenant.projectId}, ${route.id}, ${sessionId}, ${tenant.driverId}, ${daysAgo(40).toISOString()}::timestamptz + make_interval(secs => n), extensions.st_setsrid(extensions.st_makepoint(12.5683, 55.6761), 4326), 10
        from generate_series(1, ${PURGE_BATCH + 1}) as n`
    assert.deepEqual(await purgePositions(context()), { removed: PURGE_BATCH + 1, days: 30 })
    assert.deepEqual(await left(), [29, 6, 1])
  })

  test("the worker's DELETE is the only way out: the API role may neither delete nor update a position, and the worker may neither insert nor update one", async () => {
    const refused = async (what: string, statement: () => Promise<unknown>) => {
      await assert.rejects(statement, (error) => codeOf(error) === "42501", what)
    }
    await refused("wms_api deleting", () => withCompany(api.db, tenant.companyId, (tx) => tx.delete(sessionPosition).where(eq(sessionPosition.companyId, tenant.companyId))))
    await refused("wms_api updating", () => withCompany(api.db, tenant.companyId, (tx) => tx.update(sessionPosition).set({ accuracyM: 1 }).where(eq(sessionPosition.companyId, tenant.companyId))))
    await refused("wms_worker updating", () => worker.db.execute(sql`update wms.session_position set accuracy_m = 1`))
    await refused("wms_worker inserting", () =>
      worker.db.insert(sessionPosition).values({ companyId: tenant.companyId, projectId: tenant.projectId, routeId: route.id, sessionId, driverId: tenant.driverId, fixedAt: NOW, location: POINT, accuracyM: 10 }),
    )
    await refused("wms_worker deleting another ledger", () => worker.db.execute(sql`delete from wms.driver_command where false`))
    const rows = await owner.db.select({ id: sessionPosition.id }).from(sessionPosition).where(and(eq(sessionPosition.companyId, tenant.companyId), eq(sessionPosition.sessionId, sessionId)))
    assert.equal(rows.length, 3, "nothing moved")
  })
})
