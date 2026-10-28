// The hold on a dated Route (#209): `assign` and `reschedule` hold a planned
// route from the command's instant, `heldAt` on the list and the detail, and
// a ready route holds nothing; `dispatch` and `cancel` clear it; and an edit
// of what the hold covers releases it in the edit's transaction — the
// scheme's start, depot, station or service days every held route of the
// scheme, a group's vehicle, driver, provider or days that group's alone,
// through `PATCH /route-schemes/:id` with or without `collectionGroups` and
// through `PATCH /collection-groups/:id` — while an edit that moves none of
// those releases nothing, and neither a dispatched route nor another scheme's
// is written. A change of days releases only the held routes whose own
// collection it takes away, on a weekday the days no longer hold: one that
// adds a day releases nothing (#226). `release-hold` hands one planned route
// back to its scheme and asks a generation run over its service date; a send
// the queue absorbs or cannot take still hands it back. A change of holiday
// inputs — a calendar's holidays written or replaced, the scheme's policy, the
// project's weekend or whether it has a list — releases the held routes it
// re-decides, and a list renamed releases nothing (#226). What generation does
// with a held route is the worker's
// (apps/worker generation.test.ts). Each test makes its own draft scheme, so
// no structural rule stands between an edit and what it releases, and writes
// its routes on the scheme's groups by hand, as generation would.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { Page } from "@waste/contracts/pagination"
import { GenerationRun } from "@waste/contracts/generation"
import { RouteDetail, RouteListItem } from "@waste/contracts/routes"
import { CollectionGroup, RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { GENERATE_ROUTES_QUEUE } from "@waste/db/commands/generation"
import { QueueMissing, type Send } from "@waste/db/jobs"
import { route } from "@waste/db/schema/execution"
import { company } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import type { RouteStatus } from "@waste/domain/execution/vocabulary"
import { eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { handBackWindow } from "../routes/route-holds"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const RoutePage = Page(RouteListItem)

/** The request's clock, pinned, so a hold's instant is known; one test moves it on an hour and back. */
const NOON = new Date("2026-10-05T12:00:00Z")
const HELD = NOON.toISOString()
let clock = NOON

/** Four Mondays, one route of a group each. */
const MONDAYS = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"] as const

describe("the hold on a route (#209)", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let fleet: FleetFixtures
  let planning: PlanningFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let residual: WasteFraction

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => clock })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    const response = await olivia("/waste-fractions", { method: "POST", body: { key: "residual", name: "Residual waste" } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    residual = WasteFraction.parse(await response.json())
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    await pool?.close()
  })

  const ok = async (response: Response): Promise<unknown> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return await response.json()
  }
  const read = async (id: string): Promise<RouteDetail> => RouteDetail.parse(await ok(await olivia(`/routes/${id}`)))
  const heldAt = async (id: string): Promise<string | null> => (await read(id)).heldAt
  // The fixture Monday's routes share its crew without times; the same-day rule (O7 of #290) is crew-day.test.ts's, so the crew commands here say `acceptSameDay`.
  const sameDay = (action: string, values: unknown) => (["assign", "reschedule"].includes(action) && typeof values === "object" && values !== null && Object.keys(values).length > 0 ? { ...values, acceptSameDay: true } : values)
  const commanded = async (id: string, action: string, values?: unknown): Promise<RouteDetail> => RouteDetail.parse(await ok(await olivia(`/routes/${id}/${action}`, { method: "POST", body: sameDay(action, values) })))
  const patchScheme = async (id: string, values: unknown): Promise<RouteScheme> => RouteScheme.parse(await ok(await olivia(`/route-schemes/${id}`, { method: "PATCH", body: values })))
  const patchGroup = async (id: string, values: unknown): Promise<CollectionGroup> => CollectionGroup.parse(await ok(await olivia(`/collection-groups/${id}`, { method: "PATCH", body: values })))
  /** A start no route has had yet, a minute later each time: a command that changes nothing holds nothing. */
  let minute = 0
  const nextStart = (): string => `05:${String((minute += 1)).padStart(2, "0")}`
  /** Holds each route again by moving its start: what the office's "This collection only" does. */
  const hold = async (...ids: string[]) => {
    for (const id of ids) assert.equal((await commanded(id, "reschedule", { plannedStartTime: nextStart() })).heldAt, HELD)
  }
  /** Which of the routes are held, by id, as the list reads them. */
  const holds = async (schemeId: string): Promise<Record<string, boolean>> => {
    const page = RoutePage.parse(await ok(await olivia(`/routes?limit=200&routeSchemeId=${schemeId}`)))
    return Object.fromEntries(page.items.map((row) => [row.id, row.heldAt !== null]))
  }

  /** A rule group on the residual fraction over the days given. */
  const ruleGroup = (name: string, days: string[]) => ({ name, days, stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null } })
  /** A scheme of Copenhagen Central over Mondays and Tuesdays, starting at six from Nordhavn and unloading at Amager, with the groups named, each on Mondays; a draft unless `validated`, whose groups run both days. */
  const schemeWith = async (name: string, groups: string[], validated = false): Promise<{ scheme: RouteScheme; groups: CollectionGroup[] }> => {
    const response = await olivia("/route-schemes", {
      method: "POST",
      body: {
        projectId: a.projects.copenhagen.id,
        name,
        serviceType: "container-collection",
        frequency: "weekly",
        serviceDays: ["monday", "tuesday"],
        status: validated ? "validated" : "draft",
        ...(validated ? { planningAreaId: planning.areas.centrum.id } : {}),
        validFrom: "2026-01-01",
        plannedStartTime: "06:00",
        depotId: fleet.depots.nordhavn.id,
        unloadingStationId: fleet.stations.amager.id,
        // A validated scheme has a group on each of its days.
        collectionGroups: groups.map((group) => ruleGroup(group, validated ? ["monday", "tuesday"] : ["monday"])),
      },
    })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const scheme = RouteScheme.parse(await response.json())
    return { scheme, groups: scheme.collectionGroups }
  }
  /** A group of the resource as an entry of the scheme's patch restates it: whole, by its id. */
  const entryOf = (group: CollectionGroup, values: Record<string, unknown> = {}) => ({
    id: group.id,
    name: group.name,
    position: group.position,
    days: group.days,
    stopSource: group.stopSource,
    rule: group.rule,
    serviceProviderId: group.serviceProviderId,
    vehicleId: group.vehicleId,
    driverId: group.driverId,
    ...values,
  })
  /**
   * A route of the group on a Monday, written as generation writes one — the
   * scheme's start, depot and station, numbered from the company's counter —
   * in the status asked for, with the stamp `route_stamps_shape` wants.
   */
  const routeOn = async (scheme: RouteScheme, group: CollectionGroup, day: string, status: RouteStatus = "planned"): Promise<string> => {
    const id = testId()
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      const [{ next }] = await tx
        .update(company)
        .set({ nextRouteNumber: sql`${company.nextRouteNumber} + 1` })
        .where(eq(company.id, a.companyId))
        .returning({ next: company.nextRouteNumber })
      await tx.insert(route).values({
        id,
        companyId: a.companyId,
        projectId: scheme.projectId,
        routeSchemeId: scheme.id,
        collectionGroupId: group.id,
        serviceDate: day,
        operatingDate: day,
        status,
        number: next - 1,
        plannedStartTime: "06:00",
        depotId: scheme.depotId,
        unloadingStationId: scheme.unloadingStationId,
        dispatchedAt: status === "ready" ? new Date(`${day}T05:30:00+02:00`) : null,
      })
    })
    return id
  }

  test("assign and reschedule hold a planned route from the command's instant, on the detail and the list; a ready route holds nothing, and a refused command holds nothing", async () => {
    const { scheme, groups: [group] } = await schemeWith("Hold Mondays", ["Round 1"])
    const [assigned, rescheduled, ready, refusedOne] = await Promise.all(MONDAYS.map((day, n) => routeOn(scheme, group, day, n === 2 ? "ready" : "planned")))
    assert.equal(await heldAt(assigned), null, "a route is the scheme's until the office moves it by hand")

    assert.equal((await commanded(assigned, "assign", { vehicleId: fleet.vehicles.wh24.id })).heldAt, HELD, "assign holds it")
    const moved = await commanded(rescheduled, "reschedule", { operatingDate: "2026-10-20" })
    assert.deepEqual([moved.operatingDate, moved.serviceDate, moved.heldAt], ["2026-10-20", MONDAYS[1], HELD], "reschedule holds it; the identity stays")
    assert.deepEqual(await holds(scheme.id), { [assigned]: true, [rescheduled]: true, [ready]: false, [refusedOne]: false }, "the list carries the hold beside the detail")

    assert.equal((await commanded(ready, "assign", { vehicleId: fleet.vehicles.wh24.id })).heldAt, null, "a dispatched route is frozen against regeneration already")
    assert.equal((await commanded(ready, "reschedule", { plannedStartTime: "07:00" })).heldAt, null)

    const retired = await olivia(`/routes/${refusedOne}/assign`, { method: "POST", body: { vehicleId: fleet.vehicles.retired.id } })
    assert.equal(retired.status, 409)
    assert.match((await readProblem(retired)).detail ?? "", /retired/)
    assert.equal(await heldAt(refusedOne), null, "a refused command writes nothing, the hold included")
  })

  test("a command that changes nothing holds nothing, and leaves an earlier hold as it stood; one that moves something again stamps the later instant", async () => {
    const { scheme, groups: [group] } = await schemeWith("Same Mondays", ["Round 1"])
    const id = await routeOn(scheme, group, MONDAYS[0])
    assert.equal((await commanded(id, "reschedule", { operatingDate: MONDAYS[0], plannedStartTime: "06:00" })).heldAt, null, "the day and the start it already has, the start as the wire spells it")
    assert.equal((await commanded(id, "assign", { depotId: scheme.depotId, unloadingStationId: scheme.unloadingStationId, vehicleId: null })).heldAt, null, "the ends and the crew it already has")
    assert.equal((await commanded(id, "assign", { trailerId: fleet.vehicles.trailer.id })).heldAt, HELD, "a trailer is the Planned Assignment's too")
    clock = new Date(NOON.getTime() + 60 * 60 * 1000)
    try {
      assert.equal((await commanded(id, "assign", { trailerId: fleet.vehicles.trailer.id })).heldAt, HELD, "the same trailer again: the hold stands as it was")
      assert.equal((await commanded(id, "reschedule", { plannedStartTime: "06:30" })).heldAt, clock.toISOString(), "a move stamps when the office last moved it")
    } finally {
      clock = NOON
    }
  })

  test("dispatch and cancel clear the hold in the same write: a hold is a planned route's", async () => {
    const { scheme, groups: [group] } = await schemeWith("Clear Mondays", ["Round 1"])
    const [dispatched, cancelled] = await Promise.all(MONDAYS.slice(0, 2).map((day) => routeOn(scheme, group, day)))
    assert.equal((await commanded(dispatched, "assign", { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id })).heldAt, HELD)
    const ready = await commanded(dispatched, "dispatch")
    assert.deepEqual([ready.status, ready.heldAt, ready.planned.vehicleId], ["ready", null, fleet.vehicles.wh24.id], "frozen whole now, the office's crew with it")

    await hold(cancelled)
    const gone = await commanded(cancelled, "cancel", { reasonCode: "road-closure", reason: "Road closed" })
    assert.deepEqual([gone.status, gone.heldAt], ["cancelled", null])
  })

  test("a scheme patch moving the start, the depot or the station releases every held route of the scheme; one moving none of them releases nothing; a dispatched route and another scheme's are not written", async () => {
    const { scheme, groups: [one, two] } = await schemeWith("Release Mondays", ["Round 1", "Round 2"])
    const elsewhere = await schemeWith("Elsewhere Mondays", ["Round 1"])
    const first = await routeOn(scheme, one, MONDAYS[0])
    const second = await routeOn(scheme, two, MONDAYS[0])
    const ready = await routeOn(scheme, one, MONDAYS[1], "ready")
    const theirs = await routeOn(elsewhere.scheme, elsewhere.groups[0], MONDAYS[0])
    await hold(first, second, theirs)
    const readyBefore = (await read(ready)).updatedAt

    // What the hold does not cover, and a covered field given as it stands, release nothing.
    for (const patch of [{ name: "Release Mondays · renamed" }, { validTo: "2027-06-01" }, { holidayPolicy: "collect" }, { plannedStartTime: "06:00", depotId: fleet.depots.nordhavn.id, serviceDays: ["tuesday", "monday"] }]) {
      await patchScheme(scheme.id, patch)
      assert.deepEqual(await holds(scheme.id), { [first]: true, [second]: true, [ready]: false }, JSON.stringify(patch))
    }

    for (const patch of [{ plannedStartTime: "07:15" }, { depotId: null }, { unloadingStationId: null }]) {
      await patchScheme(scheme.id, patch)
      assert.deepEqual(await holds(scheme.id), { [first]: false, [second]: false, [ready]: false }, `${JSON.stringify(patch)} releases both groups' routes`)
      assert.equal(await heldAt(theirs), HELD, "another scheme's held route keeps its hold")
      await hold(first, second)
    }
    assert.equal((await read(ready)).updatedAt, readyBefore, "the dispatched route was never written")
  })

  test("a scheme's service days release only the held routes on a weekday they take away: an added day releases nothing, and a start moved beside it releases all (#226)", async () => {
    const { scheme, groups: [one] } = await schemeWith("Days Mondays", ["Round 1"])
    const both = await patchGroup(one.id, { days: ["monday", "tuesday"] })
    const monday = await routeOn(scheme, both, MONDAYS[0])
    const tuesday = await routeOn(scheme, both, "2026-10-13")
    await hold(monday, tuesday)

    await patchScheme(scheme.id, { serviceDays: ["monday", "tuesday", "wednesday"] })
    assert.deepEqual(await holds(scheme.id), { [monday]: true, [tuesday]: true }, "a day added takes no held route's collection away")

    await patchScheme(scheme.id, { serviceDays: ["monday"], collectionGroups: [entryOf(both, { days: ["monday"] })] })
    assert.deepEqual(await holds(scheme.id), { [monday]: true, [tuesday]: false }, "Tuesday's collection is gone; Monday's stands")

    await hold(tuesday)
    await patchScheme(scheme.id, { serviceDays: ["monday", "tuesday"], plannedStartTime: "07:30" })
    assert.deepEqual(await holds(scheme.id), { [monday]: false, [tuesday]: false }, "the start moved: every held route goes back")
  })

  test("a scheme patch whose collectionGroups moves a group's vehicle, driver, provider or days releases that group's held routes alone, a running group it parks included; a group restated as it stands releases nothing", async () => {
    const { scheme, groups } = await schemeWith("Groups Mondays", ["Round 1", "Round 2", "Round 3"])
    const [one, two, three] = groups
    const routes = { one: await routeOn(scheme, one, MONDAYS[0]), two: await routeOn(scheme, two, MONDAYS[0]), three: await routeOn(scheme, three, MONDAYS[0]) }
    await hold(routes.one, routes.two, routes.three)
    const heldOnes = async () => {
      const read = await holds(scheme.id)
      return { one: read[routes.one], two: read[routes.two], three: read[routes.three] }
    }

    await patchScheme(scheme.id, { collectionGroups: groups.map((group) => entryOf(group)) })
    assert.deepEqual(await heldOnes(), { one: true, two: true, three: true }, "every group restated as it stands")

    for (const values of [{ vehicleId: fleet.vehicles.wh24.id }, { driverId: fleet.drivers.mads.id }, { serviceProviderId: a.serviceProviders.nordren.id }]) {
      const now = (await patchScheme(scheme.id, { collectionGroups: [entryOf(one, values), entryOf(two), entryOf(three)] })).collectionGroups
      assert.deepEqual(await heldOnes(), { one: false, two: true, three: true }, `${JSON.stringify(values)} moves the first group alone`)
      Object.assign(one, now.find((group) => group.id === one.id))
      await hold(routes.one)
    }

    // Days: a Tuesday added to the first group takes no collection away; taken away again, its Tuesday route alone goes back (#226).
    const added = (await patchScheme(scheme.id, { collectionGroups: [entryOf(one, { days: ["monday", "tuesday"] }), entryOf(two), entryOf(three)] })).collectionGroups
    assert.deepEqual(await heldOnes(), { one: true, two: true, three: true }, "a day added releases nothing")
    Object.assign(one, added.find((group) => group.id === one.id))
    const tuesday = await routeOn(scheme, one, "2026-10-13")
    await hold(tuesday)
    await patchScheme(scheme.id, { collectionGroups: [entryOf(one, { days: ["monday"] }), entryOf(two), entryOf(three)] })
    assert.deepEqual({ ...(await heldOnes()), tuesday: (await holds(scheme.id))[tuesday] }, { one: true, two: true, three: true, tuesday: false }, "Tuesday taken away: its route alone")

    await patchScheme(scheme.id, { collectionGroups: [entryOf(one), entryOf(two)] })
    assert.deepEqual(await heldOnes(), { one: true, two: true, three: false }, "the third, left out, is parked: its days moved")
  })

  test("a group patch moving its vehicle, driver or provider releases its held routes alone, its days only those on a weekday they take away; a rename, a move of its position or an added day releases nothing", async () => {
    const { scheme, groups: [one, two] } = await schemeWith("Group door Mondays", ["Round 1", "Round 2"])
    const mine = await routeOn(scheme, one, MONDAYS[0])
    const theirs = await routeOn(scheme, two, MONDAYS[0])
    await hold(mine, theirs)

    for (const values of [{ name: "Round 1 · renamed" }, { position: 9 }, { days: ["monday"] }, { days: ["monday", "tuesday"] }]) {
      await patchGroup(one.id, values)
      assert.deepEqual(await holds(scheme.id), { [mine]: true, [theirs]: true }, JSON.stringify(values))
    }
    for (const values of [{ vehicleId: fleet.vehicles.wh24.id }, { driverId: fleet.drivers.mads.id }, { serviceProviderId: a.serviceProviders.nordren.id }]) {
      await patchGroup(one.id, values)
      assert.deepEqual(await holds(scheme.id), { [mine]: false, [theirs]: true }, `${JSON.stringify(values)} releases the group's own`)
      await hold(mine)
    }
    const tuesday = await routeOn(scheme, one, "2026-10-13")
    await hold(tuesday)
    await patchGroup(one.id, { days: ["monday"] })
    assert.deepEqual(await holds(scheme.id), { [mine]: true, [theirs]: true, [tuesday]: false }, "Tuesday taken away: its route alone")
  })

  describe("release-hold (#226)", () => {
    type Sent = { name: string; data: unknown; singletonKey: unknown }
    /** The office — or the user named — through an app whose job sender answers as `send` does, each send recorded. */
    const officeWith = (send: (sent: Sent) => Promise<string | null>, user = a.users.olivia) => {
      const sent: Sent[] = []
      const jobs: { send: Send } = { send: (name, data, options) => send({ name, data, singletonKey: options?.singletonKey }).then((answer) => (sent.push({ name, data, singletonKey: options?.singletonKey }), answer)) }
      return { sent, call: callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => clock, jobs }), keys, user, a.companyId) }
    }
    const released = async (call: Call, id: string): Promise<RouteDetail> => {
      const response = await call(`/routes/${id}/release-hold`, { method: "POST", body: {} })
      return RouteDetail.parse(await ok(response))
    }
    const runsOf = async (schemeId: string) => Page(GenerationRun).parse(await ok(await olivia(`/route-schemes/${schemeId}/generation-runs?limit=200`))).items

    test("asks the run from the project's today, or the scheme's first day if later, through the route's service date, so its drift stamp is today's; a day already past, or beyond the walk's cap, alone", () => {
      assert.deepEqual(handBackWindow({ today: "2026-10-05", schemeFrom: "2026-01-01", serviceDate: "2026-10-26" }), { from: "2026-10-05", to: "2026-10-26" })
      assert.deepEqual(handBackWindow({ today: "2026-10-05", schemeFrom: "2026-10-12", serviceDate: "2026-10-26" }), { from: "2026-10-12", to: "2026-10-26" }, "the scheme's first day, later than today")
      assert.deepEqual(handBackWindow({ today: "2026-10-05", schemeFrom: "2026-01-01", serviceDate: "2026-09-28" }), { from: "2026-09-28", to: "2026-09-28" }, "a day already past: that day alone")
      assert.deepEqual(handBackWindow({ today: "2026-10-05", schemeFrom: "2026-01-01", serviceDate: "2027-10-26" }), { from: "2027-10-26", to: "2027-10-26" }, "beyond the walk's cap: that day alone")
    })

    test("hands a held planned route back to its scheme and asks a generation run through its service date, under the scheme's key", async () => {
      const { scheme, groups: [one] } = await schemeWith("Hand back Mondays", ["Round 1"], true)
      const id = await routeOn(scheme, one, MONDAYS[2])
      await hold(id)
      const office = officeWith(async () => testId())
      const before = await runsOf(scheme.id)
      const answer = await released(office.call, id)
      assert.equal(answer.heldAt, null)
      assert.equal((await read(id)).heldAt, null)
      assert.deepEqual(office.sent.map((sent) => [sent.name, sent.singletonKey]), [[GENERATE_ROUTES_QUEUE, scheme.id]])
      const asked = (await runsOf(scheme.id)).filter((run) => !before.some((earlier) => earlier.id === run.id))
      assert.deepEqual(asked.map((run) => [run.windowFrom, run.windowTo, run.trigger, run.status]), [["2026-10-05", MONDAYS[2], "on-demand", "queued"]], "from the project's today")
    })

    test("still hands the route back where a run of the scheme already holds the queue, or no worker has made the queue yet: the next run brings it back", async () => {
      const { scheme, groups: [one] } = await schemeWith("Absorbed Mondays", ["Round 1"], true)
      const absorbed = await routeOn(scheme, one, MONDAYS[2])
      const unqueued = await routeOn(scheme, one, MONDAYS[3])
      await hold(absorbed, unqueued)
      const before = await runsOf(scheme.id)
      assert.equal((await released(officeWith(async () => null).call, absorbed)).heldAt, null, "a queued run absorbs the send")
      assert.equal((await released(officeWith(async () => Promise.reject(new QueueMissing(GENERATE_ROUTES_QUEUE))).call, unqueued)).heldAt, null, "no queue: the hand-back stands")
      assert.deepEqual(await runsOf(scheme.id), before, "no run written for either")
    })

    test("asks no run for a role that may edit routes but not schemes, as Generate would refuse it: the route is still handed back", async () => {
      await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "route-studio.routes", actions: ["view", "edit"] }])
      const { scheme, groups: [one] } = await schemeWith("Dispatcher Mondays", ["Round 1"], true)
      const id = await routeOn(scheme, one, MONDAYS[2])
      await hold(id)
      const dispatcher = officeWith(async () => testId(), a.users.viewer)
      assert.equal((await released(dispatcher.call, id)).heldAt, null)
      assert.deepEqual(dispatcher.sent, [], "a run of the scheme is the schemes module's edit")
    })

    test("asks no run of a draft scheme, which generates nothing; refuses a planned route that is not held and a route that is not planned", async () => {
      const { scheme, groups: [one] } = await schemeWith("Draft Mondays", ["Round 1"])
      const held = await routeOn(scheme, one, MONDAYS[0])
      const free = await routeOn(scheme, one, MONDAYS[1])
      const ready = await routeOn(scheme, one, MONDAYS[2], "ready")
      await hold(held)
      const office = officeWith(async () => testId())
      assert.equal((await released(office.call, held)).heldAt, null)
      assert.deepEqual(office.sent, [], "a draft scheme generates nothing: no run asked")

      const notHeld = await office.call(`/routes/${free}/release-hold`, { method: "POST", body: {} })
      assert.equal(notHeld.status, 409)
      assert.match((await readProblem(notHeld)).detail ?? "", /is not held; it follows its scheme/)
      const notPlanned = await office.call(`/routes/${ready}/release-hold`, { method: "POST", body: {} })
      assert.equal(notPlanned.status, 409)
      assert.match((await readProblem(notPlanned)).detail ?? "", /is ready; only a planned route is held/)
      const withBody = await office.call(`/routes/${held}/release-hold`, { method: "POST", body: { note: "x" } })
      assert.equal(withBody.status, 400)
    })
  })

  // A change of holiday inputs releases the held routes it re-decides (#226,
  // `holidayReleases` in the domain): the calendar's holidays, written or
  // replaced, the scheme's policy, and the project's weekend or whether it has
  // a list. The tests run in order: the first makes Copenhagen's 2027
  // calendar, the rest replace its 2026 one's holidays, and the block gives the project a holiday list for the block and take it
  // away after. Mondays 12 Oct to 2 Nov 2026 carry the holidays; a held route the
  // office moved stands on the Tuesday after.
  describe("a change of holiday inputs (#226)", () => {
    /** Copenhagen's 2026 calendar, and the holidays the fixtures gave it, which every set below keeps. */
    let calendarId: string
    let kept: { day: string; name: string | null }[]
    const patchProject = async (values: unknown) => await ok(await olivia(`/projects/${a.projects.copenhagen.id}`, { method: "PATCH", body: values }))
    const putHolidays = async (days: string[]) =>
      await ok(await olivia(`/collection-calendars/${calendarId}/holidays`, { method: "PUT", body: { holidays: [...kept, ...days.map((day) => ({ day, name: "Test Day" }))] } }))
    /** A scheme of the policy given, its one group on Mondays. */
    const schemeOf = async (name: string, holidayPolicy: string) => {
      const made = await schemeWith(name, ["Round 1"])
      await patchScheme(made.scheme.id, { holidayPolicy })
      return { scheme: made.scheme, group: made.groups[0] }
    }
    /** A route held where the office moved it: on the day given rather than its Monday. */
    const movedTo = async (id: string, operatingDate: string) => {
      const moved = await commanded(id, "reschedule", { operatingDate })
      assert.deepEqual([moved.operatingDate, moved.heldAt], [operatingDate, HELD])
    }

    before(async () => {
      const page = (await ok(await olivia(`/collection-calendars?projectId=${a.projects.copenhagen.id}&validOn=2026-10-12`))) as { items: { id: string; holidays: { day: string; name: string | null }[] }[] }
      assert.equal(page.items.length, 1)
      calendarId = page.items[0].id
      kept = page.items[0].holidays
      await patchProject({ holidayList: "Test holidays" })
    })
    after(async () => {
      await patchProject({ holidayList: null, weekend: ["saturday", "sunday"] })
    })

    test("a calendar created with holidays releases the held route on one under shift-next; the route on a plain day keeps its hold", async () => {
      const { scheme, group } = await schemeOf("Holiday Create Mondays", "shift-next")
      const [onHoliday, plain] = await Promise.all(["2027-01-04", "2027-01-11"].map((day) => routeOn(scheme, group, day)))
      await hold(onHoliday, plain)
      const response = await olivia("/collection-calendars", {
        method: "POST",
        body: { projectId: a.projects.copenhagen.id, name: "Copenhagen Central 2027", validFrom: "2027-01-01", validTo: "2028-01-01", holidays: [{ day: "2027-01-04", name: "Test Day" }] },
      })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      assert.deepEqual(await holds(scheme.id), { [onHoliday]: false, [plain]: true }, "Monday 4 Jan moves to Tuesday with its neighbours; the 11th is untouched")
    })

    test("a calendar's holidays replaced release the held routes they re-decide, each under its own scheme's policy: not one the scheme collects on, and not one the office moved off the new holiday", async () => {
      const shifted = await schemeOf("Holiday Put Mondays", "shift-next")
      const collected = await schemeOf("Holiday Collect Mondays", "collect")
      const onHoliday = await routeOn(shifted.scheme, shifted.group, MONDAYS[1])
      const officeDay = await routeOn(shifted.scheme, shifted.group, MONDAYS[2])
      const officeOff = await routeOn(shifted.scheme, shifted.group, MONDAYS[3])
      const collectedOn = await routeOn(collected.scheme, collected.group, MONDAYS[1])
      await hold(onHoliday, collectedOn)
      await movedTo(officeDay, "2026-10-27")
      await movedTo(officeOff, "2026-11-03")

      await putHolidays([MONDAYS[0], MONDAYS[1], "2026-10-27", MONDAYS[3]])
      assert.deepEqual(await holds(shifted.scheme.id), { [onHoliday]: false, [officeDay]: false, [officeOff]: true }, "the 19th's collection moves; the Tuesday the office chose became a holiday; the 2nd's the office had moved already")
      assert.deepEqual(await holds(collected.scheme.id), { [collectedOn]: true }, "a holiday the scheme collects on moves nothing")

      await putHolidays([MONDAYS[0], MONDAYS[1], "2026-10-27", MONDAYS[3]])
      assert.deepEqual(await holds(shifted.scheme.id), { [onHoliday]: false, [officeDay]: false, [officeOff]: true }, "the same set again releases nothing more")
    })

    test("a scheme's holiday policy changed releases its held routes the policy re-decides, and no other scheme's", async () => {
      // The holidays stand on 12 and 19 Oct, 27 Oct and 2 Nov.
      const { scheme, group } = await schemeOf("Holiday Policy Mondays", "shift-next")
      const other = await schemeOf("Holiday Policy Others", "shift-next")
      const whereShifted = await routeOn(scheme, group, MONDAYS[1])
      const plain = await routeOn(scheme, group, "2026-11-09")
      const theirs = await routeOn(other.scheme, other.group, MONDAYS[1])
      await movedTo(whereShifted, "2026-10-20")
      await hold(plain)
      await movedTo(theirs, "2026-10-20")

      await patchScheme(scheme.id, { name: "Holiday Policy Mondays · renamed" })
      assert.deepEqual(await holds(scheme.id), { [whereShifted]: true, [plain]: true }, "an edit beside the policy releases nothing")
      await patchScheme(scheme.id, { holidayPolicy: "skip" })
      assert.deepEqual(await holds(scheme.id), { [whereShifted]: false, [plain]: true }, "the 19th's collection is skipped now: the route held where the shift put it goes back to be cancelled")
      assert.deepEqual(await holds(other.scheme.id), { [theirs]: true }, "another scheme's policy did not change")
    })

    test("the project's weekend changed, or its holiday list set or taken away, releases the held routes it re-decides; a list renamed changes no day and releases nothing", async () => {
      // The holidays stand on 12 and 19 Oct, 27 Oct and 2 Nov.
      const { scheme, group } = await schemeOf("Holiday Project Mondays", "shift-next")
      const lands = await routeOn(scheme, group, MONDAYS[3])
      const plain = await routeOn(scheme, group, "2026-11-09")
      await movedTo(lands, "2026-11-03")
      await hold(plain)

      await patchProject({ holidayList: "Renamed holidays" })
      assert.deepEqual(await holds(scheme.id), { [lands]: true, [plain]: true }, "a rename changes no day")
      await patchProject({ weekend: ["saturday", "sunday", "tuesday"] })
      assert.deepEqual(await holds(scheme.id), { [lands]: false, [plain]: true }, "the 2nd's shift lands on Wednesday now, the route held on Tuesday goes with it")

      const shiftedTwice = await routeOn(scheme, group, MONDAYS[1])
      await movedTo(shiftedTwice, "2026-10-21")
      await patchProject({ holidayList: null })
      assert.deepEqual(await holds(scheme.id), { [lands]: false, [plain]: true, [shiftedTwice]: false }, "no list, no holidays: the 19th is collected on its Monday again")
      await patchProject({ holidayList: "Test holidays", weekend: ["saturday", "sunday"] })
    })
  })
})
