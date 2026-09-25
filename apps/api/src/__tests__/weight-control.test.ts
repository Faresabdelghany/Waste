import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { RouteDetail } from "@waste/contracts/routes"
import { BOTH_GROSS_AND_TARE, NET_IS_GROSS_LESS_TARE, Unload } from "@waste/contracts/unloads"
import { WeightReview } from "@waste/contracts/weight-control"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { outboxEvent } from "@waste/db/schema/execution"
import { weightReview } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { correctedUnload } from "@waste/domain/finance/transitions"
import { and, asc, count, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the reviews and the unloads this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const UnloadPage = Page(Unload)
const ReviewPage = Page(WeightReview)

const MODULE = "route-studio.weights"
/** The request's clock, pinned: one in the afternoon on the fixtures' Monday, after every ticket here was tipped. */
const AFTERNOON = new Date("2026-10-05T13:00:00Z")
/** The reading every unload starts with. */
const CAPTURED = { status: "captured", latestReviewId: null, correctionUnloadId: null }

describe("the weight control endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager: route-studio view by charter, no project. */
  let lars: Call
  let other: Call
  let ungranted: Call
  /** A completed route of Harbor Commercial, which the viewer does not work in. */
  let harbors: SeededRoute

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
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
  /** A ticket for a route at ARC Amager: 8,540 kg net at 12:40, with whatever else the test says. */
  const ticket = (values: Record<string, unknown> = {}) => ({
    unloadingStationId: fleet.stations.amager.id,
    wasteFractionId: ex.fractions.residual.id,
    netKg: 8540,
    occurredAt: at(ex.day, "12:40").toISOString(),
    ...values,
  })
  const record = async (routeId: string, values: unknown = ticket(), call = olivia): Promise<Unload> =>
    await created(call, `/routes/${routeId}/unloads`, await call(`/routes/${routeId}/unloads`, { method: "POST", body: values }), Unload, "/unloads")
  const one = async (id: string, call = olivia): Promise<Unload> => {
    const response = await call(`/unloads/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Unload.parse(await response.json())
  }
  const page = async (call: Call, query = "?limit=200") => UnloadPage.parse(await (await call(`/unloads${query}`)).json())
  const decide = (id: string, verb: "approve" | "reject" | "correct", body: unknown = {}, call = olivia) => call(`/unloads/${id}/${verb}`, { method: "POST", body })
  /** A decision that appended: 201, the review, and no `Location` — a review has no address of its own. */
  const appended = async (response: Response): Promise<WeightReview> => {
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    assert.equal(response.headers.get("location"), null, "an appended review has no address of its own to name")
    return WeightReview.parse(await response.json())
  }
  /** A decision already taken: 200 with the review that took it. */
  const stood = async (response: Response): Promise<WeightReview> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return WeightReview.parse(await response.json())
  }
  const reviews = async (id: string, query = "?limit=200", call = olivia) => {
    const response = await call(`/unloads/${id}/reviews${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ReviewPage.parse(await response.json())
  }
  const eventsAbout = async (aggregateId: string) =>
    await withCompany(pool.db, a.companyId, async (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )
  const reviewRowsOf = async (unloadId: string) => {
    const [row] = await ownerPool.db
      .select({ rows: count() })
      .from(weightReview)
      .where(and(eq(weightReview.companyId, a.companyId), eq(weightReview.unloadId, unloadId)))
    return row?.rows ?? 0
  }

  describe("POST /unloads/:id/approve and /reject", () => {
    test("append a review the unload reads as its status; the same decision again is 200 with the review that took it and no write; the unload's own row never moves", async () => {
      const u = await record(ex.routes.completed.id, ticket({ weighbridgeTicket: "WB-2026-3901" }))
      assert.deepEqual(u.weightReview, CAPTURED, "nobody has looked")

      const approval = await appended(await decide(u.id, "approve"))
      assert.equal(Id.parse(approval.id), approval.id, "a version 7 id the server minted")
      assert.deepEqual([approval.unloadId, approval.projectId, approval.decision, approval.note, approval.correctionUnloadId, approval.reviewedBy], [u.id, u.projectId, "approved", null, null, a.users.olivia.id])
      const approved = await one(u.id)
      assert.deepEqual(approved, { ...u, weightReview: { status: "approved", latestReviewId: approval.id, correctionUnloadId: null } }, "the reading moved and nothing else on the row did")
      assert.deepEqual(await stood(await decide(u.id, "approve", { note: "Looks right" })), approval, "approving an approved unload is nothing to do: the review that approved it, its note as it was")
      assert.deepEqual((await reviews(u.id)).items, [approval])

      assert.deepEqual((await refused(await decide(u.id, "reject", {}), 400)).errors?.map((error) => error.path), ["note"], "a rejection says why")
      const rejection = await appended(await decide(u.id, "reject", { note: "Ticket illegible; ask the station for a copy" }))
      assert.deepEqual([rejection.decision, rejection.note, rejection.correctionUnloadId, rejection.reviewedBy], ["rejected", "Ticket illegible; ask the station for a copy", null, a.users.olivia.id])
      assert.deepEqual((await one(u.id)).weightReview, { status: "rejected", latestReviewId: rejection.id, correctionUnloadId: null })
      assert.deepEqual(await stood(await decide(u.id, "reject", { note: "Still illegible" })), rejection)
      assert.deepEqual((await reviews(u.id)).items, [approval, rejection], "oldest first, and the same decision again wrote nothing")

      assert.deepEqual((await refused(await decide(u.id, "approve", { decision: "approved" }), 400)).errors?.map((error) => error.path), ["decision"], "a member the command does not take is refused by name")
      const second = await appended(await decide(u.id, "approve", { note: "Copy received" }))
      assert.deepEqual([second.decision, second.note], ["approved", "Copy received"])
      const history = (await reviews(u.id)).items
      assert.deepEqual(history, [approval, rejection, second], "every row as it was appended: the ledger is never updated")
      assert.deepEqual(await one(u.id), { ...u, weightReview: { status: "approved", latestReviewId: second.id, correctionUnloadId: null } })
      assert.equal(await reviewRowsOf(u.id), 3)
      assert.deepEqual(
        (await eventsAbout(u.id)).map((event) => event.kind),
        ["unload-recorded"],
        "a review publishes nothing",
      )
      // The viewer holds edit on Copenhagen: a Copenhagen unload takes their decision, and they read it back.
      const theirDecision = await stood(await decide(u.id, "approve", {}, viewer))
      assert.deepEqual(theirDecision, second)
    })
  })

  describe("POST /unloads/:id/correct", () => {
    test("writes a new unload on the same route, station, fraction and instant with the body's weights and a corrected review naming it; the corrected unload refuses every command; no unload-recorded for the correction", async () => {
      const u = await record(ex.routes.completed.id, ticket({ grossKg: 18_540, tareKg: 10_000, weighbridgeTicket: "WB-2026-3902", occurredAt: at(ex.day, "12:50").toISOString(), note: "Second tip" }))

      const halfPair = await refused(await decide(u.id, "correct", { netKg: 8340, grossKg: 18_340, note: "Misread" }), 400)
      assert.deepEqual(halfPair.errors, [{ path: "tareKg", message: BOTH_GROSS_AND_TARE }])
      const sums = await refused(await decide(u.id, "correct", { netKg: 8000, grossKg: 18_340, tareKg: 10_000, note: "Misread" }), 400)
      assert.deepEqual(sums.errors, [{ path: "netKg", message: NET_IS_GROSS_LESS_TARE }])
      assert.deepEqual((await refused(await decide(u.id, "correct", { netKg: 8340 }), 400)).errors?.map((error) => error.path), ["note"], "a correction says what was wrong")
      assert.deepEqual(await one(u.id), u, "a refused correction wrote nothing")

      const correction = await appended(await decide(u.id, "correct", { netKg: 8340, grossKg: 18_340, tareKg: 10_000, weighbridgeTicket: "WB-2026-3902 (re-read)", note: "Gross misread by 200 kg" }))
      assert.deepEqual([correction.unloadId, correction.decision, correction.note, correction.reviewedBy], [u.id, "corrected", "Gross misread by 200 kg", a.users.olivia.id])
      assert.ok(correction.correctionUnloadId !== null && correction.correctionUnloadId !== u.id, "a correction names the new unload it wrote, never the one reviewed")
      const fresh = await one(correction.correctionUnloadId)
      assert.equal(Id.parse(fresh.id), fresh.id)
      assert.deepEqual(
        [fresh.routeId, fresh.projectId, fresh.unloadingStationId, fresh.wasteFractionId, fresh.occurredAt, fresh.source, fresh.recordedBy, fresh.sessionId, fresh.deviceId, fresh.location, fresh.objectKey],
        [u.routeId, u.projectId, u.unloadingStationId, u.wasteFractionId, u.occurredAt, "dispatch", a.users.olivia.id, null, null, null, null],
        "the same route, station, fraction and instant, the office's row, the caller's",
      )
      assert.deepEqual([fresh.grossKg, fresh.tareKg, fresh.netKg, fresh.weighbridgeTicket, fresh.note], [18_340, 10_000, 8340, "WB-2026-3902 (re-read)", "Gross misread by 200 kg"], "the body's weights, ticket and note")
      assert.deepEqual(fresh.weightReview, CAPTURED, "the new row is captured, and may be reviewed in its turn")
      assert.deepEqual((await one(u.id)).weightReview, { status: "corrected", latestReviewId: correction.id, correctionUnloadId: fresh.id })
      assert.deepEqual((await reviews(u.id)).items, [correction])

      const sentence = correctedUnload(fresh.id)
      assert.equal(sentence, `This unload was corrected by unload ${fresh.id}; review that one`)
      assert.equal((await refused(await decide(u.id, "approve"), 409)).detail, sentence)
      assert.equal((await refused(await decide(u.id, "reject", { note: "No" }), 409)).detail, sentence)
      assert.equal((await refused(await decide(u.id, "correct", { netKg: 8000, note: "Again" }), 409)).detail, sentence, "a corrected unload is corrected once: the new row takes the next correction")
      assert.equal(await reviewRowsOf(u.id), 1, "the refusals wrote nothing")
      assert.deepEqual((await page(olivia, `?limit=200&routeId=${u.routeId}`)).items.filter((row) => row.recordedBy === a.users.olivia.id && row.occurredAt === u.occurredAt).length, 2, "the refused corrections appended no unload either")

      const approvedFresh = await appended(await decide(fresh.id, "approve"))
      assert.deepEqual((await one(fresh.id)).weightReview, { status: "approved", latestReviewId: approvedFresh.id, correctionUnloadId: null })
      const twice = await appended(await decide(fresh.id, "correct", { netKg: 8300, note: "And 40 kg more" }))
      assert.notEqual(twice.correctionUnloadId, fresh.id)
      assert.deepEqual((await one(fresh.id)).weightReview, { status: "corrected", latestReviewId: twice.id, correctionUnloadId: twice.correctionUnloadId }, "corrected in its turn")

      assert.deepEqual(await eventsAbout(fresh.id), [], "the correction emits no unload-recorded")
      assert.deepEqual(
        (await eventsAbout(u.id)).map((event) => event.kind),
        ["unload-recorded"],
        "the capture did",
      )
      const route = RouteDetail.parse(await (await olivia(`/routes/${u.routeId}`)).json())
      const listed = route.unloads.filter((row) => [u.id, fresh.id].includes(row.id))
      assert.deepEqual(
        listed.map((row) => [row.id, row.weightReview.status]),
        [
          [u.id, "corrected"],
          [fresh.id, "corrected"],
        ],
        "the route's detail lists both rows with their readings",
      )
    })
  })

  describe("GET /unloads?reviewStatus= and GET /unloads/:id/reviews", () => {
    test("pages the unloads by their reading, and one unload's reviews oldest first; the family's 404s and 403s", async () => {
      const route = await seedRoute(pool, a, fleet, ex, { status: "completed", plannedDriverId: fleet.drivers.mads.id, plannedVehicleId: fleet.vehicles.wh24.id, deviceId: "device-mads-3" })
      const captured = await record(route.id, ticket({ occurredAt: at(ex.day, "10:00").toISOString() }))
      const approved = await record(route.id, ticket({ occurredAt: at(ex.day, "10:10").toISOString() }))
      const rejected = await record(route.id, ticket({ occurredAt: at(ex.day, "10:20").toISOString() }))
      const corrected = await record(route.id, ticket({ occurredAt: at(ex.day, "10:30").toISOString() }))
      const approval = await appended(await decide(approved.id, "approve"))
      const rejection = await appended(await decide(rejected.id, "reject", { note: "Wrong fraction" }))
      const correction = await appended(await decide(corrected.id, "correct", { netKg: 9000, note: "Re-weighed" }))
      const filtered = async (status: string, call = olivia) => (await page(call, `?limit=200&routeId=${route.id}&reviewStatus=${status}`)).items.map((row) => row.id)
      assert.deepEqual(await filtered("captured"), [captured.id, correction.correctionUnloadId], "the weights desk's queue: what nobody has looked at, the correction's new row included")
      assert.deepEqual(await filtered("approved"), [approved.id])
      assert.deepEqual(await filtered("rejected"), [rejected.id])
      assert.deepEqual(await filtered("corrected"), [corrected.id])
      assert.deepEqual(
        (await page(olivia, `?limit=200&routeId=${route.id}`)).items.map((row) => row.weightReview),
        [CAPTURED, { status: "approved", latestReviewId: approval.id, correctionUnloadId: null }, { status: "rejected", latestReviewId: rejection.id, correctionUnloadId: null }, { status: "corrected", latestReviewId: correction.id, correctionUnloadId: correction.correctionUnloadId }, CAPTURED],
        "every unload carries its reading on the list",
      )
      assert.deepEqual((await refused(await olivia(`/unloads?reviewStatus=needs-review`), 400)).errors?.map((error) => error.path), ["reviewStatus"], "the prototype's name is not a token")

      // One unload's history, paged.
      const busy = await record(route.id, ticket({ occurredAt: at(ex.day, "10:40").toISOString() }))
      const first = await appended(await decide(busy.id, "approve"))
      const second = await appended(await decide(busy.id, "reject", { note: "On reflection, no" }))
      const third = await appended(await decide(busy.id, "approve", { note: "Confirmed with the station" }))
      const firstPage = await reviews(busy.id, "?limit=2")
      assert.deepEqual(firstPage.items, [first, second])
      assert.ok(firstPage.nextCursor !== null)
      assert.deepEqual((await reviews(busy.id, `?limit=2&cursor=${firstPage.nextCursor}`)).items, [third])
      assert.deepEqual((await refused(await olivia(`/unloads/${busy.id}/reviews?cursor=nonsense`), 400)).errors?.map((error) => error.path), ["cursor"])

      // Scope: an unload out of reach is one that is not there, on the list, the read and every command.
      const theirs = await record(harbors.id)
      await refused(await viewer(`/unloads/${theirs.id}/reviews`), 404)
      await refused(await decide(theirs.id, "approve", {}, viewer), 404)
      await refused(await decide(theirs.id, "correct", { netKg: 100, note: "No" }, viewer), 404)
      await refused(await lars(`/unloads/${theirs.id}/reviews`), 404)
      await refused(await other(`/unloads/${busy.id}/reviews`), 404)
      await refused(await decide(busy.id, "approve", {}, other), 404)
      await refused(await olivia(`/unloads/${testId()}/reviews`), 404)
      assert.deepEqual((await refused(await olivia("/unloads/not-a-uuid/reviews"), 400)).errors?.map((error) => error.path), ["id"])
      assert.match((await refused(await decide(busy.id, "approve", {}, lars), 403)).detail ?? "", /edit on route-studio\.weights/, "the provider manager's charter grants route-studio view, not edit")
      assert.match((await refused(await ungranted(`/unloads/${busy.id}/reviews`), 403)).detail ?? "", /view on route-studio\.weights/)
      assert.match((await refused(await decide(busy.id, "reject", { note: "No" }, ungranted), 403)).detail ?? "", /edit on route-studio\.weights/)
      assert.equal((await app.request(`/unloads/${busy.id}/approve`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status, 401)
      assert.deepEqual((await reviews(busy.id)).items, [first, second, third], "nothing of the above wrote")
    })
  })

  describe("two reviews of one unload", () => {
    test("take turns: one appends, the other finds the decision already there and answers it without a write", async () => {
      const u = await record(ex.routes.completed.id, ticket({ occurredAt: at(ex.day, "11:30").toISOString() }))
      const responses = await Promise.all([decide(u.id, "approve"), decide(u.id, "approve", {}, viewer)])
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201])
      const bodies = await Promise.all(responses.map(async (response) => WeightReview.parse(await response.json())))
      assert.deepEqual(bodies[0], bodies[1], "both answer the one review")
      assert.equal(await reviewRowsOf(u.id), 1)
      assert.deepEqual((await one(u.id)).weightReview, { status: "approved", latestReviewId: bodies[0].id, correctionUnloadId: null })
    })
  })
})
