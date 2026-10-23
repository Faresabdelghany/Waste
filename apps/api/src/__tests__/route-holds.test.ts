// The hold on a dated Route (#209): `assign` and `reschedule` hold a planned
// route from the command's instant, `heldAt` on the list and the detail, and
// a ready route holds nothing; `dispatch` and `cancel` clear it; and an edit
// of what the hold covers releases it in the edit's transaction — the
// scheme's start, depot, station or service days every held route of the
// scheme, a group's vehicle, driver, provider or days that group's alone,
// through `PATCH /route-schemes/:id` with or without `collectionGroups` and
// through `PATCH /collection-groups/:id` — while an edit that moves none of
// those releases nothing, and neither a dispatched route nor another scheme's
// is written. What generation does with a held route is the worker's
// (apps/worker generation.test.ts). Each test makes its own draft scheme, so
// no structural rule stands between an edit and what it releases, and writes
// its routes on the scheme's groups by hand, as generation would.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { Page } from "@waste/contracts/pagination"
import { RouteDetail, RouteListItem } from "@waste/contracts/routes"
import { CollectionGroup, RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { route } from "@waste/db/schema/execution"
import { company } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import type { RouteStatus } from "@waste/domain/execution/vocabulary"
import { eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const RoutePage = Page(RouteListItem)

/** The request's clock, pinned, so a hold's instant is known. */
const NOON = new Date("2026-10-05T12:00:00Z")
const HELD = NOON.toISOString()

/** Four Mondays, one route of a group each. */
const MONDAYS = ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"] as const

describe("the hold on a route (#209)", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let fleet: FleetFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let residual: WasteFraction

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
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
  const commanded = async (id: string, action: string, values?: unknown): Promise<RouteDetail> => RouteDetail.parse(await ok(await olivia(`/routes/${id}/${action}`, { method: "POST", body: values })))
  const patchScheme = async (id: string, values: unknown): Promise<RouteScheme> => RouteScheme.parse(await ok(await olivia(`/route-schemes/${id}`, { method: "PATCH", body: values })))
  const patchGroup = async (id: string, values: unknown): Promise<CollectionGroup> => CollectionGroup.parse(await ok(await olivia(`/collection-groups/${id}`, { method: "PATCH", body: values })))
  /** Holds each route again by moving its start: what the office's "This collection only" does. */
  const hold = async (...ids: string[]) => {
    for (const id of ids) assert.equal((await commanded(id, "reschedule", { plannedStartTime: "05:45" })).heldAt, HELD)
  }
  /** Which of the routes are held, by id, as the list reads them. */
  const holds = async (schemeId: string): Promise<Record<string, boolean>> => {
    const page = RoutePage.parse(await ok(await olivia(`/routes?limit=200&routeSchemeId=${schemeId}`)))
    return Object.fromEntries(page.items.map((row) => [row.id, row.heldAt !== null]))
  }

  /** A rule group on the residual fraction over the days given. */
  const ruleGroup = (name: string, days: string[]) => ({ name, days, stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null } })
  /** A draft scheme of Copenhagen Central over Mondays and Tuesdays, starting at six from Nordhavn and unloading at Amager, with the groups named, each on Mondays. */
  const schemeWith = async (name: string, groups: string[]): Promise<{ scheme: RouteScheme; groups: CollectionGroup[] }> => {
    const response = await olivia("/route-schemes", {
      method: "POST",
      body: {
        projectId: a.projects.copenhagen.id,
        name,
        serviceType: "container-collection",
        frequency: "weekly",
        serviceDays: ["monday", "tuesday"],
        status: "draft",
        validFrom: "2026-01-01",
        plannedStartTime: "06:00",
        depotId: fleet.depots.nordhavn.id,
        unloadingStationId: fleet.stations.amager.id,
        collectionGroups: groups.map((group) => ruleGroup(group, ["monday"])),
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

  test("dispatch and cancel clear the hold in the same write: a hold is a planned route's", async () => {
    const { scheme, groups: [group] } = await schemeWith("Clear Mondays", ["Round 1"])
    const [dispatched, cancelled] = await Promise.all(MONDAYS.slice(0, 2).map((day) => routeOn(scheme, group, day)))
    assert.equal((await commanded(dispatched, "assign", { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id })).heldAt, HELD)
    const ready = await commanded(dispatched, "dispatch")
    assert.deepEqual([ready.status, ready.heldAt, ready.planned.vehicleId], ["ready", null, fleet.vehicles.wh24.id], "frozen whole now, the office's crew with it")

    await hold(cancelled)
    const gone = await commanded(cancelled, "cancel", { reason: "Road closed" })
    assert.deepEqual([gone.status, gone.heldAt], ["cancelled", null])
  })

  test("a scheme patch moving the start, the depot, the station or the service days releases every held route of the scheme; one moving none of them releases nothing; a dispatched route and another scheme's are not written", async () => {
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

    for (const patch of [{ plannedStartTime: "07:15" }, { depotId: null }, { unloadingStationId: null }, { serviceDays: ["monday"] }]) {
      await patchScheme(scheme.id, patch)
      assert.deepEqual(await holds(scheme.id), { [first]: false, [second]: false, [ready]: false }, `${JSON.stringify(patch)} releases both groups' routes`)
      assert.equal(await heldAt(theirs), HELD, "another scheme's held route keeps its hold")
      await hold(first, second)
    }
    assert.equal((await read(ready)).updatedAt, readyBefore, "the dispatched route was never written")
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

    for (const values of [{ vehicleId: fleet.vehicles.wh24.id }, { driverId: fleet.drivers.mads.id }, { serviceProviderId: a.serviceProviders.nordren.id }, { days: ["monday", "tuesday"] }]) {
      const now = (await patchScheme(scheme.id, { collectionGroups: [entryOf(one, values), entryOf(two), entryOf(three)] })).collectionGroups
      assert.deepEqual(await heldOnes(), { one: false, two: true, three: true }, `${JSON.stringify(values)} moves the first group alone`)
      Object.assign(one, now.find((group) => group.id === one.id))
      await hold(routes.one)
    }

    await patchScheme(scheme.id, { collectionGroups: [entryOf(one), entryOf(two)] })
    assert.deepEqual(await heldOnes(), { one: true, two: true, three: false }, "the third, left out, is parked: its days moved")
  })

  test("a group patch moving its vehicle, driver, provider or days releases its held routes alone; a rename or a move of its position releases nothing", async () => {
    const { scheme, groups: [one, two] } = await schemeWith("Group door Mondays", ["Round 1", "Round 2"])
    const mine = await routeOn(scheme, one, MONDAYS[0])
    const theirs = await routeOn(scheme, two, MONDAYS[0])
    await hold(mine, theirs)

    for (const values of [{ name: "Round 1 · renamed" }, { position: 9 }, { days: ["monday"] }]) {
      await patchGroup(one.id, values)
      assert.deepEqual(await holds(scheme.id), { [mine]: true, [theirs]: true }, JSON.stringify(values))
    }
    for (const values of [{ vehicleId: fleet.vehicles.wh24.id }, { driverId: fleet.drivers.mads.id }, { serviceProviderId: a.serviceProviders.nordren.id }, { days: ["monday", "tuesday"] }]) {
      await patchGroup(one.id, values)
      assert.deepEqual(await holds(scheme.id), { [mine]: false, [theirs]: true }, `${JSON.stringify(values)} releases the group's own`)
      await hold(mine)
    }
  })
})
