import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { A_PERIOD_ENDS, SettlementDetail, SettlementEvent } from "@waste/contracts/settlements"
import { ENDS_AFTER_IT_STARTS } from "@waste/contracts/validity"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { outboxEvent } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { closedSettlement, notCalculated } from "@waste/domain/finance/transitions"
import { and, asc, eq } from "drizzle-orm"

import { createApp } from "../app"
import { eventsMissed, ONE_SETTLEMENT_AT_A_TIME, unpricedLines } from "../routes/settlements"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { priceTheUnpricedProduct, recordServedEvent, seedSettlementFixtures, type SettlementFixtures } from "./settlement-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the settlement events this suite appends and the fixtures' proofs, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const SettlementPage = Page(SettlementDetail)
const EventPage = Page(SettlementEvent)

const MODULE = "commercial.settlements"
/** The request's clock, pinned: a morning after the period, so the stamps have a known value. */
const MORNING = new Date("2026-11-03T09:00:00Z")
/** The period every NordRen settlement here settles: June to October 2026, `validTo` the first day out. */
const PERIOD = { validFrom: "2026-06-01", validTo: "2026-11-01" }
/** How the machine's sentences name it: the provider and the period as a person reads it. */
const LABEL = "NordRen ApS · 2026-06-01–2026-10-31"

describe("the settlement endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let fx: SettlementFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager at NordRen: `commercial.settlements` view by charter, no project. */
  let lars: Call
  let other: Call
  let ungranted: Call
  /** NordRen's settlement over the period, the one the commands are proved on. */
  let s: SettlementDetail
  /** NordRen's next period, opened to prove a disjoint period is taken. */
  let next: SettlementDetail
  /** CityHaul's settlement, which Lars never sees. */
  let theirs: SettlementDetail

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    ex = await seedExecution(pool, a, fleet)
    fx = await seedSettlementFixtures(pool, a, planning, fleet, ex)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => MORNING })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
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
  const post = (path: string, body: unknown = {}, call = olivia) => call(path, { method: "POST", body })
  const open = async (body: unknown, call = olivia): Promise<SettlementDetail> => await created(call, "/settlements", await post("/settlements", body, call), SettlementDetail)
  const ok = async (response: Response): Promise<SettlementDetail> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return SettlementDetail.parse(await response.json())
  }
  const detail = (id: string, call = olivia) => call(`/settlements/${id}`).then(ok)
  const command = (id: string, verb: "calculate" | "close" | "reopen", body: unknown = {}, call = olivia) => post(`/settlements/${id}/${verb}`, body, call)
  const page = async (call: Call, query = "?limit=200") => SettlementPage.parse(await (await call(`/settlements${query}`)).json())
  const events = async (id: string, query = "?limit=200", call = olivia) => {
    const response = await call(`/settlements/${id}/events${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return EventPage.parse(await response.json())
  }
  const kindsOf = async (id: string) => (await events(id)).items.map((event) => event.kind)
  /** A line by the event it settles, as the assertions read one. */
  const lineFor = (settled: SettlementDetail, eventId: string) => {
    const line = settled.lines.find((candidate) => candidate.billableEventId === eventId)
    assert.ok(line, `a line for event ${eventId}`)
    const { serviceProviderPriceId, quantity, unitPriceMinor, netMinor } = line
    return { serviceProviderPriceId, quantity, unitPriceMinor, netMinor }
  }
  const eventsAbout = async (aggregateId: string) =>
    await withCompany(pool.db, a.companyId, async (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, projectId: outboxEvent.projectId, occurredAt: outboxEvent.occurredAt, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, aggregateId)))
        .orderBy(asc(outboxEvent.id)),
    )

  describe("POST /settlements", () => {
    test("opens a settlement on an assignment of the caller's projects over a period, in the project's currency, open and empty; holds the body to the assignment and the period; one settlement of an assignment at a time", async () => {
      s = await open({ serviceAreaAssignmentId: fx.assignments.nordren.id, ...PERIOD })
      assert.equal(Id.parse(s.id), s.id, "a version 7 id the server minted")
      assert.deepEqual(
        [s.projectId, s.serviceAreaAssignmentId, s.status, s.currency, s.calculatedAt, s.closedAt, s.closedBy, s.lineCount, s.netMinor, s.validFrom, s.validTo, s.lines],
        [a.projects.copenhagen.id, fx.assignments.nordren.id, "open", "DKK", null, null, null, 0, 0, PERIOD.validFrom, PERIOD.validTo, []],
      )
      assert.deepEqual(await detail(s.id), s)
      assert.deepEqual((await events(s.id)).items, [], "opening a settlement is not a row of its history")

      const noEnd = await refused(await post("/settlements", { serviceAreaAssignmentId: fx.assignments.nordren.id, validFrom: "2026-11-01" }), 400)
      assert.deepEqual(noEnd.errors, [{ path: "validTo", message: A_PERIOD_ENDS }])
      const backwards = await refused(await post("/settlements", { serviceAreaAssignmentId: fx.assignments.nordren.id, validFrom: "2026-11-01", validTo: "2026-11-01" }), 400)
      assert.deepEqual(backwards.errors, [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])
      const owned = await refused(await post("/settlements", { serviceAreaAssignmentId: fx.assignments.nordren.id, ...PERIOD, status: "closed" }), 400)
      assert.ok(owned.errors?.some((error) => /status/.test(error.message)), "the server owns the status, the currency and the project: a member of the caller's is refused by name")
      const nobody = await refused(await post("/settlements", { serviceAreaAssignmentId: testId(), ...PERIOD }), 400)
      assert.deepEqual(nobody.errors, [{ path: "serviceAreaAssignmentId", message: "Not an assignment of this project" }])
      // "It is not yours" and "it does not exist" are the same answer: another company's assignment id reads as none.
      assert.deepEqual((await refused(await post("/settlements", { serviceAreaAssignmentId: fx.assignments.nordren.id, ...PERIOD }, other), 400)).errors?.map((error) => error.path), ["serviceAreaAssignmentId"])

      const overlapping = await refused(await post("/settlements", { serviceAreaAssignmentId: fx.assignments.nordren.id, validFrom: "2026-10-01", validTo: "2026-12-01" }), 409)
      assert.equal(overlapping.detail, ONE_SETTLEMENT_AT_A_TIME)
      next = await open({ serviceAreaAssignmentId: fx.assignments.nordren.id, validFrom: "2026-11-01", validTo: "2026-12-01" })
      assert.equal(next.validFrom, s.validTo, "a period starting the day the other ends does not touch it")
      theirs = await open({ serviceAreaAssignmentId: fx.assignments.cityhaul.id, ...PERIOD })
      assert.equal(theirs.serviceAreaAssignmentId, fx.assignments.cityhaul.id, "another assignment over the same period is another settlement")

      assert.match((await refused(await post("/settlements", { serviceAreaAssignmentId: fx.assignments.nordren.id, ...PERIOD }, lars), 403)).detail ?? "", /create on commercial\.settlements/, "the provider manager's charter grants view, not create")
      assert.match((await refused(await post("/settlements", { serviceAreaAssignmentId: fx.assignments.nordren.id, ...PERIOD }, ungranted), 403)).detail ?? "", /create on commercial\.settlements/)
      assert.equal((await app.request("/settlements", { method: "POST", body: JSON.stringify({ serviceAreaAssignmentId: fx.assignments.nordren.id, ...PERIOD }), headers: { "content-type": "application/json" } })).status, 401)
    })
  })

  describe("POST /settlements/:id/calculate", () => {
    test("selects exactly the priced events of the period served under the assignment, prices each with the provider price valid on its service date, and appends a calculated event; a recalculation replaces the lines", async () => {
      const calculated = await ok(await command(s.id, "calculate"))
      assert.deepEqual([calculated.status, calculated.calculatedAt, calculated.closedAt, calculated.closedBy, calculated.lineCount, calculated.netMinor], ["calculated", MORNING.toISOString(), null, null, 4, 5500])
      assert.equal(calculated.lines.length, 4)
      assert.deepEqual(lineFor(calculated, fx.events.early.id), { serviceProviderPriceId: fx.prices.early.id, quantity: 1, unitPriceMinor: 5000, netMinor: 5000 }, "the fee valid in September")
      assert.deepEqual(lineFor(calculated, fx.events.late.id), { serviceProviderPriceId: fx.prices.indexed.id, quantity: 1, unitPriceMinor: 5500, netMinor: 5500 }, "the indexed fee valid in October")
      assert.deepEqual(lineFor(calculated, fx.events.unpriced.id), { serviceProviderPriceId: null, quantity: 1, unitPriceMinor: null, netMinor: null }, "no price of the assignment covers the product: an unpriced line")
      assert.deepEqual(lineFor(calculated, fx.events.reversal.id), { serviceProviderPriceId: fx.prices.early.id, quantity: 1, unitPriceMinor: 5000, netMinor: -5000 }, "a reversal at its negative amount, reaching the route through the event it undoes")
      const settled = new Set(calculated.lines.map((line) => line.billableEventId))
      for (const [name, event] of Object.entries({ beforeAssignment: fx.events.beforeAssignment, otherArea: fx.events.otherArea, cancelled: fx.events.cancelled, blocked: fx.events.blocked, manual: fx.events.manual })) {
        assert.equal(settled.has(event.id), false, `${name} is not served under the assignment`)
      }
      assert.deepEqual(
        calculated.lines.map((line) => line.settlementId),
        calculated.lines.map(() => s.id),
      )
      assert.deepEqual(await detail(s.id), calculated, "what the command answered is what the read says")
      const [first, ...more] = (await events(s.id)).items
      assert.equal(more.length, 0)
      assert.deepEqual([first.kind, first.status, first.lineCount, first.netMinor, first.reason, first.recordedBy, first.settlementId], ["calculated", "calculated", 4, 5500, null, a.users.olivia.id, s.id])

      assert.deepEqual((await refused(await command(s.id, "calculate", { force: true }), 400)).errors?.map((error) => error.path), ["force"], "the body says nothing: a member in it is refused by name")

      const again = await ok(await command(s.id, "calculate"))
      assert.deepEqual([again.status, again.lineCount, again.netMinor], ["calculated", 4, 5500])
      assert.deepEqual(new Set(again.lines.map((line) => line.billableEventId)), settled, "the same events")
      assert.equal(
        again.lines.some((line) => calculated.lines.some((before) => before.id === line.id)),
        false,
        "replaced whole: delete-then-insert, never a diff",
      )
      assert.deepEqual(await kindsOf(s.id), ["calculated", "calculated"], "a recalculation is a move, and the history gets its row")
      assert.deepEqual(await eventsAbout(s.id), [], "a calculation publishes nothing")
    })
  })

  describe("POST /settlements/:id/close", () => {
    test("refuses over an unpriced line and over an event the calculation missed, then freezes the lines, appends the closed event and emits settlement-closed once; a closed settlement takes no further command but reopen", async () => {
      assert.equal((await refused(await command(s.id, "close"), 409)).detail, unpricedLines(1))
      assert.equal(unpricedLines(1), "1 line has no service provider price for its product; add the price and calculate again")
      assert.equal(unpricedLines(3), "3 lines have no service provider price for their product; add the prices and calculate again")
      const price = await priceTheUnpricedProduct(pool, a, fx)
      assert.equal((await refused(await command(s.id, "close"), 409)).detail, unpricedLines(1), "the price is added; the calculation has not been run over it")
      const repriced = await ok(await command(s.id, "calculate"))
      assert.deepEqual(lineFor(repriced, fx.events.unpriced.id), { serviceProviderPriceId: price.id, quantity: 1, unitPriceMinor: 2000, netMinor: 2000 })
      assert.deepEqual([repriced.lineCount, repriced.netMinor], [4, 7500])

      const missedOne = await recordServedEvent(pool, a, fleet, ex, fx, "2026-09-21")
      assert.equal((await refused(await command(s.id, "close"), 409)).detail, eventsMissed(1))
      assert.equal(eventsMissed(1), "1 event of the period is not in this calculation; calculate again")
      const missedTwo = await recordServedEvent(pool, a, fleet, ex, fx, "2026-10-19")
      assert.equal((await refused(await command(s.id, "close"), 409)).detail, eventsMissed(2))
      assert.equal(eventsMissed(2), "2 events of the period are not in this calculation; calculate again")
      const complete = await ok(await command(s.id, "calculate"))
      assert.deepEqual([complete.lineCount, complete.netMinor], [6, 18_000])
      assert.deepEqual(lineFor(complete, missedOne.id), { serviceProviderPriceId: fx.prices.early.id, quantity: 1, unitPriceMinor: 5000, netMinor: 5000 })
      assert.deepEqual(lineFor(complete, missedTwo.id), { serviceProviderPriceId: fx.prices.indexed.id, quantity: 1, unitPriceMinor: 5500, netMinor: 5500 })

      const closed = await ok(await command(s.id, "close"))
      assert.deepEqual([closed.status, closed.calculatedAt, closed.closedAt, closed.closedBy, closed.lineCount, closed.netMinor], ["closed", MORNING.toISOString(), MORNING.toISOString(), a.users.olivia.id, 6, 18_000])
      assert.deepEqual(closed.lines, complete.lines, "the lines stand still: the ids the calculation minted, unchanged")
      assert.deepEqual(await detail(s.id), closed)
      const history = (await events(s.id)).items
      assert.deepEqual(
        history.map((event) => event.kind),
        ["calculated", "calculated", "calculated", "calculated", "closed"],
      )
      const last = history[history.length - 1]
      assert.deepEqual([last.status, last.lineCount, last.netMinor, last.reason, last.recordedBy], ["closed", 6, 18_000, null, a.users.olivia.id])
      const [emitted, ...moreEmitted] = await eventsAbout(s.id)
      assert.equal(moreEmitted.length, 0)
      assert.deepEqual([emitted.kind, emitted.aggregateKind, emitted.projectId, emitted.occurredAt.toISOString()], ["settlement-closed", "settlement", a.projects.copenhagen.id, MORNING.toISOString()])
      assert.deepEqual(SettlementDetail.parse(emitted.payload), closed, "the payload is the settlement with its lines as answered")

      assert.deepEqual(await ok(await command(s.id, "close")), closed, "closing a closed settlement is nothing to do")
      assert.equal((await events(s.id)).items.length, 5, "no event for a command that did nothing")
      assert.equal((await eventsAbout(s.id)).length, 1, "and nothing published")
      assert.equal((await refused(await command(s.id, "calculate"), 409)).detail, closedSettlement(LABEL))
      assert.equal(closedSettlement(LABEL), "Settlement NordRen ApS · 2026-06-01–2026-10-31 is closed; reopen it first")
      await recordServedEvent(pool, a, fleet, ex, fx, "2026-10-26")
      assert.deepEqual((await detail(s.id)).lines, closed.lines, "an event recorded after the close moves nothing on the closed settlement")
    })
  })

  describe("POST /settlements/:id/reopen", () => {
    test("reopens a closed settlement with a reason the history keeps, clearing the stamps and keeping the lines; open and calculated ones answer as they stand", async () => {
      assert.deepEqual((await refused(await command(s.id, "reopen", {}), 400)).errors?.map((error) => error.path), ["reason"], "reopening requires a reason")
      const before = await detail(s.id)
      const reopened = await ok(await command(s.id, "reopen", { reason: "October's re-collections were recorded late" }))
      assert.deepEqual([reopened.status, reopened.calculatedAt, reopened.closedAt, reopened.closedBy, reopened.lineCount, reopened.netMinor], ["open", null, null, null, 6, 18_000])
      assert.deepEqual(reopened.lines, before.lines, "the lines are kept until the next calculation")
      const history = (await events(s.id)).items
      const last = history[history.length - 1]
      assert.deepEqual([last.kind, last.status, last.lineCount, last.netMinor, last.reason, last.recordedBy], ["reopened", "open", 6, 18_000, "October's re-collections were recorded late", a.users.olivia.id])
      assert.deepEqual(await ok(await command(s.id, "reopen", { reason: "Again" })), reopened, "reopening an open settlement is nothing to do")
      assert.equal((await events(s.id)).items.length, history.length)
      assert.equal((await refused(await command(s.id, "close"), 409)).detail, notCalculated(LABEL))
      assert.equal(notCalculated(LABEL), "Settlement NordRen ApS · 2026-06-01–2026-10-31 has not been calculated; calculate it first")

      const recalculated = await ok(await command(s.id, "calculate"))
      assert.deepEqual([recalculated.status, recalculated.lineCount, recalculated.netMinor], ["calculated", 7, 23_500], "the late October event joins the calculation")
      assert.deepEqual(await ok(await command(s.id, "reopen", { reason: "Nothing to reopen" })), recalculated, "a calculated settlement is open already")
      const closedAgain = await ok(await command(s.id, "close"))
      assert.equal(closedAgain.status, "closed")
      assert.deepEqual(await kindsOf(s.id), ["calculated", "calculated", "calculated", "calculated", "closed", "reopened", "calculated", "closed"])
      assert.deepEqual(
        (await events(s.id, "?kind=reopened")).items.map((event) => event.kind),
        ["reopened"],
      )
      assert.equal((await eventsAbout(s.id)).length, 2, "each close publishes once")
      assert.deepEqual(SettlementDetail.parse((await eventsAbout(s.id))[1].payload), closedAgain)

      const firstPage = await events(s.id, "?limit=3")
      assert.equal(firstPage.items.length, 3)
      assert.ok(firstPage.nextCursor !== null)
      const secondPage = await events(s.id, `?limit=3&cursor=${firstPage.nextCursor}`)
      assert.deepEqual(
        [...firstPage.items, ...secondPage.items].map((event) => event.kind),
        ["calculated", "calculated", "calculated", "calculated", "closed", "reopened"],
        "oldest first, across pages",
      )
    })
  })

  describe("GET /settlements, GET /settlements/:id and the provider's reach", () => {
    test("lists the caller's projects' settlements with their lines, filtered by assignment, provider, status and day; a provider's manager reads its own and nothing of another provider's", async () => {
      const everything = await page(olivia)
      const ids = everything.items.map((row) => row.id)
      assert.deepEqual(
        ids,
        [...ids].sort((x, y) => x.localeCompare(y)),
        "oldest first",
      )
      assert.deepEqual(new Set(ids), new Set([s.id, next.id, theirs.id]))
      const filtered = async (query: string, call = olivia) => (await page(call, `?limit=200${query}`)).items.map((row) => row.id)
      assert.deepEqual(await filtered(`&serviceAreaAssignmentId=${fx.assignments.nordren.id}`), [s.id, next.id])
      assert.deepEqual(await filtered(`&serviceProviderId=${a.serviceProviders.nordren.id}`), [s.id, next.id])
      assert.deepEqual(await filtered(`&serviceProviderId=${a.serviceProviders.cityhaul.id}`), [theirs.id])
      assert.deepEqual(await filtered("&status=closed"), [s.id])
      assert.deepEqual(await filtered("&status=open"), [next.id, theirs.id])
      assert.deepEqual(await filtered("&validOn=2026-08-15"), [s.id, theirs.id])
      assert.deepEqual(await filtered("&validOn=2026-11-15"), [next.id])
      assert.deepEqual(await filtered("&validOn=2026-11-01"), [next.id], "validTo is the first day out")
      assert.deepEqual(await filtered(`&projectId=${a.projects.copenhagen.id}`), [s.id, next.id, theirs.id])
      assert.deepEqual(await filtered(`&projectId=${a.projects.harbor.id}`), [])
      assert.deepEqual((await refused(await viewer(`/settlements?projectId=${a.projects.harbor.id}`), 400)).errors?.map((error) => error.path), ["projectId"], "the viewer works in Copenhagen only")
      assert.deepEqual((await refused(await olivia("/settlements?validOn=2026-02-30"), 400)).errors?.map((error) => error.path), ["validOn"])
      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items.map((row) => row.id), [s.id])
      assert.equal(first.items[0].lines.length, 7, "a page carries every settlement's lines")
      assert.ok(first.nextCursor !== null)
      assert.deepEqual((await page(olivia, `?limit=1&cursor=${first.nextCursor}`)).items.map((row) => row.id), [next.id])
      assert.deepEqual(await filtered("", viewer), [s.id, next.id, theirs.id], "Copenhagen's settlements, which the viewer works in")

      // Lars, NordRen's manager: his provider's settlements, with their lines and totals, and nothing of CityHaul's.
      assert.deepEqual(await filtered("", lars), [s.id, next.id])
      const his = await detail(s.id, lars)
      assert.deepEqual(his, await detail(s.id))
      assert.equal(his.lines.length, 7, "the lines carry the provider price alone, so the manager reads them whole")
      await refused(await lars(`/settlements/${theirs.id}`), 404)
      await refused(await lars(`/settlements/${theirs.id}/events`), 404)
      assert.equal((await events(s.id, "?limit=200", lars)).items.length, 8, "and the history of his own")
      assert.deepEqual((await refused(await lars(`/settlements?projectId=${a.projects.copenhagen.id}`), 400)).errors?.map((error) => error.path), ["projectId"], "a provider's account works in no project")
      assert.deepEqual(await filtered(`&serviceProviderId=${a.serviceProviders.cityhaul.id}`, lars), [], "asking for another provider's widens nothing")
      assert.match((await refused(await command(s.id, "calculate", {}, lars), 403)).detail ?? "", /edit on commercial\.settlements/, "the manager reads and never commands")

      await refused(await other(`/settlements/${s.id}`), 404)
      assert.deepEqual(await page(other), { items: [], nextCursor: null })
      await refused(await olivia(`/settlements/${testId()}`), 404)
      assert.equal((await refused(await olivia(`/settlements/${testId()}/events`), 404)).detail?.startsWith("No settlement "), true)
      assert.deepEqual((await refused(await olivia("/settlements/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.match((await refused(await ungranted("/settlements"), 403)).detail ?? "", /view on commercial\.settlements/)
      assert.match((await refused(await ungranted(`/settlements/${s.id}`), 403)).detail ?? "", /view on commercial\.settlements/)
      await refused(await other(`/settlements/${s.id}/close`, { method: "POST", body: {} }), 404)
    })
  })
})
