// Proof objects (O1 of #290) against the database, with a fake Storage: the
// driver door signs an upload for one of the device's own commands' objects
// on a route assigned to the driver, under the key the command will name, or
// says the bucket holds it already; the office reads a stop's objects through
// read URLs behind the stop's own grant and project fence, a missing object a
// null URL. Without Storage's key both are a 503, and Storage's silence a 502.
import assert from "node:assert/strict"
import { after, afterEach, before, describe, test } from "node:test"

import { CommandOutcomeRow, DriverCommandBatchOutcome } from "@waste/contracts/driver-commands"
import { NO_PROOF_STORAGE, type ProblemKind } from "@waste/contracts/problem"
import { ProofObjectLinks, ProofUpload } from "@waste/contracts/proof-objects"
import { createDb, type Database } from "@waste/db/client"
import { StorageRefused, StorageSilent, type ProofStorage } from "@waste/db/storage"
import { noRouteAssigned, objectKeyOf } from "@waste/domain/execution/commands"
import { notActive } from "@waste/domain/execution/transitions"
import { Hono } from "hono"

import type { createApp } from "../app"
import { NOT_A_DRIVERS_LOGIN } from "../auth/driver"
import { authenticate, identify } from "../auth/principal"
import { errorHandler } from "../problem"
import { driverDoorRoutes } from "../routes/driver"
import { ensureProofBucket, NO_PROOF_STORAGE_DETAIL, proofObjectRoutes, READ_URL_TTL_SECONDS, STORAGE_REFUSED, STORAGE_SILENT } from "../routes/proof-objects"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, routeFor, seedDriverFixtures, type DriverFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

/** The afternoon of the operating date: every command's instant is behind it. */
const NOW = new Date(`${FIXTURE_DAY}T14:00:00Z`)

let tick = Date.now()
const mint = (): string => testId((tick += 1))

/** A Storage that signs what the test lets it: keys it holds, keys it does not, and silence or a refusal on demand. */
function fakeStorage() {
  const held = new Set<string>()
  const asked: string[] = []
  let silent = false
  let refusing = false
  const storage: ProofStorage = {
    async signUpload(key) {
      asked.push(`upload ${key}`)
      if (refusing) throw new StorageRefused("Storage answered 400: the related resource does not exist")
      if (silent) throw new StorageSilent("Storage did not answer")
      if (held.has(key)) return { kind: "exists" }
      return { kind: "upload", url: `https://storage.test/upload/${key}?token=t`, expiresAt: new Date(NOW.getTime() + 7_200_000) }
    },
    async signReads(keys, seconds) {
      asked.push(`read ${keys.join(",")} for ${seconds}s`)
      if (silent) throw new StorageSilent("Storage did not answer")
      return new Map(keys.map((key) => [key, held.has(key) ? `https://storage.test/read/${key}?token=r` : null]))
    },
    async remove() {
      throw new Error("not the routes'")
    },
    async ensureBucket() {
      asked.push("ensure")
      if (refusing) throw new StorageRefused("Storage answered 400: invalid compact JWS")
      return held.has("bucket") ? "kept" : "made"
    },
  }
  return { storage, held, asked, silence: () => (silent = true), refuse: () => (refusing = true), speak: () => ((silent = false), (refusing = false)) }
}

describe("proof objects", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let fixtures: DriverFixtures
  const fake = fakeStorage()
  const logged: unknown[] = []
  let mads: Call
  let olivia: Call
  let viewer: Call
  let theirOlivia: Call
  let madsWithout: Call
  let oliviaWithout: Call

  /** The routes under test, their door and the office's read, over one Storage or none. */
  const mounted = (storage: ProofStorage | null) => {
    const app = new Hono()
    app.onError(errorHandler())
    app.route("/", proofObjectRoutes(identify({ pool, verifier: keys.verifier }), { pool, storage, now: () => NOW, log: (entry) => logged.push(entry) }))
    app.route("/", driverDoorRoutes(authenticate({ pool, verifier: keys.verifier }), { now: () => NOW, log: () => {} }))
    return app as unknown as ReturnType<typeof createApp>
  }

  before(async () => {
    pool = createDb(database.url, { max: 6 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    fixtures = await seedDriverFixtures(pool, a, fleet)
    const app = mounted(fake.storage)
    const without = mounted(null)
    mads = callingAs(app, keys, fixtures.accounts.mads, a.companyId)
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    theirOlivia = callingAs(app, keys, b.users.olivia, b.companyId)
    madsWithout = callingAs(without, keys, fixtures.accounts.mads, a.companyId)
    oliviaWithout = callingAs(without, keys, a.users.olivia, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const ok = async (response: Response) => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return await response.json()
  }
  const refused = async (response: Response, status: number, kind?: ProblemKind) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response, kind)
  }
  const send = async (commands: unknown[]): Promise<CommandOutcomeRow[]> => DriverCommandBatchOutcome.parse(await ok(await mads("/driver/commands", { method: "POST", body: { commands } }))).outcomes
  const command = (kind: string, routeId: string, body: unknown, id = mint()) => ({ id, kind, routeId, occurredAt: `${FIXTURE_DAY}T07:00:00.000Z`, deviceId: "device-mads-01", body })

  describe("POST /driver/uploads", () => {
    const started: string[] = []
    /** A route of Mads's started through the door: the door signs only for an active route, and ends it after the test, since Mads drives one at a time. */
    const activeRoute = async () => {
      const route = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads })
      assert.deepEqual((await send([command("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id })])).map((outcome) => outcome.outcome), ["applied"])
      started.push(route.id)
      return route
    }
    afterEach(async () => {
      for (const routeId of started.splice(0)) await send([command("end-route", routeId, {})])
    })

    test("signs the upload of one of the device's commands' objects on the driver's route, under the key that command names", async () => {
      const route = await activeRoute()
      const commandId = mint()
      const answer = ProofUpload.parse(await ok(await mads("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId, extension: "jpg" } })))
      const objectKey = objectKeyOf({ companyId: a.companyId, routeId: route.id, commandId }, "jpg")
      assert.deepEqual(answer, { state: "upload", objectKey, uploadUrl: `https://storage.test/upload/${objectKey}?token=t`, expiresAt: new Date(NOW.getTime() + 7_200_000).toISOString() })
      assert.equal(fake.asked.at(-1), `upload ${objectKey}`)
    })

    test("a key the bucket holds already is uploaded: a retry after a lost answer puts nothing again", async () => {
      const route = await activeRoute()
      const commandId = mint()
      const objectKey = objectKeyOf({ companyId: a.companyId, routeId: route.id, commandId }, "png")
      fake.held.add(objectKey)
      assert.deepEqual(ProofUpload.parse(await ok(await mads("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId, extension: "png" } }))), { state: "uploaded", objectKey })
    })

    test("a route not assigned to this driver, of another company or not there is the door's one sentence, and Storage is not asked", async () => {
      const alis = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.jonas })
      const before = fake.asked.length
      for (const routeId of [alis.id, testId()]) {
        assert.equal((await refused(await mads("/driver/uploads", { method: "POST", body: { routeId, commandId: mint(), extension: "jpg" } }), 404)).detail, noRouteAssigned(routeId))
      }
      assert.equal(fake.asked.length, before)
    })

    test("a route that is not active signs nothing: the door would reject the command the object is for, and nothing would ever name it", async () => {
      const ready = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads })
      const ended = await activeRoute()
      await send([command("end-route", ended.id, {})])
      started.splice(started.indexOf(ended.id), 1)
      const before = fake.asked.length
      for (const route of [ready, ended]) {
        assert.equal((await refused(await mads("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId: mint(), extension: "jpg" } }), 409)).detail, notActive(route.label))
      }
      assert.equal(fake.asked.length, before)
    })

    test("an office login is no driver's", async () => {
      const route = await activeRoute()
      assert.equal((await refused(await olivia("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId: mint(), extension: "jpg" } }), 403)).detail, NOT_A_DRIVERS_LOGIN)
    })

    test("a format the bucket does not take, or a key the device names itself, is the body's 400", async () => {
      const route = await activeRoute()
      const gif = await refused(await mads("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId: mint(), extension: "gif" } }), 400)
      assert.deepEqual(gif.errors?.map((error) => error.path), ["extension"])
      await refused(await mads("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId: mint(), extension: "jpg", objectKey: "x" } }), 400)
    })

    test("Storage's silence is a 502 in one sentence, its cause logged", async () => {
      const route = await activeRoute()
      fake.silence()
      try {
        assert.equal((await refused(await mads("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId: mint(), extension: "jpg" } }), 502)).detail, STORAGE_SILENT)
        assert.ok(logged.length > 0)
      } finally {
        fake.speak()
      }
    })

    test("Storage refusing the call — no bucket, a key it does not take — is the deployment's typed 503, its cause logged, never the 502 a device would wait out", async () => {
      const route = await activeRoute()
      fake.refuse()
      try {
        assert.equal((await refused(await mads("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId: mint(), extension: "jpg" } }), 503, NO_PROOF_STORAGE)).detail, STORAGE_REFUSED)
        assert.ok(logged.some((entry) => /related resource/.test(JSON.stringify(entry))))
      } finally {
        fake.speak()
      }
    })

    test("a deployment without Storage's key stores no photo: 503, typed so a device tells it from an outage", async () => {
      const route = await activeRoute()
      assert.equal((await refused(await madsWithout("/driver/uploads", { method: "POST", body: { routeId: route.id, commandId: mint(), extension: "jpg" } }), 503, NO_PROOF_STORAGE)).detail, NO_PROOF_STORAGE_DETAIL)
    })
  })

  describe("GET /pickups/:id/proof-objects", () => {
    /** A route whose first stop carries a photo, a signature and a completion, run and ended through the door; answers the stop and the two keys. */
    const stopWithObjects = async () => {
      const route = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads, pickups: 2 })
      const [stop] = route.pickupIds
      const photo = mint()
      const signature = mint()
      const photoKey = objectKeyOf({ companyId: a.companyId, routeId: route.id, commandId: photo }, "jpg")
      const signatureKey = objectKeyOf({ companyId: a.companyId, routeId: route.id, commandId: signature }, "png")
      const outcomes = await send([
        command("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id }),
        command("add-photo", route.id, { pickupId: stop, objectKey: photoKey }, photo),
        command("add-signature", route.id, { pickupId: stop, objectKey: signatureKey }, signature),
        command("complete-pickup", route.id, { pickupId: stop }),
        // Mads runs one route at a time: the next test's start needs this one ended.
        command("end-route", route.id, {}),
      ])
      assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ["applied", "applied", "applied", "applied", "applied"], JSON.stringify(outcomes))
      return { route, stop, photo, signature, photoKey, signatureKey }
    }

    test("a read URL for each proof that names an object, in recording order, a null where the bucket holds none", async () => {
      const { stop, photo, signature, photoKey, signatureKey } = await stopWithObjects()
      fake.held.add(photoKey)
      const links = ProofObjectLinks.parse(await ok(await olivia(`/pickups/${stop}/proof-objects`)))
      const expiresAt = new Date(NOW.getTime() + READ_URL_TTL_SECONDS * 1000).toISOString()
      assert.deepEqual(links.items, [
        { proofId: photo, objectKey: photoKey, url: `https://storage.test/read/${photoKey}?token=r`, expiresAt },
        { proofId: signature, objectKey: signatureKey, url: null, expiresAt },
      ])
      assert.equal(fake.asked.at(-1), `read ${photoKey},${signatureKey} for ${READ_URL_TTL_SECONDS}s`, "one call for the stop's keys")
    })

    test("a stop with no object asks Storage for nothing", async () => {
      const route = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads })
      assert.deepEqual(ProofObjectLinks.parse(await ok(await olivia(`/pickups/${route.pickupIds[0]}/proof-objects`))).items, [])
    })

    test("another company's stop is not there, and a role without the stops' view is refused", async () => {
      const { stop } = await stopWithObjects()
      await refused(await theirOlivia(`/pickups/${stop}/proof-objects`), 404)
      await refused(await viewer(`/pickups/${stop}/proof-objects`), 403)
    })

    test("a deployment without Storage's key: 503", async () => {
      const { stop } = await stopWithObjects()
      assert.equal((await refused(await oliviaWithout(`/pickups/${stop}/proof-objects`), 503, NO_PROOF_STORAGE)).detail, NO_PROOF_STORAGE_DETAIL)
    })
  })
})

describe("the proofs' bucket on the API's boot", () => {
  test("is made where Storage lacks it or found in place, and a Storage that refuses or is silent is logged, never thrown at the boot", async () => {
    const fake = fakeStorage()
    const lines: string[] = []
    await ensureProofBucket(fake.storage, (line) => void lines.push(line))
    fake.held.add("bucket")
    await ensureProofBucket(fake.storage, (line) => void lines.push(line))
    fake.refuse()
    await ensureProofBucket(fake.storage, (line) => void lines.push(line))
    assert.deepEqual(lines.slice(0, 2), ["proofs: the private bucket was made", "proofs: the private bucket is in place"])
    assert.match(lines[2], /^proofs: the private bucket could not be ensured \(Storage answered 400: invalid compact JWS\); photos and signatures wait on Storage$/)
    assert.deepEqual(fake.asked, ["ensure", "ensure", "ensure"])
  })
})
