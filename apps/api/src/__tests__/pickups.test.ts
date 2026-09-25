import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { Pickup, PickupDetail, REASON_WITH_A_MISS } from "@waste/contracts/pickups"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { outboxEvent } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the proofs the fixtures and the corrections append, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const PickupPage = Page(Pickup)

const MODULE = "route-studio.pickups"
const NOON = new Date("2026-10-05T12:00:00Z")

describe("the pickup endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let theirs: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager: route-studio view, no project. */
  let lars: Call
  let other: Call
  let ungranted: Call
  /** A route of Harbor Commercial with one pickup, which the viewer does not work in. */
  let harbors: { id: string; label: string; pickupIds: string[] }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    theirs = await seedExecution(pool, b, await seedFleet(pool, b, await seedPlanning(pool, b)))
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    harbors = await seedRoute(pool, a, fleet, ex, { project: "harbor", pickups: [{ containerId: ex.containers.harborBin.id, propertyId: ex.properties.harbor.id }] })
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
  const read = async (id: string, call = olivia): Promise<PickupDetail> => {
    const response = await call(`/pickups/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PickupDetail.parse(await response.json())
  }
  const page = async (call: Call, query = "?limit=200") => PickupPage.parse(await (await call(`/pickups${query}`)).json())
  const command = (id: string, action: "remove" | "correct-outcome", values: unknown, call = olivia) => call(`/pickups/${id}/${action}`, { method: "POST", body: values })
  const commanded = async (id: string, action: "remove" | "correct-outcome", values: unknown, call = olivia): Promise<PickupDetail> => {
    const response = await command(id, action, values, call)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PickupDetail.parse(await response.json())
  }
  const eventsAbout = async (aggregateId: string) =>
    await withCompany(pool.db, a.companyId, async (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, projectId: outboxEvent.projectId, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )
  const fresh = (seed: Parameters<typeof seedRoute>[4] = {}) => seedRoute(pool, a, fleet, ex, seed)
  const mads = () => ({ plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id })

  describe("GET /pickups", () => {
    test("lists the caller's projects' pickups in id order, filters them by route, container, status, property and the route's operating window, and shows a foreman nothing", async () => {
      const everything = await page(olivia)
      const ids = everything.items.map((stop) => stop.id)
      assert.deepEqual(ids.slice(0, 9), [...ex.routes.ready.pickupIds, ...ex.routes.planned.pickupIds, ...ex.routes.completed.pickupIds], "the order they were made in")
      assert.ok(ids.includes(harbors.pickupIds[0]), "Olivia works in every project")
      assert.ok(!ids.includes(theirs.routes.ready.pickupIds[0]), "and sees no other company's")
      const filtered = async (query: string, call = olivia) => (await page(call, `?limit=200${query}`)).items.map((stop) => stop.id)
      assert.deepEqual(await filtered(`&routeId=${ex.routes.completed.id}`), ex.routes.completed.pickupIds)
      assert.deepEqual(await filtered(`&routeId=${ex.routes.completed.id}&status=failed`), [ex.routes.completed.pickupIds[1]])
      assert.deepEqual(await filtered(`&containerId=${ex.containers.harborBin.id}`), harbors.pickupIds)
      assert.deepEqual(await filtered(`&propertyId=${ex.properties.harbor.id}`), harbors.pickupIds)
      assert.deepEqual(await filtered(`&projectId=${a.projects.harbor.id}`), harbors.pickupIds)
      assert.deepEqual(await filtered(`&from=2026-10-06&to=2026-10-07`), [], "no route operates that week")
      assert.ok((await filtered(`&from=${ex.day}&to=${ex.day}`)).includes(ex.routes.ready.pickupIds[0]))
      assert.deepEqual((await page(olivia, "?limit=2")).items.map((stop) => stop.id), ex.routes.ready.pickupIds.slice(0, 2))
      assert.ok(!(await filtered("", viewer)).includes(harbors.pickupIds[0]), "the viewer works in Copenhagen only")
      assert.deepEqual(await page(lars), { items: [], nextCursor: null }, "a provider's foreman lists nothing")
    })

    test("refuses a route out of reach on the query, a backwards window, a project out of reach and a role without view", async () => {
      const foreign = await refused(await olivia(`/pickups?routeId=${theirs.routes.ready.id}`), 400)
      assert.deepEqual(foreign.errors, [{ path: "routeId", message: "Not a route of this project" }])
      const harbor = await refused(await viewer(`/pickups?routeId=${harbors.id}`), 400)
      assert.deepEqual(harbor.errors, [{ path: "routeId", message: "Not a route of this project" }])
      assert.deepEqual((await refused(await olivia("/pickups?from=2026-10-06&to=2026-10-05"), 400)).errors?.map((error) => error.path), ["to"])
      assert.deepEqual((await refused(await viewer(`/pickups?projectId=${a.projects.harbor.id}`), 400)).errors?.map((error) => error.path), ["projectId"])
      assert.match((await refused(await ungranted("/pickups"), 403)).detail ?? "", /view on route-studio\.pickups/)
      assert.equal((await app.request("/pickups")).status, 401)
    })
  })

  describe("GET /pickups/:id", () => {
    test("answers the pickup with its proofs in recording order, and 404 outside the caller's scope", async () => {
      const [collected, failed, skipped] = ex.routes.completed.pickupIds
      const first = await read(collected)
      assert.deepEqual([first.position, first.status, first.containerId, first.propertyId, first.wasteFractionId, first.arrivedAt, first.outcomeAt], [1, "completed", ex.containers.bin1.id, ex.properties.parkvej.id, ex.fractions.residual.id, at(ex.day, "06:40").toISOString(), at(ex.day, "06:45").toISOString()])
      assert.deepEqual(first.proofs.map((proof) => [proof.kind, proof.source, proof.sessionId, proof.recordedBy, proof.location]), [
        ["arrival", "driver-app", ex.routes.completed.sessionId, ex.logins.mads.id, { type: "Point", coordinates: [12.5683, 55.6761] }],
        ["completion", "driver-app", ex.routes.completed.sessionId, ex.logins.mads.id, { type: "Point", coordinates: [12.5683, 55.6761] }],
      ])
      const second = await read(failed)
      assert.deepEqual(second.proofs.map((proof) => [proof.kind, proof.reason, proof.note]), [["arrival", null, null], ["failure", "not-presented", "No bin at the kerb"]])
      const third = await read(skipped)
      assert.deepEqual([third.status, third.reason, third.proofs], ["skipped", "route-ended", []], "closed by the route's end, nobody attempted it")
      await refused(await olivia(`/pickups/${theirs.routes.ready.pickupIds[0]}`), 404)
      assert.equal((await read(theirs.routes.ready.pickupIds[0], other)).id, theirs.routes.ready.pickupIds[0])
      await refused(await viewer(`/pickups/${harbors.pickupIds[0]}`), 404)
      await refused(await lars(`/pickups/${harbors.pickupIds[0]}`), 404)
      await refused(await olivia(`/pickups/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/pickups/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.match((await refused(await ungranted(`/pickups/${harbors.pickupIds[0]}`), 403)).detail ?? "", /view on route-studio\.pickups/)
    })
  })

  describe("POST /pickups/:id/remove", () => {
    test("skips a planned pickup of a planned or ready route as removed-by-dispatcher with the reason as its note, and writes pickup-skipped", async () => {
      const seeded = await fresh()
      const removed = await commanded(seeded.pickupIds[1], "remove", { reason: "Customer moved out" })
      assert.deepEqual([removed.status, removed.reason, removed.note, removed.outcomeAt, removed.position, removed.proofs], ["skipped", "removed-by-dispatcher", "Customer moved out", NOON.toISOString(), 2, []])
      assert.deepEqual(await read(seeded.pickupIds[1]), removed)
      const [skipped, ...more] = await eventsAbout(seeded.pickupIds[1])
      assert.equal(more.length, 0)
      assert.deepEqual([skipped.kind, skipped.aggregateKind, skipped.projectId, skipped.occurredAt.toISOString()], ["pickup-skipped", "pickup", seeded.projectId, NOON.toISOString()])
      assert.deepEqual(PickupDetail.parse(skipped.payload), removed, "the payload is the pickup as answered")
      const again = await refused(await command(seeded.pickupIds[1], "remove", { reason: "Twice" }), 409)
      assert.equal(again.detail, "Pickup 2 is already skipped", "the first outcome stands")
      const ready = await fresh({ status: "ready", ...mads() })
      assert.equal((await commanded(ready.pickupIds[0], "remove", { reason: "Bin reported stolen" })).status, "skipped", "a ready route's stops may still be removed")
      assert.deepEqual((await refused(await command(seeded.pickupIds[0], "remove", {}), 400)).errors?.map((error) => error.path), ["reason"])
    })

    test("refuses a stop of a route that runs or has ended, a pickup out of reach, and a role without edit", async () => {
      const active = await fresh({ status: "active" })
      const running = await refused(await command(active.pickupIds[0], "remove", { reason: "Too late" }), 409)
      assert.equal(running.detail, `Route ${active.label} is active; a stop is skipped by the driver`)
      const done = await refused(await command(ex.routes.completed.pickupIds[0], "remove", { reason: "Too late" }), 409)
      assert.equal(done.detail, `Route ${ex.routes.completed.label} is completed and does not change`)
      await refused(await command(theirs.routes.planned.pickupIds[0], "remove", { reason: "Mine" }), 404)
      await refused(await command(harbors.pickupIds[0], "remove", { reason: "Mine" }, viewer), 404)
      assert.match((await refused(await command(harbors.pickupIds[0], "remove", { reason: "Mine" }, lars), 403)).detail ?? "", /edit on route-studio\.pickups/, "the provider manager's charter grants route-studio view, not edit")
      assert.match((await refused(await command(harbors.pickupIds[0], "remove", { reason: "Mine" }, ungranted), 403)).detail ?? "", /edit on route-studio\.pickups/)
      assert.equal((await read(active.pickupIds[0])).status, "planned", "untouched")
    })
  })

  describe("POST /pickups/:id/correct-outcome", () => {
    test("moves a decided pickup to the outcome given, appends the correction proof after the driver's, and writes pickup-corrected", async () => {
      const [collected, failed] = ex.routes.completed.pickupIds
      const corrected = await commanded(failed, "correct-outcome", { outcome: "completed", note: "The driver found the bin round the corner" })
      assert.deepEqual([corrected.status, corrected.reason, corrected.outcomeAt], ["completed", null, NOON.toISOString()])
      assert.deepEqual(corrected.proofs.map((proof) => [proof.kind, proof.source, proof.outcome, proof.note, proof.recordedBy, proof.sessionId]), [
        ["arrival", "driver-app", null, null, ex.logins.mads.id, ex.routes.completed.sessionId],
        ["failure", "driver-app", null, "No bin at the kerb", ex.logins.mads.id, ex.routes.completed.sessionId],
        ["correction", "dispatch", "completed", "The driver found the bin round the corner", a.users.olivia.id, null],
      ], "the original proofs stand; the correction is appended")
      assert.equal(corrected.proofs[2].occurredAt, NOON.toISOString())
      const [event] = await eventsAbout(failed)
      assert.deepEqual([event.kind, event.aggregateKind, event.occurredAt.toISOString()], ["pickup-corrected", "pickup", NOON.toISOString()])
      assert.deepEqual(PickupDetail.parse(event.payload), corrected)

      const missed = await commanded(collected, "correct-outcome", { outcome: "failed", reason: "contamination", note: "The lifter jammed on a contaminated load" })
      assert.deepEqual([missed.status, missed.reason], ["failed", "contamination"])
      assert.deepEqual(missed.proofs.map((proof) => proof.kind), ["arrival", "completion", "correction"])
      const reasonOnly = await commanded(collected, "correct-outcome", { outcome: "failed", reason: "capacity", note: "Wrong reason" })
      assert.deepEqual([reasonOnly.status, reasonOnly.reason, reasonOnly.proofs.length], ["failed", "capacity", 4], "a correction may change the reason alone")
      assert.equal((await eventsAbout(collected)).length, 2)
    })

    test("holds the reason to the outcome, and refuses a planned pickup, a route that has not run, a cancelled one, and a pickup out of reach", async () => {
      const [collected] = ex.routes.completed.pickupIds
      const withReason = await refused(await command(collected, "correct-outcome", { outcome: "completed", reason: "other", note: "x" }), 400)
      assert.deepEqual(withReason.errors, [{ path: "reason", message: REASON_WITH_A_MISS }])
      const noReason = await refused(await command(collected, "correct-outcome", { outcome: "skipped", note: "x" }), 400)
      assert.deepEqual(noReason.errors, [{ path: "reason", message: REASON_WITH_A_MISS }])
      const planned = await refused(await command(collected, "correct-outcome", { outcome: "planned", note: "x" }), 400)
      assert.deepEqual(planned.errors?.map((error) => error.path), ["outcome"], "planned is no outcome")
      assert.deepEqual((await refused(await command(collected, "correct-outcome", { outcome: "completed" }), 400)).errors?.map((error) => error.path), ["note"])

      const active = await fresh({ status: "active" })
      const undecided = await refused(await command(active.pickupIds[0], "correct-outcome", { outcome: "completed", note: "x" }), 409)
      assert.equal(undecided.detail, "Pickup 1 has no outcome to correct")
      const notRun = await refused(await command(ex.routes.planned.pickupIds[0], "correct-outcome", { outcome: "completed", note: "x" }), 409)
      assert.equal(notRun.detail, `Route ${ex.routes.planned.label} has not run`)
      const cancelled = await fresh({ status: "cancelled", pickups: [{ containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, status: "skipped", reason: "route-cancelled", outcomeAt: at(ex.day, "05:00") }] })
      const gone = await refused(await command(cancelled.pickupIds[0], "correct-outcome", { outcome: "completed", note: "x" }), 409)
      assert.equal(gone.detail, `Route ${cancelled.label} is cancelled and does not change`)
      await refused(await command(theirs.routes.completed.pickupIds[0], "correct-outcome", { outcome: "completed", note: "x" }), 404)
      await refused(await command(harbors.pickupIds[0], "correct-outcome", { outcome: "completed", note: "x" }, viewer), 404)
      assert.match((await refused(await command(harbors.pickupIds[0], "correct-outcome", { outcome: "completed", note: "x" }, ungranted), 403)).detail ?? "", /edit on route-studio\.pickups/)
    })
  })
})
