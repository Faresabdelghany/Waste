// Fill-level Sensors (O26 of #290, row 9.10): a sensor registered by its
// identifier, paired with a container of its project over a period, and read
// with the pairing in force today and its newest reading; the vendor-neutral
// ingest, each reading judged alone — recorded and tied to the pairing in
// force on its day, replayed, or refused with why — and the fences: another
// project's sensor is unknown to the ingest and absent to the reads, and the
// integration's role views and creates and edits nothing.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { FillReading, FillReadingResults, Sensor, SensorPairing } from "@waste/contracts/sensors"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"
import { containerType } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { withCompany } from "@waste/db/tenant"
import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"

import { createApp } from "../app"
import { Allowance } from "../auth/public-door"
import { RETIRED_SENSOR, SENSOR_READINGS_MAX_BYTES, stillPaired } from "../routes/sensors"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the readings this suite appends, which `wms_api` may not delete. */
const ownerDatabase = ownerUnderTest()

/** The API's clock in these tests: mid-morning in Copenhagen on 29 October. */
const NOW = new Date("2026-10-29T09:00:00Z")
const TODAY = "2026-10-29"

describe("fill-level sensors", { skip: database.skip || ownerDatabase.skip }, () => {
  let pool: Database
  let owner: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  /** The viewer's account on the Integration Writer's grants, with Project Access to Copenhagen Central alone. */
  let integration: Call
  let other: Call
  const ids = { binType: testId(), harborBin: testId() }

  const SensorPage = Page(Sensor)
  const ReadingPage = Page(FillReading)
  const PairingPage = Page(SensorPairing)

  const sensorIn = (projectId: string, identifier: string) => ({ projectId, identifier, network: "lorawan" })
  const register = async (call: Call, projectId: string, identifier: string): Promise<Sensor> =>
    created(call, "/sensors", await call("/sensors", { method: "POST", body: sensorIn(projectId, identifier) }), Sensor)
  const pair = async (call: Call, sensorId: string, body: Record<string, unknown>): Promise<SensorPairing> =>
    created(call, `/sensors/${sensorId}/pairings`, await call(`/sensors/${sensorId}/pairings`, { method: "POST", body }), SensorPairing, "/sensor-pairings")
  const ingest = async (call: Call, readings: unknown[]): Promise<FillReadingResults> => {
    const response = await call("/sensor-readings", { method: "POST", body: { readings } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return FillReadingResults.parse(await response.json())
  }
  const read = async <T>(call: Call, path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
    const response = await call(path)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const refused = async (response: Response, status: number): Promise<string> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return (await readProblem(response)).detail ?? ""
  }
  const unique = (name: string) => `${name}-${testId().slice(-8)}`
  /** A container of Copenhagen Central of the test's own, so no test's pairings meet another's. */
  const bin = async (): Promise<string> => {
    const id = testId()
    await withCompany(pool.db, a.companyId, (tx) => tx.insert(container).values({ id, companyId: a.companyId, projectId: a.projects.copenhagen.id, label: unique("BIN"), containerTypeId: ids.binType, ownership: "company" }))
    return id
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    owner = createDb(ownerDatabase.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    const writer = SYSTEM_ROLES.find((role) => role.key === "integration-writer")!
    await grantRole(pool, a.companyId, a.roles.viewer.id, writer.grants)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    integration = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    await withCompany(pool.db, a.companyId, async (tx) => {
      await tx.insert(containerType).values({ id: ids.binType, companyId: a.companyId, name: "240 L" })
      await tx.insert(container).values({ id: ids.harborBin, companyId: a.companyId, projectId: a.projects.harbor.id, label: unique("BIN"), containerTypeId: ids.binType, ownership: "company" })
    })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, owner)
    if (b) await dropTenant(pool, b.companyId, owner)
    await pool?.close()
    await owner?.close()
  })

  describe("a sensor", () => {
    test("is registered active by its identifier, unique across the company, on no container and with no reading yet", async () => {
      const identifier = unique("70B3D57E")
      const sensor = await register(olivia, a.projects.copenhagen.id, identifier)
      assert.deepEqual([sensor.status, sensor.pairing, sensor.lastReading], ["active", null, null])
      assert.match(await refused(await olivia("/sensors", { method: "POST", body: sensorIn(a.projects.harbor.id, identifier) }), 409), /already has a sensor/)
      const page = await read(olivia, `/sensors?projectId=${a.projects.copenhagen.id}`, SensorPage)
      assert.ok(page.items.some((item) => item.id === sensor.id))
    })

    test("is paired with a container of its project, which it then measures today, one container at a time and one sensor per container", async () => {
      const [spare, other] = [await bin(), await bin()]
      const sensor = await register(olivia, a.projects.copenhagen.id, unique("S"))
      const pairing = await pair(olivia, sensor.id, { containerId: spare, validFrom: "2026-10-01", validTo: "2026-11-01" })
      assert.equal(pairing.fullThresholdPercent, 85)
      const now = await read(olivia, `/sensors/${sensor.id}`, Sensor)
      assert.equal(now.pairing?.id, pairing.id)
      // The container's other sensor over the same days, and this sensor on another container over them, are both overlaps.
      const second = await register(olivia, a.projects.copenhagen.id, unique("S"))
      assert.match(await refused(await olivia(`/sensors/${second.id}/pairings`, { method: "POST", body: { containerId: spare, validFrom: "2026-10-15" } }), 409), /measured by another sensor/)
      assert.match(await refused(await olivia(`/sensors/${sensor.id}/pairings`, { method: "POST", body: { containerId: other, validFrom: "2026-10-20" } }), 409), /paired with another container/)
      // After the end, the container is free.
      await pair(olivia, second.id, { containerId: spare, validFrom: "2026-11-01" })
      // Another project's container is a 400 at the field.
      const problem = await readProblem(await olivia(`/sensors/${sensor.id}/pairings`, { method: "POST", body: { containerId: ids.harborBin, validFrom: "2026-12-01" } }))
      assert.deepEqual(problem.errors, [{ path: "containerId", message: "Not a container of this project" }])
      assert.equal((await read(olivia, `/sensors/${sensor.id}/pairings`, PairingPage)).items.length, 1)
    })

    test("a pairing's end moves, held to its start and to the other pairings; null leaves it open", async () => {
      const measured = await bin()
      const sensor = await register(olivia, a.projects.copenhagen.id, unique("S"))
      const pairing = await pair(olivia, sensor.id, { containerId: measured, validFrom: "2026-09-01", validTo: "2026-09-15", fullThresholdPercent: 90 })
      const patched = async (body: Record<string, unknown>) => olivia(`/sensor-pairings/${pairing.id}`, { method: "PATCH", body })
      assert.equal(SensorPairing.parse(await (await patched({ fullThresholdPercent: 75 })).json()).fullThresholdPercent, 75)
      await refused(await patched({ validTo: "2026-09-01" }), 400)
      assert.equal(SensorPairing.parse(await (await patched({ validTo: "2026-09-20" })).json()).validTo, "2026-09-20")
      // The bin measured by another sensor from 1 October: this pairing left open would run into it.
      await pair(olivia, (await register(olivia, a.projects.copenhagen.id, unique("S"))).id, { containerId: measured, validFrom: "2026-10-01" })
      assert.match(await refused(await patched({ validTo: null }), 409), /measured by another sensor/)
      assert.equal(SensorPairing.parse(await (await patched({ validTo: "2026-10-01" })).json()).validTo, "2026-10-01", "up to the day the other begins")
    })

    test("is retired only once nothing is paired on or after today, and is then paired with nothing new", async () => {
      const sensor = await register(olivia, a.projects.copenhagen.id, unique("S"))
      const pairing = await pair(olivia, sensor.id, { containerId: await bin(), validFrom: "2026-10-10", validTo: "2026-10-30" })
      assert.equal(await refused(await olivia(`/sensors/${sensor.id}`, { method: "PATCH", body: { status: "retired" } }), 409), stillPaired(1))
      await olivia(`/sensor-pairings/${pairing.id}`, { method: "PATCH", body: { validTo: TODAY } })
      const retired = Sensor.parse(await (await olivia(`/sensors/${sensor.id}`, { method: "PATCH", body: { status: "retired" } })).json())
      assert.deepEqual([retired.status, retired.pairing], ["retired", null])
      assert.equal(await refused(await olivia(`/sensors/${sensor.id}/pairings`, { method: "POST", body: { containerId: await bin(), validFrom: "2027-01-01" } }), 409), RETIRED_SENSOR)
    })
  })

  describe("the ingest", () => {
    test("records each reading tied to the pairing in force on its day, replays a reading sent twice, and refuses what it cannot take, in the body's order", async () => {
      const identifier = unique("S")
      const sensor = await register(olivia, a.projects.copenhagen.id, identifier)
      const measured = await bin()
      const pairing = await pair(olivia, sensor.id, { containerId: measured, validFrom: "2026-10-20", validTo: "2026-10-28" })
      const retired = await register(olivia, a.projects.copenhagen.id, unique("S"))
      await olivia(`/sensors/${retired.id}`, { method: "PATCH", body: { status: "retired" } })
      const before = { sensorIdentifier: identifier, measuredAt: "2026-10-19T21:30:00Z", fillPercent: 20 }
      // 22:30 UTC on 19 October is already 20 October in Copenhagen: the pairing's first day.
      const onTheFirstDay = { sensorIdentifier: identifier, measuredAt: "2026-10-19T22:30:00Z", fillPercent: 40, batteryPercent: 88, rssiDbm: -101 }
      const after = { sensorIdentifier: identifier, measuredAt: "2026-10-28T08:00:00Z", fillPercent: 90 }
      const results = await ingest(integration, [
        before,
        onTheFirstDay,
        after,
        onTheFirstDay,
        { sensorIdentifier: "NO-SUCH-SENSOR", measuredAt: "2026-10-28T08:00:00Z", fillPercent: 10 },
        { sensorIdentifier: retired.identifier, measuredAt: "2026-10-28T08:00:00Z", fillPercent: 10 },
        { sensorIdentifier: identifier, measuredAt: "2026-10-29T09:06:00Z", fillPercent: 10 },
      ])
      assert.deepEqual(
        results.results.map((result) => (result.outcome === "refused" ? result.reason : result.outcome)),
        ["recorded", "recorded", "recorded", "replayed", "unknown-sensor", "retired-sensor", "ahead-of-clock"],
      )
      const [, first, , again] = results.results
      assert.ok(first?.outcome === "recorded" && again?.outcome === "replayed")
      assert.equal(again.id, first.id, "the replay names the row already recorded")
      assert.deepEqual((await ingest(integration, [after])).results.map((result) => result.outcome), ["replayed"], "a batch sent again records nothing")

      const readings = await read(olivia, `/sensors/${sensor.id}/readings`, ReadingPage)
      assert.deepEqual(
        readings.items.map((reading) => [reading.fillPercent, reading.pairingId, reading.containerId]),
        [
          [90, null, null],
          [40, pairing.id, measured],
          [20, null, null],
        ],
        "newest recorded first; before the pairing and after its end, none",
      )
      assert.deepEqual([readings.items[1]?.batteryPercent, readings.items[1]?.rssiDbm], [88, -101])
      const now = await read(olivia, `/sensors/${sensor.id}`, Sensor)
      assert.deepEqual([now.lastReading?.fillPercent, now.lastReading?.measuredAt, now.pairing], [90, "2026-10-28T08:00:00.000Z", null], "the newest by its measurement, and no pairing in force today")
    })

    test("knows only the sensors of the caller's projects, and refuses a batch that is not one", async () => {
      const harbor = await register(olivia, a.projects.harbor.id, unique("S"))
      const theirs = await register(other, b.projects.copenhagen.id, unique("S"))
      const results = await ingest(integration, [
        { sensorIdentifier: harbor.identifier, measuredAt: "2026-10-28T08:00:00Z", fillPercent: 10 },
        { sensorIdentifier: theirs.identifier, measuredAt: "2026-10-28T08:00:00Z", fillPercent: 10 },
      ])
      assert.deepEqual(results.results.map((result) => (result.outcome === "refused" ? result.reason : result.outcome)), ["unknown-sensor", "unknown-sensor"])
      await refused(await integration("/sensor-readings", { method: "POST", body: { readings: [] } }), 400)
      await refused(await integration("/sensor-readings", { method: "POST", body: { readings: [{ sensorIdentifier: "S", measuredAt: "2026-10-28T08:00:00Z", fillPercent: 101 }] } }), 400)
    })
  })

  describe("the bounds", () => {
    test("a body over the size bound is a 413 before the token is read, and a company past its batches a minute a 429 with Retry-After", async () => {
      const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW, sensorIngestAllowance: new Allowance(2, () => NOW) })
      const call = callingAs(app, keys, a.users.viewer, a.companyId)
      const huge = JSON.stringify({ readings: [{ sensorIdentifier: "x".repeat(SENSOR_READINGS_MAX_BYTES), measuredAt: "2026-10-28T08:00:00Z", fillPercent: 1 }] })
      const tooLarge = await app.request("/sensor-readings", { method: "POST", headers: { "content-type": "application/json" }, body: huge })
      assert.equal(await refused(tooLarge, 413), "A batch of readings is at most 256 KiB")
      const one = [{ sensorIdentifier: "NO-SUCH-SENSOR", measuredAt: "2026-10-28T08:00:00Z", fillPercent: 1 }]
      for (let batch = 0; batch < 2; batch += 1) assert.equal((await call("/sensor-readings", { method: "POST", body: { readings: one } })).status, 200)
      const third = await call("/sensor-readings", { method: "POST", body: { readings: one } })
      assert.equal(third.headers.get("retry-after"), "60")
      assert.match(await refused(third, 429), /Too many reading batches from this company/)
    })
  })

  describe("the fences", () => {
    test("another project's or company's sensor is absent, and the integration's role registers, pairs and reads but never edits", async () => {
      const harbor = await register(olivia, a.projects.harbor.id, unique("S"))
      const theirs = await register(other, b.projects.copenhagen.id, unique("S"))
      await refused(await integration(`/sensors/${harbor.id}`), 404)
      await refused(await olivia(`/sensors/${theirs.id}`), 404)
      await refused(await integration(`/sensors?projectId=${a.projects.harbor.id}`), 400)
      const own = await register(integration, a.projects.copenhagen.id, unique("S"))
      await pair(integration, own.id, { containerId: await bin(), validFrom: "2027-02-01" })
      await refused(await integration(`/sensors/${own.id}`, { method: "PATCH", body: { notes: "Mounted under the lid" } }), 403)
    })
  })
})
