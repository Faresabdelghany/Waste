// The proofs' purge (O1 of #290) over a fake Storage: a photo or a signature
// older than the retention days is removed, unless an open ticket names its
// stop; a younger one, one past the catch-up week and any other proof kind
// stay; and without Storage or the days, nothing is removed and the log says
// why. The sweep reads across companies as the worker role and writes
// nothing — what it removes goes to the fake — so it runs on the shared
// database, its clock pinned years ahead where no other suite's proofs stand,
// and the assertions read this tenant's keys alone.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { openTicket } from "@waste/db/commands/open-ticket"
import { proofOfService } from "@waste/db/schema/execution"
import type { ProofStorage } from "@waste/db/storage"
import { withCompany } from "@waste/db/tenant"
import { objectKeyOf } from "@waste/domain/execution/commands"

import type { JobContext } from "../jobs/definition"
import { expiredProofObjects, PURGE_CATCH_UP_DAYS, purgeProofObjects } from "../jobs/purge-proof-objects"
import { dropConsumerTenant, seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type SeededRoute } from "./consumer-fixtures"
import { databaseUnderTest, ownerUnderTest, workerUnderTest } from "./database"

const apiRole = databaseUnderTest()
const workerRole = workerUnderTest()
const owner = ownerUnderTest()

/** The purge's clock: years past every fixture, so the window holds this suite's proofs alone. */
const NOW = new Date("2031-01-15T03:45:00.000Z")
const RETENTION_DAYS = 90
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

describe("execution.purge-proof-objects", { skip: apiRole.skip || workerRole.skip || owner.skip }, () => {
  let api: Database
  let worker: Database
  let ownerPool: Database
  let tenant: ConsumerTenant
  let route: SeededRoute
  const removed: string[] = []
  const lines: string[] = []
  const storage: ProofStorage = {
    signUpload: async () => {
      throw new Error("not the purge's")
    },
    signReads: async () => {
      throw new Error("not the purge's")
    },
    remove: async (keys) => void removed.push(...keys),
  }
  const context = (overrides: Partial<JobContext> = {}) => ({ api, worker, now: () => NOW, log: (line: string) => void lines.push(line), proofStorage: storage, proofRetentionDays: RETENTION_DAYS, ...overrides }) as JobContext

  /** A proof with an object on a stop of the route, recorded by the office `days` ago; answers its key. */
  const proof = async (pickupId: string, kind: "photo" | "signature", days: number): Promise<string> => {
    const id = testId()
    const objectKey = objectKeyOf({ companyId: tenant.companyId, routeId: route.id, commandId: id }, kind === "photo" ? "jpg" : "png")
    await withCompany(api.db, tenant.companyId, (tx) =>
      tx.insert(proofOfService).values({ id, companyId: tenant.companyId, projectId: tenant.projectId, routeId: route.id, pickupId, kind, source: "dispatch", occurredAt: daysAgo(days), recordedBy: tenant.officeUserId, objectKey }),
    )
    return objectKey
  }

  let expired: string
  let disputed: string
  let young: string
  let beyond: string

  before(async () => {
    api = createDb(apiRole.url, { max: 2 })
    worker = createDb(workerRole.url, { max: 2 })
    ownerPool = createDb(owner.url, { max: 1 })
    tenant = await seedConsumerTenant(api)
    route = await seedRoute(api, tenant, { pickups: [{ container: "bin1", status: "planned" }, { container: "bin2", status: "planned" }] })
    const [first, second] = route.pickupIds
    expired = await proof(first, "photo", RETENTION_DAYS + 1)
    disputed = await proof(second, "signature", RETENTION_DAYS + 2)
    young = await proof(first, "photo", RETENTION_DAYS - 1)
    beyond = await proof(first, "photo", RETENTION_DAYS + PURGE_CATCH_UP_DAYS + 1)
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
          links: { routeId: route.id, pickupId: second, containerId: null, propertyId: null, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null },
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
    if (tenant) await dropConsumerTenant(api, ownerPool, tenant.companyId)
    await api?.close()
    await worker?.close()
    await ownerPool?.close()
  })

  const ours = (keys: readonly string[]) => keys.filter((key) => key.startsWith(`${tenant.companyId}/`))

  test("finds the photos and signatures past the retention, within the catch-up week, whose stop no open ticket names", async () => {
    const found = await expiredProofObjects(worker, NOW, RETENTION_DAYS)
    assert.deepEqual(ours(found.map((object) => object.objectKey)), [expired])
    assert.ok(found.every((object) => object.objectKey.startsWith(`${object.companyId}/`)), "each with the company the key names")
    for (const kept of [disputed, young, beyond]) assert.ok(!ours(found.map((object) => object.objectKey)).includes(kept))
  })

  test("removes them from Storage and says how many; the proof rows stay", async () => {
    removed.length = 0
    assert.deepEqual(await purgeProofObjects(context()), { removed: (await expiredProofObjects(worker, NOW, RETENTION_DAYS)).length })
    assert.deepEqual(ours(removed), [expired])
    assert.match(lines.at(-1) ?? "", /removed \d+ photos and signatures older than 90 days/)
    const rows = await withCompany(api.db, tenant.companyId, (tx) => tx.select({ id: proofOfService.id }).from(proofOfService))
    assert.equal(rows.length, 4, "the ledger keeps every row")
  })

  test("without Storage or the days it removes nothing, and says why", async () => {
    removed.length = 0
    assert.deepEqual(await purgeProofObjects(context({ proofStorage: undefined })), { skipped: "no-storage" })
    assert.deepEqual(await purgeProofObjects(context({ proofRetentionDays: undefined })), { skipped: "no-retention" })
    assert.deepEqual(removed, [])
    assert.match(lines.at(-2) ?? "", /no Storage key/)
    assert.match(lines.at(-1) ?? "", /PROOF_RETENTION_DAYS is unset/)
  })
})
