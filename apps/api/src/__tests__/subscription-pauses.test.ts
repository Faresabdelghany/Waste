// A Subscription's pause (#291, slice 10): written under its subscription,
// read and listed, moved — its first day while it has not begun, its end, a
// resume today included, while it has not ended — and cancelled before it
// begins; held inside the subscription's period, to today or later on the
// project's clock, and to one pause in force at a time. The subscription's
// own commands keep it whole: a patch strands no pause, a change hands the
// pause in force on to the replacement, a termination ends it. And what it
// does to the routes: a run of each scheme whose planned routes stop at the
// subscription's containers over the pause, the stops no run will take away
// answered, and a run of the schemes serving them when days are given back —
// as a termination asks them (agreement-termination.test.ts), the routes
// written by hand as generation would write them.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription, SubscriptionPause, SubscriptionPaused } from "@waste/contracts/agreements"
import { ContainerType, Product, WasteFraction } from "@waste/contracts/catalogue"
import { ContainerServicePlacement } from "@waste/contracts/containers"
import { Customer, Property } from "@waste/contracts/customers"
import { GenerationRun } from "@waste/contracts/generation"
import { Page } from "@waste/contracts/pagination"
import { RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { GENERATE_ROUTES_QUEUE } from "@waste/db/commands/generation"
import type { Send } from "@waste/db/jobs"
import { pickup, route } from "@waste/db/schema/execution"
import { company } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { pausesBeginLater, strandedPauses } from "../routes/agreements"
import { OUTSIDE_SUBSCRIPTION } from "../routes/lifecycle"
import { BEGINS_TODAY_OR_LATER, ENDS_TODAY_OR_LATER, KEEPS_ITS_FIRST_DAY, PAUSED_ALREADY_SENTENCE, pauseBegun, pauseEnded } from "../routes/subscription-pauses"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { stocked, warehouseIn } from "./stock-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ledger rows the stocked containers write, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const PausePage = Page(SubscriptionPause)

/** The request's clock: Monday 5 October 2026, noon; today is the 5th on the project's clock. */
const NOON = new Date("2026-10-05T12:00:00Z")
const YESTERDAY = "2026-10-04"
const TODAY = "2026-10-05"
const MONDAYS = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"] as const

describe("a subscription's pause (#291, slice 10)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let olivia: Call
  /** The custom role, with Project Access to Copenhagen Central, granted view on agreements and nothing more. */
  let viewer: Call
  let other: Call
  let residual: WasteFraction
  let bin: ContainerType
  let customer: Customer
  let collection: Product
  let warehouse: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "customers.agreements", actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    customer = await create(olivia, "/customers", { kind: "organisation", name: "Acme Housing" }, Customer)
    collection = await create(olivia, "/products", { projectId: a.projects.copenhagen.id, name: "Residual collection", kind: "container-collection", unit: "pickup", status: "active" }, Product)
    warehouse = await warehouseIn(pool, a.companyId, a.projects.copenhagen.id, "WH-PAUSE")
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }
  async function create<T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const ok = async <T>(response: Response, schema: Schema<T>): Promise<T> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }

  /** An agreement of its own with one subscription at a property of its own from January — unless `values` say otherwise — and, with `label`, a bin issued under it. */
  const served = async (number: string, values: Record<string, unknown> = {}, label?: string) => {
    const agreement = await create(
      olivia,
      "/agreements",
      { projectId: a.projects.copenhagen.id, number, customerId: customer.id, payerCustomerId: customer.id, billingCadence: "monthly", currency: "DKK", validFrom: "2026-01-01" },
      Agreement,
    )
    const property = await create(olivia, "/properties", { projectId: a.projects.copenhagen.id, name: `${number} Allé`, address: `${number} Allé 1, 2100 København Ø`, kind: "residential" }, Property)
    const subscription = await create(olivia, `/agreements/${agreement.id}/subscriptions`, { productId: collection.id, propertyId: property.id, validFrom: "2026-01-01", ...values }, Subscription)
    if (label === undefined) return { agreement, property, subscription, containerId: "" }
    const container = await stocked(olivia, { projectId: a.projects.copenhagen.id, label, containerTypeId: bin.id }, warehouse)
    await create(olivia, `/containers/${container.id}/placements`, { subscriptionId: subscription.id, wasteFractionId: residual.id, validFrom: "2026-01-01" }, ContainerServicePlacement)
    return { agreement, property, subscription, containerId: container.id }
  }
  const pause = (call: Call, subscriptionId: string, values: unknown) => call(`/subscriptions/${subscriptionId}/pauses`, { method: "POST", body: values })
  /** A pause's 201, read the way `created` reads a create's (created.ts), the answer being the pause and the stops it left: `Location` is the pause's own read, and it resolves. */
  const writtenAs = async (call: Call, response: Response): Promise<SubscriptionPaused> => {
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const body = SubscriptionPaused.parse(await response.json())
    assert.equal(response.headers.get("location"), `/subscription-pauses/${body.pause.id}`)
    assert.deepEqual(await ok(await call(`/subscription-pauses/${body.pause.id}`), SubscriptionPause), body.pause)
    return body
  }
  const paused = async (subscriptionId: string, values: unknown, call = olivia): Promise<SubscriptionPaused> => writtenAs(call, await pause(call, subscriptionId, values))
  const move = (call: Call, id: string, values: unknown) => call(`/subscription-pauses/${id}`, { method: "PATCH", body: values })
  const cancel = (call: Call, id: string, values: unknown = {}) => call(`/subscription-pauses/${id}/cancel`, { method: "POST", body: values })
  const list = async (query: string, call = olivia) => PausePage.parse(await (await call(`/subscription-pauses${query}`)).json()).items

  /** A pause in force since a day before today, written by hand as the clock's rule forbids the API to: a pause that has begun. */
  const begun = async (subscriptionId: string, validFrom: string, validTo: string | null): Promise<string> => {
    const id = testId()
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.execute(sql`insert into wms.subscription_pause (id, company_id, project_id, subscription_id, valid_from, valid_to) values (${id}, ${a.companyId}, ${a.projects.copenhagen.id}, ${subscriptionId}, ${validFrom}, ${validTo})`)
    })
    return id
  }

  describe("written, read and listed", () => {
    test("pauses a subscription from today or later until the day collections resume, or open; reads it at its own address and lists it by project, subscription and day", async () => {
      const { subscription } = await served("AGR-8001")
      const written = await paused(subscription.id, { validFrom: MONDAYS[0], validTo: MONDAYS[2] })
      assert.deepEqual([written.pause.subscriptionId, written.pause.projectId, written.pause.validFrom, written.pause.validTo], [subscription.id, a.projects.copenhagen.id, MONDAYS[0], MONDAYS[2]])
      assert.deepEqual(written.stopsToRemove, [], "no route stops at a subscription with no container")
      const open = await paused(subscription.id, { validFrom: MONDAYS[3] })
      assert.equal(open.pause.validTo, null, "a pause until it is resumed")
      const today = await paused((await served("AGR-8002")).subscription.id, { validFrom: TODAY, validTo: MONDAYS[0] })
      assert.equal(today.pause.validFrom, TODAY, "today is in time")

      assert.deepEqual((await list(`?subscriptionId=${subscription.id}`)).map((row) => row.id), [written.pause.id, open.pause.id])
      assert.deepEqual((await list(`?subscriptionId=${subscription.id}&validOn=${MONDAYS[1]}`)).map((row) => row.id), [written.pause.id])
      assert.deepEqual((await list(`?subscriptionId=${subscription.id}&validOn=${MONDAYS[2]}`)).map((row) => row.id), [], "the end is the day collections resume")
      assert.ok((await list(`?projectId=${a.projects.copenhagen.id}`)).some((row) => row.id === today.pause.id))
      assert.equal((await refused(await olivia(`/subscription-pauses?projectId=${b.projects.copenhagen.id}`), 400)).errors?.[0]?.path, "projectId")
      assert.deepEqual(await list("", other), [], "another company's pauses are not there")
      assert.equal((await other(`/subscription-pauses/${written.pause.id}`)).status, 404)
      assert.equal((await viewer(`/subscription-pauses/${written.pause.id}`)).status, 200, "view reads it")
    })

    test("holds the period inside the subscription's and from today on (400), and to one pause in force at a time (409)", async () => {
      const { subscription } = await served("AGR-8003", { validTo: "2026-12-01" })
      assert.deepEqual((await refused(await pause(olivia, subscription.id, { validFrom: MONDAYS[0] }), 400)).errors, [{ path: "validTo", message: OUTSIDE_SUBSCRIPTION }], "an open pause runs past the subscription's end")
      assert.deepEqual((await refused(await pause(olivia, subscription.id, { validFrom: MONDAYS[0], validTo: "2027-01-01" }), 400)).errors, [{ path: "validTo", message: OUTSIDE_SUBSCRIPTION }])
      assert.deepEqual((await refused(await pause(olivia, subscription.id, { validFrom: YESTERDAY, validTo: MONDAYS[0] }), 400)).errors, [{ path: "validFrom", message: BEGINS_TODAY_OR_LATER }])
      assert.equal((await refused(await pause(olivia, subscription.id, { validFrom: MONDAYS[1], validTo: MONDAYS[0] }), 400)).errors?.[0]?.path, "validTo")
      assert.match((await refused(await pause(olivia, subscription.id, { validFrom: MONDAYS[0], validTo: MONDAYS[1], subscriptionId: subscription.id }), 400)).errors?.[0]?.message ?? "", /subscriptionId/)

      await paused(subscription.id, { validFrom: MONDAYS[0], validTo: MONDAYS[2] })
      assert.equal((await refused(await pause(olivia, subscription.id, { validFrom: MONDAYS[1], validTo: MONDAYS[3] }), 409)).detail, PAUSED_ALREADY_SENTENCE)
      await paused(subscription.id, { validFrom: MONDAYS[2], validTo: MONDAYS[3] })
    })

    test("answers 404 for a subscription out of reach and 403 to a role that may only view", async () => {
      const { subscription } = await served("AGR-8004")
      await refused(await pause(olivia, testId(), { validFrom: MONDAYS[0] }), 404)
      await refused(await pause(other, subscription.id, { validFrom: MONDAYS[0] }), 404)
      assert.match((await refused(await pause(viewer, subscription.id, { validFrom: MONDAYS[0] }), 403)).detail ?? "", /edit on customers\.agreements/)
    })
  })

  describe("moved, resumed and cancelled", () => {
    test("moves a pause that has not begun, resumes one that has by giving it today as its end, and refuses to rewrite the past", async () => {
      const { subscription } = await served("AGR-8010")
      const later = await paused(subscription.id, { validFrom: MONDAYS[1], validTo: MONDAYS[2] })
      const moved = await ok(await move(olivia, later.pause.id, { validFrom: MONDAYS[0], validTo: null }), SubscriptionPaused)
      assert.deepEqual([moved.pause.validFrom, moved.pause.validTo], [MONDAYS[0], null])
      assert.deepEqual((await refused(await move(olivia, later.pause.id, { validFrom: YESTERDAY }), 400)).errors, [{ path: "validFrom", message: BEGINS_TODAY_OR_LATER }])

      const running = await begun(subscription.id, "2026-09-01", "2026-10-10")
      const resumed = await ok(await move(olivia, running, { validTo: TODAY }), SubscriptionPaused)
      assert.equal(resumed.pause.validTo, TODAY, "resumed today: collections from today")
      assert.deepEqual((await refused(await move(olivia, running, { validFrom: "2026-09-08" }), 409)).detail, pauseEnded(TODAY), "today's end makes it history at once")

      const ongoing = await begun((await served("AGR-8011")).subscription.id, "2026-09-01", null)
      assert.deepEqual((await refused(await move(olivia, ongoing, { validFrom: "2026-09-08" }), 400)).errors, [{ path: "validFrom", message: KEEPS_ITS_FIRST_DAY }])
      assert.deepEqual((await refused(await move(olivia, ongoing, { validTo: YESTERDAY }), 400)).errors, [{ path: "validTo", message: ENDS_TODAY_OR_LATER }])
      assert.equal((await refused(await move(olivia, ongoing, {}), 400)).errors?.[0]?.message, "Give at least one field to change")

      const ended = await begun((await served("AGR-8012")).subscription.id, "2026-08-01", "2026-09-01")
      assert.equal((await refused(await move(olivia, ended, { validTo: MONDAYS[0] }), 409)).detail, pauseEnded("2026-09-01"))
      assert.match((await refused(await move(viewer, ongoing, { validTo: MONDAYS[0] }), 403)).detail ?? "", /edit on customers\.agreements/)
    })

    test("cancels a pause that has not begun and leaves no trace but the audit log; refuses one that has, and a body", async () => {
      const { subscription } = await served("AGR-8013")
      const future = await paused(subscription.id, { validFrom: MONDAYS[0], validTo: MONDAYS[1] })
      assert.equal((await refused(await cancel(olivia, future.pause.id, { note: "x" }), 400)).status, 400)
      const removed = await ok(await cancel(olivia, future.pause.id), SubscriptionPause)
      assert.equal(removed.id, future.pause.id)
      assert.equal((await olivia(`/subscription-pauses/${future.pause.id}`)).status, 404)
      const history = (await (await olivia(`/audit-events?table=subscription&rowId=${subscription.id}`)).json()) as { items: { table: string; action: string }[] }
      assert.deepEqual(
        history.items.filter((event) => event.table === "subscription_pause").map((event) => event.action),
        ["delete", "insert"],
        "the subscription's history keeps the pause and its cancel, newest first",
      )

      const running = await begun(subscription.id, "2026-09-01", null)
      assert.equal((await refused(await cancel(olivia, running), 409)).detail, pauseBegun("2026-09-01"))
    })
  })

  describe("kept whole by the subscription's own commands", () => {
    test("a subscription's patch strands no pause, a change hands the pause in force on to the replacement, and a termination ends it; one that begins on or after the day is refused", async () => {
      const shortened = await served("AGR-8020")
      await paused(shortened.subscription.id, { validFrom: MONDAYS[0] })
      assert.equal((await refused(await olivia(`/subscriptions/${shortened.subscription.id}`, { method: "PATCH", body: { validTo: "2026-12-01" } }), 409)).detail, strandedPauses(1))

      const changed = await served("AGR-8021")
      const running = await begun(changed.subscription.id, "2026-09-01", MONDAYS[2])
      const replacement = await create(olivia, `/subscriptions/${changed.subscription.id}/change`, { on: MONDAYS[0], quantity: 2 }, Subscription)
      assert.deepEqual(
        (await list(`?projectId=${a.projects.copenhagen.id}`)).filter((row) => row.subscriptionId === changed.subscription.id || row.subscriptionId === replacement.id).map((row) => [row.subscriptionId, row.validFrom, row.validTo]),
        [
          [changed.subscription.id, "2026-09-01", MONDAYS[0]],
          [replacement.id, MONDAYS[0], MONDAYS[2]],
        ],
        "the pause goes on under the replacement, as the containers do",
      )
      assert.ok(running)
      const planned = await served("AGR-8022")
      await paused(planned.subscription.id, { validFrom: MONDAYS[1] })
      assert.equal((await refused(await olivia(`/subscriptions/${planned.subscription.id}/change`, { method: "POST", body: { on: MONDAYS[0], quantity: 2 } }), 409)).detail, pausesBeginLater(1))
      assert.equal(pausesBeginLater(1), "1 pause begins on or after that day; cancel it first")

      const terminated = await served("AGR-8023")
      const ongoing = await begun(terminated.subscription.id, "2026-09-01", null)
      const answer = await olivia(`/agreements/${terminated.agreement.id}/terminate`, { method: "POST", body: { on: MONDAYS[1] } })
      assert.equal(answer.status, 200, JSON.stringify(await answer.clone().json()))
      assert.equal((await ok(await olivia(`/subscription-pauses/${ongoing}`), SubscriptionPause)).validTo, MONDAYS[1], "ended with the subscription")
      const toCome = await served("AGR-8024")
      await paused(toCome.subscription.id, { validFrom: MONDAYS[2] })
      assert.equal((await refused(await olivia(`/agreements/${toCome.agreement.id}/terminate`, { method: "POST", body: { on: MONDAYS[1] } }), 409)).detail, pausesBeginLater(1))
    })
  })

  describe("what a pause does to the routes", () => {
    type Sent = { name: string; singletonKey: unknown }
    const callerWith = (send: () => Promise<string | null>) => {
      const sent: Sent[] = []
      const jobs: { send: Send } = { send: (name, _data, options) => send().then((answer) => (sent.push({ name, singletonKey: options?.singletonKey }), answer)) }
      return { sent, call: callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON, jobs }), keys, a.users.olivia, a.companyId) }
    }
    const runsOf = async (schemeId: string) => Page(GenerationRun).parse(await (await olivia(`/route-schemes/${schemeId}/generation-runs?limit=200`)).json()).items
    const scheme = async (name: string): Promise<RouteScheme> => {
      const response = await olivia("/route-schemes", {
        method: "POST",
        body: {
          projectId: a.projects.copenhagen.id,
          name,
          serviceType: "container-collection",
          frequency: "weekly",
          serviceDays: ["monday"],
          status: "validated",
          planningAreaId: planning.areas.centrum.id,
          validFrom: "2026-01-01",
          plannedStartTime: "06:00",
          depotId: fleet.depots.nordhavn.id,
          unloadingStationId: fleet.stations.amager.id,
          collectionGroups: [{ name: "Round 1", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null } }],
        },
      })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      return RouteScheme.parse(await response.json())
    }
    /** A route of the scheme on a day, in the status given, stopping at the container unless `stop` is false — written as generation would write it. */
    const routeAt = async (of: RouteScheme, day: string, at: { containerId: string; propertyId: string } | null, status: "planned" | "ready" = "planned") => {
      const id = testId()
      const pickupId = testId()
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const [{ next }] = await tx.update(company).set({ nextRouteNumber: sql`${company.nextRouteNumber} + 1` }).where(eq(company.id, a.companyId)).returning({ next: company.nextRouteNumber })
        await tx.insert(route).values({
          id,
          companyId: a.companyId,
          projectId: of.projectId,
          routeSchemeId: of.id,
          collectionGroupId: of.collectionGroups[0].id,
          serviceDate: day,
          operatingDate: day,
          status,
          number: next - 1,
          plannedStartTime: "06:00",
          depotId: of.depotId,
          unloadingStationId: of.unloadingStationId,
          dispatchedAt: status === "ready" ? new Date(`${day}T05:30:00+02:00`) : null,
        })
        if (at !== null) await tx.insert(pickup).values({ id: pickupId, companyId: a.companyId, projectId: of.projectId, routeId: id, containerId: at.containerId, position: 1, propertyId: at.propertyId, wasteFractionId: residual.id })
      })
      return { id, pickupId }
    }

    test("a pause asks a run over the planned routes that stop at its containers in it, and answers the stops no run will take away", async () => {
      const mondays = await scheme("Pause Mondays")
      const served8030 = await served("AGR-8030", {}, "BIN-8030")
      const at = { containerId: served8030.containerId, propertyId: served8030.property.id }
      await routeAt(mondays, MONDAYS[0], at)
      const ready = await routeAt(mondays, MONDAYS[1], at, "ready")
      await routeAt(mondays, MONDAYS[2], at)
      await routeAt(mondays, MONDAYS[3], at)

      const caller = callerWith(async () => testId())
      const before = await runsOf(mondays.id)
      const written = await writtenAs(caller.call, await pause(caller.call, served8030.subscription.id, { validFrom: MONDAYS[0], validTo: MONDAYS[3] }))
      assert.deepEqual(caller.sent, [{ name: GENERATE_ROUTES_QUEUE, singletonKey: mondays.id }])
      const asked = (await runsOf(mondays.id)).filter((run) => !before.some((earlier) => earlier.id === run.id))
      assert.deepEqual(asked.map((run) => [run.windowFrom, run.windowTo]), [[MONDAYS[0], MONDAYS[2]]], "from its first day through the last planned route that stops there inside it; the day it resumes is not paused")
      assert.deepEqual(written.stopsToRemove.map((left) => [left.routeId, left.pickupId]), [[ready.id, ready.pickupId]], "the dispatched route's stop")
    })

    test("a pause cancelled gives its days back: a run of each scheme that serves the containers, though its routes in the pause carry no stop of theirs", async () => {
      const mondays = await scheme("Resume Mondays")
      const served8031 = await served("AGR-8031", {}, "BIN-8031")
      const at = { containerId: served8031.containerId, propertyId: served8031.property.id }
      await routeAt(mondays, TODAY, at)
      await routeAt(mondays, MONDAYS[1], null)
      await routeAt(mondays, MONDAYS[2], null)
      const written = await paused(served8031.subscription.id, { validFrom: MONDAYS[1], validTo: MONDAYS[3] })

      const caller = callerWith(async () => testId())
      const before = await runsOf(mondays.id)
      await ok(await cancel(caller.call, written.pause.id), SubscriptionPause)
      const asked = (await runsOf(mondays.id)).filter((run) => !before.some((earlier) => earlier.id === run.id))
      assert.deepEqual(asked.map((run) => [run.windowFrom, run.windowTo]), [[MONDAYS[1], MONDAYS[2]]], "the scheme that stopped there today, over the days given back")
    })
  })
})
