import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { OCCURRED_WINDOW_ORDERED } from "@waste/contracts/stock"
import { BOTH_GROSS_AND_TARE, NET_IS_GROSS_LESS_TARE, SAY_WHY_REFUSED, Unload } from "@waste/contracts/unloads"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { outboxEvent } from "@waste/db/schema/execution"
import { unloadingStation } from "@waste/db/schema/places"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the unloads this suite appends and the fixtures' proofs, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const UnloadPage = Page(Unload)

const MODULE = "route-studio.weights"
/** The request's clock, pinned: one in the afternoon on the fixtures' Monday, so the skew rule has a known edge. */
const AFTERNOON = new Date("2026-10-05T13:00:00Z")
/** An instant so many minutes off the pinned clock. */
const minutes = (n: number) => new Date(AFTERNOON.getTime() + n * 60_000).toISOString()

describe("the unload endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let theirFleet: FleetFixtures
  let ex: ExecutionFixtures
  let theirs: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view and create, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager: route-studio view, no project. */
  let lars: Call
  let other: Call
  let ungranted: Call
  /** A completed route of Harbor Commercial, which the viewer does not work in. */
  let harbors: { id: string; label: string }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    theirs = await seedExecution(pool, b, theirFleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => AFTERNOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    harbors = await seedRoute(pool, a, fleet, ex, { project: "harbor", status: "completed", plannedDriverId: fleet.drivers.henrik.id, plannedVehicleId: fleet.vehicles.harborTruck.id, deviceId: "device-henrik-1" })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  /** A ticket for the completed route at ARC Amager: 8,540 kg net, with whatever else the test says. */
  const ticket = (values: Record<string, unknown> = {}) => ({
    unloadingStationId: fleet.stations.amager.id,
    wasteFractionId: ex.fractions.residual.id,
    netKg: 8540,
    occurredAt: at(ex.day, "12:40").toISOString(),
    ...values,
  })
  const post = (routeId: string, values: unknown, call = olivia) => call(`/routes/${routeId}/unloads`, { method: "POST", body: values })
  // The capture is a create (#74): 201, `Location: /unloads/<id>` — the unload's own read, not the route it was posted under — and the header followed.
  const record = async (routeId: string, values: unknown, call = olivia): Promise<Unload> =>
    await created(call, `/routes/${routeId}/unloads`, await post(routeId, values, call), Unload, "/unloads")
  const one = async (id: string, call = olivia): Promise<Unload> => {
    const response = await call(`/unloads/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Unload.parse(await response.json())
  }
  const page = async (call: Call, query = "?limit=200") => UnloadPage.parse(await (await call(`/unloads${query}`)).json())
  const eventsAbout = async (aggregateId: string) =>
    await withCompany(pool.db, a.companyId, async (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, projectId: outboxEvent.projectId, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )

  describe("POST /routes/:id/unloads", () => {
    test("appends the office's unload on a completed route with the caller as its recorder and no session, reads it back on the route, and writes unload-recorded", async () => {
      const recorded = await record(ex.routes.completed.id, ticket({ grossKg: 18_540, tareKg: 10_000, weighbridgeTicket: "WB-2026-3901", note: "Ticket came by post" }))
      assert.equal(Id.parse(recorded.id), recorded.id, "a version 7 id the server minted")
      assert.deepEqual(
        [recorded.routeId, recorded.projectId, recorded.sessionId, recorded.source, recorded.recordedBy, recorded.deviceId, recorded.location],
        [ex.routes.completed.id, ex.routes.completed.projectId, null, "dispatch", a.users.olivia.id, null, null],
      )
      assert.deepEqual([recorded.unloadingStationId, recorded.wasteFractionId, recorded.grossKg, recorded.tareKg, recorded.netKg, recorded.weighbridgeTicket, recorded.note], [fleet.stations.amager.id, ex.fractions.residual.id, 18_540, 10_000, 8540, "WB-2026-3901", "Ticket came by post"])
      assert.equal(recorded.occurredAt, at(ex.day, "12:40").toISOString())
      assert.deepEqual(await one(recorded.id), recorded)
      const detail = await (await olivia(`/routes/${ex.routes.completed.id}`)).json()
      assert.deepEqual((detail as { unloads: unknown[] }).unloads, [recorded], "read with the route, oldest first")
      const [event, ...more] = await eventsAbout(recorded.id)
      assert.equal(more.length, 0)
      assert.deepEqual([event.kind, event.aggregateKind, event.projectId, event.occurredAt.toISOString()], ["unload-recorded", "unload", recorded.projectId, recorded.occurredAt])
      assert.deepEqual(Unload.parse(event.payload), recorded, "the payload is the unload as answered")

      const netOnly = await record(ex.routes.completed.id, ticket({ occurredAt: at(ex.day, "12:50").toISOString() }))
      assert.deepEqual([netOnly.grossKg, netOnly.tareKg, netOnly.netKg, netOnly.weighbridgeTicket], [null, null, 8540, null], "a net alone is a reading too")
      const active = await seedRoute(pool, a, fleet, ex, { status: "active", plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id, deviceId: "device-mads-2" })
      assert.equal((await record(active.id, ticket({ occurredAt: at(ex.day, "11:00").toISOString() }))).routeId, active.id, "and on a route still running")
    })

    test("holds the weights to the table's sentence, the station and the fraction to the company, and the instant to the skew, each at its field", async () => {
      const routeId = ex.routes.completed.id
      const halfPair = await refused(await post(routeId, ticket({ grossKg: 18_540 })), 400)
      assert.deepEqual(halfPair.errors, [{ path: "tareKg", message: BOTH_GROSS_AND_TARE }])
      const otherHalf = await refused(await post(routeId, ticket({ tareKg: 10_000 })), 400)
      assert.deepEqual(otherHalf.errors, [{ path: "tareKg", message: BOTH_GROSS_AND_TARE }])
      const sums = await refused(await post(routeId, ticket({ grossKg: 18_540, tareKg: 10_000, netKg: 8000 })), 400)
      assert.deepEqual(sums.errors, [{ path: "netKg", message: NET_IS_GROSS_LESS_TARE }])
      assert.deepEqual((await refused(await post(routeId, ticket({ netKg: 0 })), 400)).errors?.map((error) => error.path), ["netKg"], "a weight is positive")
      const station = await refused(await post(routeId, ticket({ unloadingStationId: theirFleet.stations.amager.id })), 400)
      assert.deepEqual(station.errors, [{ path: "unloadingStationId", message: "Not an unloading station of this company" }])
      const fraction = await refused(await post(routeId, ticket({ wasteFractionId: theirs.fractions.residual.id })), 400)
      assert.deepEqual(fraction.errors, [{ path: "wasteFractionId", message: "Not a waste fraction of this company" }])
      const prophecy = await refused(await post(routeId, ticket({ occurredAt: minutes(6) })), 400)
      assert.deepEqual(prophecy.errors, [{ path: "occurredAt", message: "Recorded after it happened" }])
      assert.equal((await record(routeId, ticket({ occurredAt: minutes(4) }))).occurredAt, minutes(4), "a device's clock four minutes ahead is a device's clock")
      const owned = await refused(await post(routeId, ticket({ sessionId: testId() })), 400)
      assert.ok(owned.errors?.some((error) => /sessionId/.test(error.message)), "the server owns the session, the source and the recorder: a member of the caller's is refused by name")
      assert.deepEqual((await refused(await post(routeId, { netKg: 100 }), 400)).errors?.map((error) => error.path).sort(), ["occurredAt", "unloadingStationId", "wasteFractionId"])
      // Any station of the company, since a full truck unloads where it can; but an accepted load is of a fraction the station takes (O9 of #290).
      const notTaken = await refused(await post(routeId, ticket({ wasteFractionId: ex.fractions.glass.id, netKg: 600, occurredAt: at(ex.day, "12:55").toISOString() })), 400)
      assert.deepEqual(notTaken.errors, [{ path: "wasteFractionId", message: "Station ARC Amager Bakke does not take Glass" }])
    })

    test("refuses a route that has not run and a cancelled one (409), one out of reach (404), and a role without create (403)", async () => {
      const planned = await refused(await post(ex.routes.planned.id, ticket()), 409)
      assert.equal(planned.detail, `Route ${ex.routes.planned.label} has not run`)
      const ready = await refused(await post(ex.routes.ready.id, ticket()), 409)
      assert.equal(ready.detail, `Route ${ex.routes.ready.label} has not run`)
      const cancelled = await seedRoute(pool, a, fleet, ex, { status: "cancelled" })
      assert.equal((await refused(await post(cancelled.id, ticket()), 409)).detail, `Route ${cancelled.label} is cancelled and does not change`)
      await refused(await post(theirs.routes.completed.id, ticket()), 404)
      await refused(await post(harbors.id, ticket(), viewer), 404)
      assert.match((await refused(await post(harbors.id, ticket(), lars), 403)).detail ?? "", /create on route-studio\.weights/, "the provider manager's charter grants route-studio view, not create")
      assert.match((await refused(await post(harbors.id, ticket(), ungranted), 403)).detail ?? "", /create on route-studio\.weights/)
      assert.equal((await app.request(`/routes/${harbors.id}/unloads`, { method: "POST", body: JSON.stringify(ticket()), headers: { "content-type": "application/json" } })).status, 401)
      assert.deepEqual((await page(olivia, `?limit=200&routeId=${ex.routes.planned.id}`)).items, [], "nothing written")
    })
  })

  describe("the weighbridge in the office (O9 of #290)", () => {
    test("a load the station refused carries its reason and its words, of any fraction, and `other` needs the words; a station that names no fraction takes none", async () => {
      const routeId = ex.routes.completed.id
      const turnedAway = await record(routeId, ticket({ wasteFractionId: ex.fractions.glass.id, netKg: 640, occurredAt: at(ex.day, "12:56").toISOString(), refusal: { reason: "fraction-not-accepted", note: "Glass in the residual bay" } }))
      assert.deepEqual(turnedAway.refusal, { reason: "fraction-not-accepted", note: "Glass in the residual bay" })
      assert.deepEqual(await one(turnedAway.id), turnedAway)
      const [event] = await eventsAbout(turnedAway.id)
      assert.deepEqual(Unload.parse(event.payload).refusal, turnedAway.refusal, "the outbox carries the refusal with the unload")
      assert.deepEqual((await record(routeId, ticket({ occurredAt: at(ex.day, "12:57").toISOString(), refusal: { reason: "overweight" } }))).refusal, { reason: "overweight", note: null }, "a reason from the list may stand alone")
      assert.equal((await record(routeId, ticket({ occurredAt: at(ex.day, "12:58").toISOString() }))).refusal, null, "a load the station took")
      const wordless = await refused(await post(routeId, ticket({ refusal: { reason: "other" } })), 400)
      assert.deepEqual(wordless.errors, [{ path: "refusal.note", message: SAY_WHY_REFUSED }])
      const unknown = await refused(await post(routeId, ticket({ refusal: { reason: "smelly" } })), 400)
      assert.deepEqual(unknown.errors?.map((error) => error.path), ["refusal.reason"])

      const bare = testId()
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.insert(unloadingStation).values({ id: bare, companyId: a.companyId, code: "GLASVAERK", name: "Glasværket", address: "Kraftværksvej 1, 2300 København S", location: { type: "Point", coordinates: [12.61, 55.67] }, ownership: "external", weighbridge: true, status: "active" })
      })
      const none = await refused(await post(routeId, ticket({ unloadingStationId: bare })), 400)
      assert.deepEqual(none.errors, [{ path: "wasteFractionId", message: "Station Glasværket has no accepted fractions set" }])
      assert.equal((await record(routeId, ticket({ unloadingStationId: bare, occurredAt: at(ex.day, "12:59").toISOString(), refusal: { reason: "fraction-not-accepted" } }))).unloadingStationId, bare, "and a load it refused is recorded there")
    })

    test("each unload reads what the stops of its fraction weighed on board since the route's last accepted unload of it, against the project's tolerance", async () => {
      const route = await seedRoute(pool, a, fleet, ex, {
        status: "completed",
        plannedDriverId: fleet.drivers.mads.id,
        plannedVehicleId: fleet.vehicles.wh24.id,
        deviceId: "device-mads-9",
        pickups: [
          { containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, status: "completed", arrivedAt: at(ex.day, "08:00"), outcomeAt: at(ex.day, "08:05") },
          { containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id, status: "completed", arrivedAt: at(ex.day, "08:30"), outcomeAt: at(ex.day, "08:35") },
          { containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id, status: "completed", arrivedAt: at(ex.day, "10:30"), outcomeAt: at(ex.day, "10:35") },
        ],
        proofs: [
          { kind: "weight", pickupIndex: 0, occurredAt: at(ex.day, "08:04"), weightKg: 3_000 },
          { kind: "weight", pickupIndex: 1, occurredAt: at(ex.day, "08:34"), weightKg: 1_000 },
          { kind: "weight", pickupIndex: 2, occurredAt: at(ex.day, "10:34"), weightKg: 2_000 },
          // The first stop weighed again after the truck tipped: its latest weight counts, where it was first weighed.
          { kind: "weight", pickupIndex: 0, occurredAt: at(ex.day, "09:30"), weightKg: 3_200 },
        ],
      })
      const projectId = ex.routes.completed.projectId
      const first = await record(route.id, ticket({ netKg: 4_410, occurredAt: at(ex.day, "09:00").toISOString() }))
      assert.deepEqual(first.load, { onBoardKg: 4_200, deviationPercent: 5, withinTolerance: true }, "5% over what was weighed on board, the re-weighed stop counted in the load it was tipped in: within the project's 5%")
      const turnedAway = await record(route.id, ticket({ netKg: 2_000, occurredAt: at(ex.day, "11:00").toISOString(), refusal: { reason: "contamination" } }))
      assert.deepEqual(turnedAway.load, { onBoardKg: 2_000, deviationPercent: 0, withinTolerance: true })
      const tipped = await record(route.id, ticket({ netKg: 2_500, occurredAt: at(ex.day, "11:30").toISOString() }))
      assert.deepEqual(tipped.load, { onBoardKg: 2_000, deviationPercent: 25, withinTolerance: false }, "the refused load stayed on board, so the next unload carries it")
      const glass = await record(route.id, ticket({ wasteFractionId: ex.fractions.glass.id, netKg: 300, occurredAt: at(ex.day, "11:40").toISOString(), refusal: { reason: "fraction-not-accepted" } }))
      assert.equal(glass.load, null, "no stop of its fraction was weighed")

      const listed = (await page(olivia, `?limit=200&routeId=${route.id}`)).items
      assert.deepEqual(
        listed.map((row) => row.load?.onBoardKg ?? null),
        [4_200, 2_000, 2_000, null],
      )
      const detail = (await (await olivia(`/routes/${route.id}`)).json()) as { unloads: Unload[] }
      assert.deepEqual(detail.unloads, listed, "the route's detail reads the same")
      // Weight control's correction is a new row at the instant of the one it corrects, and reads the same load.
      const corrected = await olivia(`/unloads/${first.id}/correct`, { method: "POST", body: { netKg: 4_000, note: "Net misread at the bridge" } })
      assert.equal(corrected.status, 201, JSON.stringify(await corrected.clone().json()))
      const { correctionUnloadId } = (await corrected.json()) as { correctionUnloadId: string }
      assert.deepEqual((await one(correctionUnloadId)).load, { onBoardKg: 4_200, deviationPercent: -4.8, withinTolerance: true })
      assert.deepEqual((await one(first.id)).load, first.load, "and the corrected row keeps its own reading")

      // The tolerance is the project's, read at answer.
      const loosened = await olivia(`/projects/${projectId}`, { method: "PATCH", body: { weightTolerancePercent: 25 } })
      assert.equal(loosened.status, 200, JSON.stringify(await loosened.clone().json()))
      try {
        assert.equal((await one(tipped.id)).load?.withinTolerance, true)
      } finally {
        await olivia(`/projects/${projectId}`, { method: "PATCH", body: { weightTolerancePercent: 5 } })
      }
    })
  })

  describe("GET /unloads and GET /unloads/:id", () => {
    test("lists the caller's projects' unloads oldest first, filters them by route, station, fraction and the window over occurredAt, and shows a foreman nothing", async () => {
      const early = await record(harbors.id, ticket({ occurredAt: at(ex.day, "10:00").toISOString(), netKg: 4200 }))
      const late = await record(harbors.id, ticket({ occurredAt: at(ex.day, "12:30").toISOString(), netKg: 3100, wasteFractionId: ex.fractions.glass.id, refusal: { reason: "fraction-not-accepted" } }))
      const everything = await page(olivia)
      const ids = everything.items.map((row) => row.id)
      assert.deepEqual(
        ids,
        [...ids].sort((x, y) => x.localeCompare(y)),
        "recording order",
      )
      assert.ok(ids.includes(early.id) && ids.includes(late.id), "Olivia works in every project")
      const filtered = async (query: string, call = olivia) => (await page(call, `?limit=200${query}`)).items.map((row) => row.id)
      assert.deepEqual(await filtered(`&routeId=${harbors.id}`), [early.id, late.id])
      assert.deepEqual(await filtered(`&routeId=${harbors.id}&wasteFractionId=${ex.fractions.glass.id}`), [late.id])
      assert.deepEqual(await filtered(`&projectId=${a.projects.harbor.id}`), [early.id, late.id])
      assert.ok((await filtered(`&unloadingStationId=${fleet.stations.amager.id}`)).includes(early.id))
      assert.deepEqual(await filtered(`&unloadingStationId=${testId()}`), [])
      assert.deepEqual(await filtered(`&routeId=${harbors.id}&from=${encodeURIComponent(at(ex.day, "11:00").toISOString())}&to=${encodeURIComponent(at(ex.day, "13:00").toISOString())}`), [late.id])
      assert.deepEqual(await filtered(`&routeId=${harbors.id}&to=${encodeURIComponent(at(ex.day, "10:00").toISOString())}`), [early.id], "both ends inclusive")
      const first = await page(olivia, `?limit=1&routeId=${harbors.id}`)
      assert.deepEqual(first.items.map((row) => row.id), [early.id])
      assert.ok(first.nextCursor !== null)
      assert.deepEqual((await page(olivia, `?limit=1&routeId=${harbors.id}&cursor=${first.nextCursor}`)).items.map((row) => row.id), [late.id])
      assert.ok(!(await filtered("", viewer)).includes(early.id), "the viewer works in Copenhagen only")
      assert.deepEqual(await page(lars), { items: [], nextCursor: null }, "a provider's foreman lists nothing")

      assert.deepEqual((await refused(await olivia(`/unloads?from=${encodeURIComponent(at(ex.day, "13:00").toISOString())}&to=${encodeURIComponent(at(ex.day, "11:00").toISOString())}`), 400)).errors, [{ path: "to", message: OCCURRED_WINDOW_ORDERED }])
      assert.deepEqual((await refused(await viewer(`/unloads?routeId=${harbors.id}`), 400)).errors, [{ path: "routeId", message: "Not a route of this project" }])
      assert.deepEqual((await refused(await olivia(`/unloads?routeId=${theirs.routes.completed.id}`), 400)).errors, [{ path: "routeId", message: "Not a route of this project" }])
      assert.deepEqual((await refused(await viewer(`/unloads?projectId=${a.projects.harbor.id}`), 400)).errors?.map((error) => error.path), ["projectId"])
      assert.match((await refused(await ungranted("/unloads"), 403)).detail ?? "", /view on route-studio\.weights/)

      assert.deepEqual(await one(late.id), late)
      await refused(await viewer(`/unloads/${late.id}`), 404)
      await refused(await lars(`/unloads/${late.id}`), 404)
      const theirTicket = await record(theirs.routes.completed.id, { unloadingStationId: theirFleet.stations.amager.id, wasteFractionId: theirs.fractions.residual.id, netKg: 100, occurredAt: at(ex.day, "12:00").toISOString() }, other)
      await refused(await olivia(`/unloads/${theirTicket.id}`), 404)
      await refused(await olivia(`/unloads/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/unloads/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.match((await refused(await ungranted(`/unloads/${late.id}`), 403)).detail ?? "", /view on route-studio\.weights/)
    })
  })
})
