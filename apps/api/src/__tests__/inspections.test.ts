// M23a of #293 through the API: a driver's `record-fill`, which sets the
// stop's fill estimate — the latest standing, whatever the stop's outcome —
// and answers the stop; and the office's field inspections: one subject of
// the caller's projects, a verdict its findings agree with, corrected while
// open and frozen once closed, its photos signed into the proofs bucket under
// the inspection's own prefix, appended by that key alone and read back.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { DriverCommandBatchOutcome, type CommandOutcomeRow } from "@waste/contracts/driver-commands"
import { FieldInspection, InspectionPhotoLinks, InspectionPhotoUpload, ONE_SUBJECT } from "@waste/contracts/field-inspections"
import { Page } from "@waste/contracts/pagination"
import { NO_PROOF_STORAGE } from "@waste/contracts/problem"
import { Pickup } from "@waste/contracts/pickups"
import { createDb, type Database } from "@waste/db/client"
import { createJobSender } from "@waste/db/jobs"
import type { ProofStorage } from "@waste/db/storage"
import type { DriverCommandKind } from "@waste/domain/execution/vocabulary"
import { A_FINDING_TO_FOLLOW_UP, COMPLIANT_FINDS_NOTHING } from "@waste/domain/inspections/rules"
import { FakeProvider } from "@waste/routing/fake"
import { Hono } from "hono"

import type { createApp } from "../app"
import { authenticate, identify } from "../auth/principal"
import { errorHandler } from "../problem"
import { driverDoorRoutes } from "../routes/driver"
import { fieldInspectionRoutes, INSPECTION_CLOSED, KEY_NAMES_ANOTHER, NOT_A_CONTAINER, PHOTO_ALREADY_APPENDED } from "../routes/field-inspections"
import { pickupRoutes } from "../routes/pickups"
import { routeRoutes } from "../routes/routes"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { FIXTURE_DAY, routeFor, seedDriverFixtures, type DriverFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ledgers this suite writes — the receipts, the photos — which `wms_api` may not delete. */
const owner = ownerUnderTest()

const InspectionPage = Page(FieldInspection)

/** The request's clock: the afternoon of the operating date, so every command's instant is behind it. */
const NOW = new Date(`${FIXTURE_DAY}T14:00:00Z`)
const at = (time: string): string => `${FIXTURE_DAY}T${time}:00.000Z`

let tick = Date.now()
const mint = (): string => testId((tick += 1))

type Envelope = { id: string; kind: DriverCommandKind; routeId: string; occurredAt: string; deviceId: string; body: unknown }
const envelope = (kind: DriverCommandKind, routeId: string, body: unknown, occurredAt = at("07:00")): Envelope => ({ id: mint(), kind, routeId, occurredAt, deviceId: "device-mads-01", body })

/** A Storage that signs what it is asked, holds the keys the test puts, and is the deployment's or absent. */
function fakeStorage() {
  const held = new Set<string>()
  const storage: ProofStorage = {
    async signUpload(key) {
      return { kind: "upload", url: `https://storage.test/upload/${key}?token=t`, expiresAt: new Date(NOW.getTime() + 7_200_000) }
    },
    async signReads(keys) {
      return new Map(keys.map((key) => [key, held.has(key) ? `https://storage.test/read/${key}?token=r` : null]))
    },
    async remove() {
      throw new Error("not the routes'")
    },
  }
  return { storage, held }
}

describe("M23a: the fill estimate and field inspections", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let fixtures: DriverFixtures
  const fake = fakeStorage()
  let mads: Call
  let olivia: Call
  let lars: Call
  let theirOlivia: Call
  let oliviaWithout: Call

  const mounted = (storage: ProofStorage | null) => {
    const guard = authenticate({ pool, verifier: keys.verifier })
    const app = new Hono()
    app.onError(errorHandler())
    app.route("/", driverDoorRoutes(guard, { now: () => NOW, log: () => {} }))
    app.route("/", routeRoutes(guard, { now: () => NOW, routing: new FakeProvider(), jobs: createJobSender(pool) }))
    app.route("/", pickupRoutes(guard, { now: () => NOW }))
    const inspections = fieldInspectionRoutes(guard, identify({ pool, verifier: keys.verifier }), { now: () => NOW, pool, storage, log: () => {} })
    app.route("/", inspections.routes)
    app.route("/", inspections.objects)
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
    mads = callingAs(app, keys, fixtures.accounts.mads, a.companyId)
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    theirOlivia = callingAs(app, keys, b.users.olivia, b.companyId)
    oliviaWithout = callingAs(mounted(null), keys, a.users.olivia, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const one = async (command: Envelope): Promise<CommandOutcomeRow> => {
    const response = await mads("/driver/commands", { method: "POST", body: { commands: [command] } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const [outcome] = DriverCommandBatchOutcome.parse(await response.json()).outcomes
    return outcome
  }
  const inspection = async (response: Response, status = 200): Promise<FieldInspection> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return FieldInspection.parse(await response.json())
  }
  const bin = () => fixtures.containers[0].id

  describe("record-fill", () => {
    test("sets the stop's fill on a running route, a later estimate replacing it, and answers the stop; the office reads it on the stop", async () => {
      const route = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads })
      assert.equal((await one(envelope("start-route", route.id, { vehicleId: fleet.vehicles.wh24.id }, at("06:30")))).outcome, "applied")
      const [stop] = route.pickupIds
      const first = await one(envelope("record-fill", route.id, { pickupId: stop, fill: "overflowing" }))
      assert.equal(first.outcome, "applied", JSON.stringify(first.problem))
      assert.equal(first.result?.resource, "pickup")
      assert.equal(Pickup.parse(first.result?.value).fill, "overflowing")
      assert.equal((await one(envelope("complete-pickup", route.id, { pickupId: stop }))).outcome, "applied")
      const later = await one(envelope("record-fill", route.id, { pickupId: stop, fill: "full" }, at("07:05")))
      assert.equal(later.outcome, "applied", "a completed stop is estimated after it is emptied")
      const read = Pickup.parse(await (await olivia(`/pickups/${stop}`)).json())
      assert.equal(read.fill, "full", "the latest stands")
      const untouched = Pickup.parse(await (await olivia(`/pickups/${route.pickupIds[1]}`)).json())
      assert.equal(untouched.fill, null)
    })

    test("is refused off its levels at the body, and on a route not running", async () => {
      const route = await routeFor(pool, a, fleet, fixtures, { driver: fleet.drivers.mads, operatingDate: FIXTURE_DAY })
      const off = await one(envelope("record-fill", route.id, { pickupId: route.pickupIds[0], fill: "brimming" }))
      assert.equal(off.outcome, "rejected")
      assert.equal(off.problem?.status, 400)
      const notRunning = await one(envelope("record-fill", route.id, { pickupId: route.pickupIds[0], fill: "half" }))
      assert.equal(notRunning.problem?.status, 409)
    })
  })

  describe("field inspections", () => {
    test("is recorded on one subject of the caller's projects, the caller its inspector, open, at the request's clock unless said", async () => {
      const made = await inspection(await olivia("/field-inspections", { method: "POST", body: { containerId: bin(), outcome: "major", findings: ["contamination", "overfilled"], note: "Garden waste in the residual" } }), 201)
      assert.equal(made.projectId, a.projects.copenhagen.id)
      assert.equal(made.inspectorId, a.users.olivia.id)
      assert.equal(made.status, "open")
      assert.equal(made.inspectedAt, NOW.toISOString())
      assert.deepEqual(made.photos, [])
      const onProperty = await inspection(await olivia("/field-inspections", { method: "POST", body: { propertyId: fixtures.property.id, outcome: "compliant", inspectedAt: at("09:00") } }), 201)
      assert.equal(onProperty.inspectedAt, at("09:00"))
      const listed = InspectionPage.parse(await (await olivia(`/field-inspections?containerId=${bin()}`)).json()).items
      assert.ok(listed.some((row) => row.id === made.id))
      assert.ok(!listed.some((row) => row.id === onProperty.id))
      assert.deepEqual(
        InspectionPage.parse(await (await olivia("/field-inspections?outcome=compliant")).json()).items.map((row) => row.id),
        [onProperty.id],
      )
    })

    test("refuses no subject or two, a subject of another company, and findings its verdict disagrees with", async () => {
      const none = await readProblem(await olivia("/field-inspections", { method: "POST", body: { outcome: "compliant" } }))
      assert.deepEqual(none.errors, [{ path: "containerId", message: ONE_SUBJECT }])
      const theirs = await readProblem(await theirOlivia("/field-inspections", { method: "POST", body: { containerId: bin(), outcome: "compliant" } }))
      assert.deepEqual(theirs.errors, [{ path: "containerId", message: NOT_A_CONTAINER }])
      const disagree = await readProblem(await olivia("/field-inspections", { method: "POST", body: { containerId: bin(), outcome: "compliant", findings: ["damaged"] } }))
      assert.deepEqual(disagree.errors, [{ path: "findings", message: COMPLIANT_FINDS_NOTHING }])
    })

    test("is corrected while open, its verdict judged against the findings the row keeps, and changes no more once closed", async () => {
      const made = await inspection(await olivia("/field-inspections", { method: "POST", body: { containerId: bin(), outcome: "minor", findings: ["damaged"] } }), 201)
      const disagree = await readProblem(await olivia(`/field-inspections/${made.id}`, { method: "PATCH", body: { outcome: "major", findings: [] } }))
      assert.deepEqual(disagree.errors, [{ path: "findings", message: A_FINDING_TO_FOLLOW_UP }])
      const toCompliant = await readProblem(await olivia(`/field-inspections/${made.id}`, { method: "PATCH", body: { outcome: "compliant" } }))
      assert.deepEqual(toCompliant.errors, [{ path: "findings", message: COMPLIANT_FINDS_NOTHING }], "the row's findings still stand")
      const corrected = await inspection(await olivia(`/field-inspections/${made.id}`, { method: "PATCH", body: { outcome: "major", note: "Lid missing" } }))
      assert.deepEqual([corrected.outcome, corrected.findings, corrected.note], ["major", ["damaged"], "Lid missing"])
      const closed = await inspection(await olivia(`/field-inspections/${made.id}/close`, { method: "POST" }))
      assert.deepEqual([closed.status, closed.closedAt], ["closed", NOW.toISOString()])
      for (const [path, init] of [
        [`/field-inspections/${made.id}`, { method: "PATCH", body: { note: "Late" } }],
        [`/field-inspections/${made.id}/close`, { method: "POST" }],
        [`/field-inspections/${made.id}/uploads`, { method: "POST", body: { extension: "jpg" } }],
      ] as const) {
        const refused = await readProblem(await olivia(path, init))
        assert.deepEqual([refused.status, refused.detail], [409, INSPECTION_CLOSED], path)
      }
    })

    test("a photo is signed under the inspection's prefix, appended by that key once, and read back; another's key is refused", async () => {
      const made = await inspection(await olivia("/field-inspections", { method: "POST", body: { containerId: bin(), outcome: "minor", findings: ["blocked-access"] } }), 201)
      const signed = await olivia(`/field-inspections/${made.id}/uploads`, { method: "POST", body: { extension: "jpg" } })
      assert.equal(signed.status, 200, JSON.stringify(await signed.clone().json()))
      const upload = InspectionPhotoUpload.parse(await signed.json())
      assert.match(upload.objectKey, new RegExp(`^inspections/${a.companyId}/${made.id}/[0-9a-f-]{36}\\.jpg$`))
      fake.held.add(upload.objectKey)
      const appended = await inspection(await olivia(`/field-inspections/${made.id}/photos`, { method: "POST", body: { objectKey: upload.objectKey } }), 201)
      assert.deepEqual(
        appended.photos.map((photo) => photo.objectKey),
        [upload.objectKey],
      )
      const twice = await readProblem(await olivia(`/field-inspections/${made.id}/photos`, { method: "POST", body: { objectKey: upload.objectKey } }))
      assert.deepEqual([twice.status, twice.detail], [409, PHOTO_ALREADY_APPENDED])
      const other = await inspection(await olivia("/field-inspections", { method: "POST", body: { propertyId: fixtures.property.id, outcome: "compliant" } }), 201)
      const elsewhere = await readProblem(await olivia(`/field-inspections/${other.id}/photos`, { method: "POST", body: { objectKey: upload.objectKey } }))
      assert.deepEqual(elsewhere.errors, [{ path: "objectKey", message: KEY_NAMES_ANOTHER }])
      const links = InspectionPhotoLinks.parse(await (await olivia(`/field-inspections/${made.id}/photo-objects`)).json())
      assert.deepEqual(
        links.items.map(({ objectKey, url }) => ({ objectKey, url })),
        [{ objectKey: upload.objectKey, url: `https://storage.test/read/${upload.objectKey}?token=r` }],
      )
      const without = await readProblem(await oliviaWithout(`/field-inspections/${made.id}/photo-objects`), NO_PROOF_STORAGE)
      assert.equal(without.status, 503)
    })

    test("is the office's alone: a Service Provider's account reads none, and another company's is not there", async () => {
      const made = await inspection(await olivia("/field-inspections", { method: "POST", body: { containerId: bin(), outcome: "compliant" } }), 201)
      assert.equal((await lars("/field-inspections")).status, 403)
      assert.equal((await lars(`/field-inspections/${made.id}`)).status, 403)
      assert.equal((await theirOlivia(`/field-inspections/${made.id}`)).status, 404)
      assert.equal((await theirOlivia(`/field-inspections/${made.id}/photo-objects`)).status, 404)
    })
  })
})
