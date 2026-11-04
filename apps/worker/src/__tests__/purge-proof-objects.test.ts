// The proofs' purge (O1 of #290) over a fake Storage: every photo or
// signature older than the retention days is removed, however long ago it
// crossed them, unless an open ticket names its stop — or, for a proof of
// the route itself, its route; a younger one and any other proof kind stay;
// a night run again removes nothing new; and without Storage or the days,
// nothing is removed and the log says why. The sweep reads across companies
// as the worker role, so the suite runs on a database of its own.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { openTicket } from "@waste/db/commands/open-ticket"
import { migrateDatabase } from "@waste/db/migrate"
import { proofOfService } from "@waste/db/schema/execution"
import type { ProofStorage } from "@waste/db/storage"
import { withCompany } from "@waste/db/tenant"
import { objectKeyOf } from "@waste/domain/execution/commands"

import type { JobContext } from "../jobs/definition"
import { expiredProofObjects, purgeProofObjects } from "../jobs/purge-proof-objects"
import { seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type SeededRoute } from "./consumer-fixtures"
import { rolesUnderTest, withDatabaseName } from "./database"

const roles = rolesUnderTest()

const NOW = new Date("2031-01-15T03:45:00.000Z")
const RETENTION_DAYS = 90
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

describe("execution.purge-proof-objects", { skip: roles.skip }, () => {
  const name = `waste_worker_purge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let api: Database
  let worker: Database
  let tenant: ConsumerTenant
  let disputedRoute: SeededRoute
  let quietRoute: SeededRoute
  /** What the fake Storage holds: every key a proof names, until the purge removes it. */
  const held = new Set<string>()
  const removed: string[] = []
  const lines: string[] = []
  const storage: ProofStorage = {
    signUpload: async () => {
      throw new Error("not the purge's")
    },
    signReads: async () => {
      throw new Error("not the purge's")
    },
    remove: async (keys) => {
      const there = keys.filter((key) => held.delete(key))
      removed.push(...there)
      return there.length
    },
  }
  const context = (overrides: Partial<JobContext> = {}) => ({ api, worker, now: () => NOW, log: (line: string) => void lines.push(line), proofStorage: storage, proofRetentionDays: RETENTION_DAYS, ...overrides }) as JobContext

  /** A proof with an object, of a stop or of the route itself, recorded by the office `days` ago; answers its key. */
  const proof = async (route: SeededRoute, pickupId: string | null, kind: "photo" | "signature", days: number): Promise<string> => {
    const id = testId()
    const objectKey = objectKeyOf({ companyId: tenant.companyId, routeId: route.id, commandId: id }, kind === "photo" ? "jpg" : "png")
    await withCompany(api.db, tenant.companyId, (tx) =>
      tx.insert(proofOfService).values({ id, companyId: tenant.companyId, projectId: tenant.projectId, routeId: route.id, pickupId, kind, source: "dispatch", occurredAt: daysAgo(days), recordedBy: tenant.officeUserId, objectKey }),
    )
    held.add(objectKey)
    return objectKey
  }

  let expired: string
  let disputed: string
  let young: string
  let longGone: string
  let routeDisputed: string
  let routeQuiet: string

  before(async () => {
    if (roles.skip) return
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 2 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    tenant = await seedConsumerTenant(api)
    disputedRoute = await seedRoute(api, tenant, { pickups: [{ container: "bin1", status: "planned" }, { container: "bin2", status: "planned" }] })
    quietRoute = await seedRoute(api, tenant, { pickups: [{ container: "bin1", status: "planned" }] })
    const [first, second] = disputedRoute.pickupIds
    expired = await proof(disputedRoute, first, "photo", RETENTION_DAYS + 1)
    disputed = await proof(disputedRoute, second, "signature", RETENTION_DAYS + 2)
    young = await proof(disputedRoute, first, "photo", RETENTION_DAYS - 1)
    // Long past the days — a night missed, the key set late, the days lowered — and removed all the same.
    longGone = await proof(disputedRoute, first, "photo", RETENTION_DAYS + 30)
    // A photo of the route itself: its route's open ticket keeps it, and on a route with none it goes.
    routeDisputed = await proof(disputedRoute, null, "photo", RETENTION_DAYS + 5)
    routeQuiet = await proof(quietRoute, null, "photo", RETENTION_DAYS + 5)
    // A stop under an open ticket keeps its evidence.
    await withCompany(api.db, tenant.companyId, (tx) =>
      openTicket(tx, {
        companyId: tenant.companyId,
        draft: {
          projectId: tenant.projectId,
          kind: "complaint",
          priority: "medium",
          source: "phone",
          subject: "Disputed collection",
          description: "The customer disputes the signature",
          occurredAt: daysAgo(RETENTION_DAYS + 2),
          dueAt: null,
          assigneeUserAccountId: null,
          links: { routeId: disputedRoute.id, pickupId: second, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null },
          alertId: null,
        },
        createdBy: tenant.officeUserId,
        sourceEventId: null,
        newId: testId,
        now: () => daysAgo(RETENTION_DAYS + 2),
      }),
    )
  })
  after(async () => {
    await Promise.allSettled([api?.close(), worker?.close()])
    try {
      await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin?.close()
    }
  })

  test("finds every photo and signature past the days, oldest first, whose stop — or route, for the route's own — no open ticket names", async () => {
    const found = await expiredProofObjects(worker, NOW, RETENTION_DAYS)
    assert.deepEqual(
      found.map((object) => object.objectKey),
      [longGone, routeQuiet, expired],
    )
    assert.ok(found.every((object) => object.companyId === tenant.companyId))
    for (const kept of [disputed, young, routeDisputed]) assert.ok(!found.some((object) => object.objectKey === kept), kept)
  })

  test("removes them from Storage and counts what Storage held; the proof rows stay, and a night run again removes nothing new", async () => {
    assert.deepEqual(await purgeProofObjects(context()), { removed: 3 })
    assert.deepEqual(removed, [longGone, routeQuiet, expired])
    assert.equal(lines.at(-1), "proofs: removed 3 photos and signatures older than 90 days, of 3 past them")
    const rows = await withCompany(api.db, tenant.companyId, (tx) => tx.select({ id: proofOfService.id }).from(proofOfService))
    assert.equal(rows.length, 6, "the ledger keeps every row")

    assert.deepEqual(await purgeProofObjects(context()), { removed: 0 })
    assert.equal(lines.at(-1), "proofs: removed 0 photos and signatures older than 90 days, of 3 past them")
  })

  test("without Storage or the days it removes nothing, and says why", async () => {
    removed.length = 0
    assert.deepEqual(await purgeProofObjects(context({ proofStorage: undefined })), { skipped: "no-storage" })
    assert.deepEqual(await purgeProofObjects(context({ proofRetentionDays: undefined })), { skipped: "no-retention" })
    assert.deepEqual(removed, [])
    assert.match(lines.at(-2) ?? "", /no Storage key/)
    assert.match(lines.at(-1) ?? "", /PROOF_RETENTION_DAYS is unset/)
  })
  test("a project whose privacy policy names days of its own (#291 C19) is held to them, the deployment's setting unset or not", async () => {
    // Ten days: the young one is past them too — the three removed before are asked again and count nothing — and the disputed ones stay under their open ticket.
    const owner = createDb(withDatabaseName(roles.adminUrl, name), { max: 1 })
    try {
      await owner.sql`update wms.project set proof_retention_days = 10 where id = ${tenant.projectId}`
      removed.length = 0
      assert.deepEqual(await purgeProofObjects(context({ proofRetentionDays: undefined })), { removed: 1 })
      assert.deepEqual(removed, [young])
      assert.equal(lines.at(-1), "proofs: removed 1 photos and signatures older than their project's days, of 4 past them")
    } finally {
      await owner.sql`update wms.project set proof_retention_days = null where id = ${tenant.projectId}`
      await owner.close()
    }
  })
})
