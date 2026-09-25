// What Planning's routes gained from Resources (Issue #101, slice 6): a
// scheme's depot and unloading station, a group's vehicle and default driver,
// the rules that hold them, and the two structural sentences a validated
// scheme adds for a vehicle or a driver on two groups a shared day. The
// scheme and group routes themselves are route-schemes.test.ts's and
// collection-groups.test.ts's; this suite proves the four fields and nothing
// those two already prove. The review round added the status rule (#79: a
// status gates a new reference and never an existing one), the app's clock as
// "today" — pinned here through `createApp`'s `now` — and the start of a
// scheme moving under its groups.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { CollectionGroup, RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { vehicle } from "@waste/db/schema/fleet"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { fleetOf } from "../routes/scheme-groups"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, SOFIE_LICENCE_EXPIRY, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

const MODULE = "route-studio.schemes"
/** A scheme that started before today, so its drivers are judged on today. */
const JANUARY = "2026-01-01"
/** A scheme starting years from now, so its drivers are judged on the day it starts. */
const FAR_AHEAD = "2030-01-06"

describe("the fleet and place fields of the scheme and group endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, whose station a scheme of `a` may not name. */
  let b: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let theirFleet: FleetFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let residual: WasteFraction

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    theirFleet = await seedFleet(pool, b, await seedPlanning(pool, b))
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    residual = await create("/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  const create = async <T>(path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await olivia(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  /** A rule group on the residual fraction over the days given, with whatever else the test says. */
  const ruleGroup = (name: string, days: string[], values: Record<string, unknown> = {}) => ({
    name,
    days,
    stopSource: "rule",
    rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null },
    ...values,
  })
  /** A scheme body on Copenhagen Central inside Centrum, Mondays and Thursdays, one rule group over both, starting in January. */
  const body = (name: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    name,
    planningAreaId: planning.areas.centrum.id,
    serviceType: "container-collection",
    frequency: "weekly",
    serviceDays: ["monday", "thursday"],
    validFrom: JANUARY,
    collectionGroups: [ruleGroup("Residual", ["monday", "thursday"])],
    ...values,
  })
  const scheme = (name: string, values: Record<string, unknown> = {}) => create("/route-schemes", body(name, values), RouteScheme)
  const post = (values: unknown) => olivia("/route-schemes", { method: "POST", body: values })
  const oneScheme = async (id: string): Promise<RouteScheme> => {
    const response = await olivia(`/route-schemes/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteScheme.parse(await response.json())
  }
  const patchScheme = (id: string, values: unknown) => olivia(`/route-schemes/${id}`, { method: "PATCH", body: values })
  const patchedScheme = async (id: string, values: unknown): Promise<RouteScheme> => {
    const response = await patchScheme(id, values)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteScheme.parse(await response.json())
  }
  const addGroup = (schemeId: string, group: unknown) => olivia(`/route-schemes/${schemeId}/collection-groups`, { method: "POST", body: group })
  const added = (schemeId: string, group: unknown) => create(`/route-schemes/${schemeId}/collection-groups`, group, CollectionGroup)
  const oneGroup = async (id: string): Promise<CollectionGroup> => {
    const response = await olivia(`/collection-groups/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionGroup.parse(await response.json())
  }
  const patchGroup = (id: string, values: unknown) => olivia(`/collection-groups/${id}`, { method: "PATCH", body: values })
  const patchedGroup = async (id: string, values: unknown): Promise<CollectionGroup> => {
    const response = await patchGroup(id, values)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionGroup.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  describe("a scheme's depot and unloading station", () => {
    test("round-trip on the create, the read and the patch, and a null clears them", async () => {
      const created = await scheme("Placed", { depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id })
      assert.deepEqual([created.depotId, created.unloadingStationId], [fleet.depots.nordhavn.id, fleet.stations.amager.id])
      assert.deepEqual(await oneScheme(created.id), created)
      const unsaid = await scheme("Unplaced")
      assert.deepEqual([unsaid.depotId, unsaid.unloadingStationId], [null, null], "null while unsaid")
      const placed = await patchedScheme(unsaid.id, { depotId: fleet.depots.nordhavn.id, unloadingStationId: fleet.stations.amager.id })
      assert.deepEqual([placed.depotId, placed.unloadingStationId], [fleet.depots.nordhavn.id, fleet.stations.amager.id])
      const cleared = await patchedScheme(unsaid.id, { depotId: null })
      assert.deepEqual([cleared.depotId, cleared.unloadingStationId], [null, fleet.stations.amager.id], "a null clears the one named and keeps the other")
      assert.deepEqual(await oneScheme(unsaid.id), cleared)
    })

    test("are held to a depot of the project and a station of the company, on the create and the patch alike", async () => {
      const otherProject = await refused(await post(body("Harbor depot", { depotId: fleet.depots.harbor.id })), 400)
      assert.deepEqual(otherProject.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const nobodys = await refused(await post(body("No depot", { depotId: testId() })), 400)
      assert.deepEqual(nobodys.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const theirStation = await refused(await post(body("Their station", { unloadingStationId: theirFleet.stations.amager.id })), 400)
      assert.deepEqual(theirStation.errors, [{ path: "unloadingStationId", message: "Not an unloading station of this company" }])
      const created = await scheme("Placed later")
      const patched = await refused(await patchScheme(created.id, { depotId: fleet.depots.harbor.id }), 400)
      assert.deepEqual(patched.errors, [{ path: "depotId", message: "Not a depot of this project" }])
      const station = await refused(await patchScheme(created.id, { unloadingStationId: testId() }), 400)
      assert.deepEqual(station.errors, [{ path: "unloadingStationId", message: "Not an unloading station of this company" }])
      assert.deepEqual(await oneScheme(created.id), created, "nothing written")
    })
  })

  describe("a group's vehicle and driver", () => {
    test("round-trip on the scheme create, the group create, the read and the patch, and a null clears them", async () => {
      const created = await scheme("Crewed", {
        collectionGroups: [ruleGroup("Residual", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id })],
      })
      const [residualRun] = created.collectionGroups
      assert.deepEqual([residualRun.vehicleId, residualRun.driverId], [fleet.vehicles.wh24.id, fleet.drivers.mads.id])
      assert.deepEqual(await oneGroup(residualRun.id), residualRun)
      const glass = await added(created.id, ruleGroup("Glass", ["thursday"], { vehicleId: fleet.vehicles.wh25.id }))
      assert.deepEqual([glass.vehicleId, glass.driverId], [fleet.vehicles.wh25.id, null], "a vehicle without a driver")
      const crewed = await patchedGroup(glass.id, { driverId: fleet.drivers.mads.id })
      assert.deepEqual([crewed.vehicleId, crewed.driverId], [fleet.vehicles.wh25.id, fleet.drivers.mads.id])
      const uncrewed = await patchedGroup(glass.id, { vehicleId: null, driverId: null })
      assert.deepEqual([uncrewed.vehicleId, uncrewed.driverId], [null, null])
      assert.deepEqual((await oneScheme(created.id)).collectionGroups.map((group) => [group.name, group.vehicleId, group.driverId]), [
        ["Residual", fleet.vehicles.wh24.id, fleet.drivers.mads.id],
        ["Glass", null, null],
      ])
      const driverOnly = await added(created.id, ruleGroup("Paper", ["monday"], { driverId: fleet.drivers.jonas.id }))
      assert.deepEqual([driverOnly.vehicleId, driverOnly.driverId], [null, fleet.drivers.jonas.id], "a driver without a vehicle is asked nothing about a licence")
    })

    test("are held to a powered vehicle and a driver of the scheme's project, at the entry", async () => {
      const created = await scheme("Referenced")
      const trailer = await refused(await addGroup(created.id, ruleGroup("Trailer", ["monday"], { vehicleId: fleet.vehicles.trailer.id })), 400)
      assert.deepEqual(trailer.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      const harbor = await refused(await addGroup(created.id, ruleGroup("Harbor", ["monday"], { vehicleId: fleet.vehicles.harborTruck.id })), 400)
      assert.deepEqual(harbor.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      const theirs = await refused(await addGroup(created.id, ruleGroup("Theirs", ["monday"], { vehicleId: theirFleet.vehicles.wh24.id })), 400)
      assert.deepEqual(theirs.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }])
      const driver = await refused(await addGroup(created.id, ruleGroup("Henrik", ["monday"], { driverId: fleet.drivers.henrik.id })), 400)
      assert.deepEqual(driver.errors, [{ path: "driverId", message: "Not a driver of this project" }])
      const inScheme = await refused(await post(body("Crewed wrong", { collectionGroups: [ruleGroup("A", ["monday", "thursday"]), ruleGroup("B", ["monday"], { vehicleId: fleet.vehicles.trailer.id })] })), 400)
      assert.deepEqual(inScheme.errors, [{ path: "collectionGroups.1.vehicleId", message: "Not a powered vehicle of this project" }])
      const [group] = created.collectionGroups
      const patched = await refused(await patchGroup(group.id, { driverId: theirFleet.drivers.mads.id }), 400)
      assert.deepEqual(patched.errors, [{ path: "driverId", message: "Not a driver of this project" }])
      assert.deepEqual(await oneGroup(group.id), group, "nothing written")
    })

    test("a group naming both names a driver who may take the vehicle, judged on the scheme's start or today, whichever is later", async () => {
      const started = await scheme("Started")
      const noClass = await refused(await addGroup(started.id, ruleGroup("Jonas", ["monday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.jonas.id })), 400)
      assert.deepEqual(noClass.errors, [{ path: "driverId", message: "Jonas Lind holds no licence class on record" }])
      const tooLow = await refused(await addGroup(started.id, ruleGroup("Freja", ["monday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.freja.id })), 400)
      assert.deepEqual(tooLow.errors, [{ path: "driverId", message: "Freja Holm needs a C licence for WH-24" }])
      const expired = await refused(await addGroup(started.id, ruleGroup("Sofie", ["monday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.sofie.id })), 400)
      assert.deepEqual(expired.errors, [{ path: "driverId", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before today` }], "a scheme that started in January is judged on today")
      const mads = await added(started.id, ruleGroup("Mads", ["monday"], { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id }))
      assert.equal(mads.driverId, fleet.drivers.mads.id, "CE takes a CE truck")

      const ahead = await refused(
        await post(body("Far ahead", { validFrom: FAR_AHEAD, collectionGroups: [ruleGroup("A", ["monday", "thursday"]), ruleGroup("Sofie", ["monday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.sofie.id })] })),
        400,
      )
      assert.deepEqual(ahead.errors, [{ path: "collectionGroups.1.driverId", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before the scheme starts` }], "a scheme starting years from now is judged on its first day")

      const [group] = started.collectionGroups
      const patchedDriver = await refused(await patchGroup(group.id, { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.freja.id }), 400)
      assert.deepEqual(patchedDriver.errors, [{ path: "driverId", message: "Freja Holm needs a C licence for WH-24" }])
      const withFreja = await patchedGroup(group.id, { driverId: fleet.drivers.freja.id })
      assert.deepEqual([withFreja.vehicleId, withFreja.driverId], [null, fleet.drivers.freja.id], "a driver alone is asked nothing")
      const thenTruck = await refused(await patchGroup(group.id, { vehicleId: fleet.vehicles.wh24.id }), 400)
      assert.deepEqual(thenTruck.errors, [{ path: "driverId", message: "Freja Holm needs a C licence for WH-24" }], "the merged pair is judged: the stored driver against the new vehicle")
      const smallTruck = await refused(await patchGroup(group.id, { vehicleId: fleet.vehicles.harborTruck.id }), 400)
      assert.deepEqual(smallTruck.errors, [{ path: "vehicleId", message: "Not a powered vehicle of this project" }], "Harbor's B truck is another project's and is refused before any licence is looked at")
    })

    test("a vehicle or a driver named afresh is in service: a retired vehicle, an inactive or a suspended driver is a 409 naming its status, on every door, after every 400", async () => {
      const inScheme = await refused(await post(body("Retired crew", { collectionGroups: [ruleGroup("A", ["monday", "thursday"]), ruleGroup("B", ["monday"], { vehicleId: fleet.vehicles.retired.id })] })), 409)
      assert.equal(inScheme.detail, "WH-99 is retired; a collection group needs a vehicle in service", "the row is there and its status refuses: a 409 naming it, not the 400 a missing id earns")
      const inSchemeDriver = await refused(await post(body("Suspended crew", { collectionGroups: [ruleGroup("A", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.peter.id })] })), 409)
      assert.equal(inSchemeDriver.detail, "Peter Lund is suspended; a collection group needs an active driver", "the licence, which Peter holds, passes, and the status refuses")
      const elsewhereFirst = await refused(
        await post(body("Retired and elsewhere", { collectionGroups: [ruleGroup("A", ["monday", "thursday"], { vehicleId: fleet.vehicles.retired.id }), ruleGroup("B", ["monday"], { driverId: fleet.drivers.henrik.id })] })),
        400,
      )
      assert.deepEqual(elsewhereFirst.errors, [{ path: "collectionGroups.1.driverId", message: "Not a driver of this project" }], "every 400 comes before the status 409: a driver who is not here is told first, retired vehicle or not")
      const secondGroup = await refused(
        await post(
          body("Retired on the second group", {
            collectionGroups: [
              ruleGroup("A", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id }),
              ruleGroup("B", ["monday"], { vehicleId: fleet.vehicles.retired.id }),
            ],
          }),
        ),
        409,
      )
      assert.equal(secondGroup.detail, "WH-99 is retired; a collection group needs a vehicle in service", "every vehicle the body names is read and gated, not only the first: a sound crew on the first group does not hide a retired truck on the second")
      const twice = await refused(await post(body("Retired twice", { collectionGroups: [ruleGroup("A", ["monday", "thursday"], { vehicleId: fleet.vehicles.retired.id }), ruleGroup("B", ["monday"], { vehicleId: fleet.vehicles.retired.id })] })), 409)
      assert.equal(twice.detail, "WH-99 is retired; a collection group needs a vehicle in service", "named twice, read once, refused once")
      const created = await scheme("In service")
      const retired = await refused(await addGroup(created.id, ruleGroup("Retired", ["monday"], { vehicleId: fleet.vehicles.retired.id })), 409)
      assert.equal(retired.detail, "WH-99 is retired; a collection group needs a vehicle in service")
      const inactive = await refused(await addGroup(created.id, ruleGroup("Karen", ["monday"], { driverId: fleet.drivers.karen.id })), 409)
      assert.equal(inactive.detail, "Karen Holt is inactive; a collection group needs an active driver", "a driver alone is asked no licence, and still has to be active")
      const [group] = created.collectionGroups
      const patchedVehicle = await refused(await patchGroup(group.id, { vehicleId: fleet.vehicles.retired.id }), 409)
      assert.equal(patchedVehicle.detail, "WH-99 is retired; a collection group needs a vehicle in service")
      const patchedDriver = await refused(await patchGroup(group.id, { driverId: fleet.drivers.peter.id }), 409)
      assert.equal(patchedDriver.detail, "Peter Lund is suspended; a collection group needs an active driver")
      assert.deepEqual(await oneGroup(group.id), group, "nothing written")
    })

    test("a stored vehicle stands once it retires: the group is renamed, moved and recrewed like any other, and only naming the vehicle afresh is refused — un-parking a group included", async () => {
      const created = await scheme("Drifting crew", { collectionGroups: [ruleGroup("Residual", ["monday", "thursday"], { vehicleId: fleet.vehicles.drifting.id, driverId: fleet.drivers.mads.id })] })
      const [group] = created.collectionGroups
      // A second scheme's group on WH-77, parked before the truck retires: parked, it counts for nothing toward the retirement (vehicles.test.ts), so un-parking it is naming the truck afresh.
      const parkedScheme = await scheme("Parked crew", { collectionGroups: [ruleGroup("Residual", ["monday"], { vehicleId: fleet.vehicles.drifting.id, driverId: fleet.drivers.mads.id })] })
      const [parked] = parkedScheme.collectionGroups
      assert.deepEqual((await patchedGroup(parked.id, { days: [] })).days, [], "parked")
      // WH-77 retires under both groups, as the vehicle route would refuse for the running one and an import would not.
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        await tx.update(vehicle).set({ status: "retired" }).where(and(eq(vehicle.companyId, a.companyId), eq(vehicle.id, fleet.vehicles.drifting.id)))
      })
      const unparked = await refused(await patchGroup(parked.id, { days: ["monday"] }), 409)
      assert.equal(unparked.detail, "WH-77 is retired; a collection group needs a vehicle in service", "un-parking names the stored truck afresh: a retired one is refused, since the parked group never stood in the retirement's way")
      assert.deepEqual((await oneGroup(parked.id)).days, [], "still parked, nothing written")
      const stillParked = await patchedGroup(parked.id, { name: "Residual, parked" })
      assert.equal(stillParked.vehicleId, fleet.vehicles.drifting.id, "a patch that leaves the group parked asks nothing of the stored truck")
      assert.equal((await patchedGroup(parked.id, { vehicleId: null })).vehicleId, null, "reassigned")
      const running = await patchedGroup(parked.id, { days: ["monday"] })
      assert.deepEqual([running.days, running.vehicleId, running.driverId], [["monday"], null, fleet.drivers.mads.id], "and un-parked: the stored driver is named afresh too, and Mads is active")
      const renamed = await patchedGroup(group.id, { name: "Residual north", position: 2 })
      assert.deepEqual([renamed.name, renamed.position, renamed.vehicleId], ["Residual north", 2, fleet.vehicles.drifting.id], "an unrelated patch asks nothing of the stored vehicle")
      const tooLow = await refused(await patchGroup(group.id, { driverId: fleet.drivers.freja.id }), 400)
      assert.deepEqual(tooLow.errors, [{ path: "driverId", message: "Freja Holm needs a C licence for WH-77" }], "a new driver is still judged against the stored vehicle's class; the vehicle's status is not asked")
      const recrewed = await patchedGroup(group.id, { driverId: fleet.drivers.jonas.id, vehicleId: null })
      assert.deepEqual([recrewed.vehicleId, recrewed.driverId], [null, fleet.drivers.jonas.id], "and the group is taken off the retired truck")
      const other = await added(created.id, ruleGroup("Glass", ["thursday"]))
      const afresh = await refused(await patchGroup(other.id, { vehicleId: fleet.vehicles.drifting.id }), 409)
      assert.equal(afresh.detail, "WH-77 is retired; a collection group needs a vehicle in service", "named afresh, the same vehicle is refused")
    })
  })

  describe("today on the project's clock", () => {
    /** An app whose clock a test pins, calling as Olivia; the token is verified against real time, which the clock does not touch. */
    const frozenAt = (instant: string): Call => callingAs(createApp({ probe: pool, pool, verifier: keys.verifier, now: () => new Date(instant) }), keys, a.users.olivia, a.companyId)
    /** A scheme body whose one group puts Sofie — licence through 2026-09-05 — on WH-24. */
    const sofieRun = (name: string, values: Record<string, unknown> = {}) =>
      body(name, { collectionGroups: [ruleGroup("Sofie", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.sofie.id })], ...values })
    const beforeTheSchemeStarts = [{ path: "collectionGroups.0.driverId", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before the scheme starts` }]
    const beforeToday = [{ path: "collectionGroups.0.driverId", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before today` }]

    test("a scheme starting today is judged on the day it starts, one that started is judged on today, and today is the project's day, not UTC's", async () => {
      const noon = frozenAt(`${SOFIE_LICENCE_EXPIRY}T10:00:00Z`)
      const startsToday = await noon("/route-schemes", { method: "POST", body: sofieRun("Clock: starts today", { validFrom: SOFIE_LICENCE_EXPIRY }) })
      assert.equal(startsToday.status, 201, JSON.stringify(await startsToday.clone().json()))
      assert.equal(RouteScheme.parse(await startsToday.json()).collectionGroups[0].driverId, fleet.drivers.sofie.id, "validFrom equal to today is judged as the scheme's start, the licence's last day")
      const startsTomorrow = await refused(await noon("/route-schemes", { method: "POST", body: sofieRun("Clock: starts tomorrow", { validFrom: "2026-09-06" }) }), 400)
      assert.deepEqual(startsTomorrow.errors, beforeTheSchemeStarts)
      const started = await noon("/route-schemes", { method: "POST", body: sofieRun("Clock: started", { validFrom: "2026-09-01" }) })
      assert.equal(started.status, 201, "a scheme that started is judged on today, the licence's last day")

      const pastMidnight = frozenAt(`${SOFIE_LICENCE_EXPIRY}T22:30:00Z`)
      const inCopenhagen = await refused(await pastMidnight("/route-schemes", { method: "POST", body: sofieRun("Clock: past midnight", { validFrom: SOFIE_LICENCE_EXPIRY }) }), 400)
      assert.deepEqual(inCopenhagen.errors, beforeToday, "00:30 on the 6th in Copenhagen, though still the 5th in UTC: today is the 6th and the licence has run out")
      const nextDay = frozenAt("2026-09-06T10:00:00Z")
      const tooLate = await refused(await nextDay("/route-schemes", { method: "POST", body: sofieRun("Clock: the day after", { validFrom: SOFIE_LICENCE_EXPIRY }) }), 400)
      assert.deepEqual(tooLate.errors, beforeToday)
    })

    test("moving a scheme's start later judges the groups' drivers again on the new start, refused at validFrom; an earlier start or an end moves nothing", async () => {
      const early = frozenAt("2026-09-01T10:00:00Z")
      // Three groups: Sofie on WH-24, whose licence runs out; Mads on WH-25, who may take anything; and Jonas alone, who is asked nothing without a vehicle.
      const create = await early("/route-schemes", {
        method: "POST",
        body: sofieRun("Clock: start moves", {
          validFrom: "2026-09-01",
          collectionGroups: [
            ruleGroup("Sofie", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.sofie.id }),
            ruleGroup("Mads", ["thursday"], { vehicleId: fleet.vehicles.wh25.id, driverId: fleet.drivers.mads.id }),
            ruleGroup("Jonas", ["monday"], { driverId: fleet.drivers.jonas.id }),
          ],
        }),
      })
      assert.equal(create.status, 201, JSON.stringify(await create.clone().json()))
      const created = RouteScheme.parse(await create.json())
      const later = await refused(await early(`/route-schemes/${created.id}`, { method: "PATCH", body: { validFrom: "2026-09-10" } }), 400)
      assert.deepEqual(later.errors, [{ path: "validFrom", message: `Sofie Nielsen's licence expires on ${SOFIE_LICENCE_EXPIRY}, before the scheme starts` }], "the groups are not in the body, so the bound that moved is refused; every crewed group is judged, and Mads passes")
      assert.equal((await oneScheme(created.id)).validFrom, "2026-09-01", "nothing written")
      // The rows the re-judgement reads: the vehicles and drivers of the groups naming both, in one statement each, and nothing of a group naming one.
      await withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const rows = await fleetOf(tx, { companyId: a.companyId, projectId: a.projects.copenhagen.id }, created.collectionGroups)
        assert.deepEqual([...rows.vehicles.keys()].sort(), [fleet.vehicles.wh24.id, fleet.vehicles.wh25.id].sort())
        assert.deepEqual([...rows.drivers.keys()].sort(), [fleet.drivers.sofie.id, fleet.drivers.mads.id].sort(), "Jonas, on no vehicle, is not read")
        assert.deepEqual([rows.vehicles.get(fleet.vehicles.wh24.id)?.requiredLicenceClass, rows.drivers.get(fleet.drivers.sofie.id)?.licenceExpiry], ["c", SOFIE_LICENCE_EXPIRY], "read for the licence rule")
        assert.deepEqual(await fleetOf(tx, { companyId: a.companyId, projectId: a.projects.copenhagen.id }, [created.collectionGroups[2]]), { vehicles: new Map(), drivers: new Map() }, "no crewed group is no statement")
      })
      const lastDay = await early(`/route-schemes/${created.id}`, { method: "PATCH", body: { validFrom: SOFIE_LICENCE_EXPIRY } })
      assert.equal(lastDay.status, 200, JSON.stringify(await lastDay.clone().json()))
      const earlier = await early(`/route-schemes/${created.id}`, { method: "PATCH", body: { validFrom: "2026-08-20" } })
      assert.equal(earlier.status, 200, "an earlier start is judged on nothing new")
      const ended = await early(`/route-schemes/${created.id}`, { method: "PATCH", body: { validTo: "2027-01-01" } })
      assert.equal(ended.status, 200, "an end moves nothing a licence is judged on")
      assert.deepEqual([(await oneScheme(created.id)).validFrom, (await oneScheme(created.id)).validTo], ["2026-08-20", "2027-01-01"])
    })
  })

  describe("a validated scheme's vehicles and drivers", () => {
    test("refuses one vehicle or one driver on two groups that run on a shared day, listing them, and takes them on disjoint days", async () => {
      const vehicle = await refused(
        await post(
          body("Shared truck", {
            status: "validated",
            collectionGroups: [ruleGroup("North", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id }), ruleGroup("South", ["monday"], { vehicleId: fleet.vehicles.wh24.id })],
          }),
        ),
        409,
      )
      assert.equal(vehicle.detail, "Vehicle WH-24 is on two collection groups that run on monday: North, South")
      const driver = await refused(
        await post(
          body("Shared driver", {
            status: "validated",
            collectionGroups: [ruleGroup("North", ["monday", "thursday"], { driverId: fleet.drivers.mads.id }), ruleGroup("South", ["monday"], { driverId: fleet.drivers.mads.id })],
          }),
        ),
        409,
      )
      assert.equal(driver.detail, "Driver Mads Jensen is on two collection groups that run on monday: North, South")
      const both = await refused(
        await post(
          body("Shared crew", {
            status: "validated",
            collectionGroups: [
              ruleGroup("North", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id }),
              ruleGroup("South", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id }),
            ],
          }),
        ),
        409,
      )
      assert.equal(
        both.detail,
        [
          "Vehicle WH-24 is on two collection groups that run on monday: North, South",
          "Vehicle WH-24 is on two collection groups that run on thursday: North, South",
          "Driver Mads Jensen is on two collection groups that run on monday: North, South",
          "Driver Mads Jensen is on two collection groups that run on thursday: North, South",
        ].join(". "),
        "every sentence, vehicles first, days in weekday order",
      )

      const disjoint = await scheme("One truck, two days", {
        status: "validated",
        collectionGroups: [ruleGroup("North", ["monday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id }), ruleGroup("South", ["thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id })],
      })
      assert.equal(disjoint.status, "validated", "Monday's route and Thursday's are the same truck and the same driver")
      const draft = await scheme("Draft crew", {
        collectionGroups: [ruleGroup("North", ["monday", "thursday"], { vehicleId: fleet.vehicles.wh24.id }), ruleGroup("South", ["monday"], { vehicleId: fleet.vehicles.wh24.id })],
      })
      assert.equal(draft.status, "draft", "a draft is held to none of the structural rules")
      const validating = await refused(await patchScheme(draft.id, { status: "validated" }), 409)
      assert.equal(validating.detail, "Vehicle WH-24 is on two collection groups that run on monday: North, South", "and is refused the moment it would become validated")
    })

    test("spells every structural sentence with the fleet's labels when the scheme names a fleet, and as it stands when it names none", async () => {
      const mixed = await refused(
        await post(
          body("Uncovered and shared", {
            status: "validated",
            collectionGroups: [ruleGroup("North", ["monday"], { vehicleId: fleet.vehicles.wh24.id }), ruleGroup("South", ["monday"], { vehicleId: fleet.vehicles.wh24.id })],
          }),
        ),
        409,
      )
      assert.equal(
        mixed.detail,
        ["Service days without a collection group: thursday", "Vehicle WH-24 is on two collection groups that run on monday: North, South"].join(". "),
        "the id-first pass found the issues and the labelled pass spelled them, the rules' own sentences among them",
      )
      const unlabelled = await refused(await post(body("Uncovered", { status: "validated", collectionGroups: [ruleGroup("North", ["monday"])] })), 409)
      assert.equal(unlabelled.detail, "Service days without a collection group: thursday", "no fleet named: the id-first result is the answer, and no label is read")
    })

    test("re-runs the rule when a group's days, vehicle or driver move, and when a group is added", async () => {
      const created = await scheme("Moving crew", {
        status: "validated",
        collectionGroups: [ruleGroup("North", ["monday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id }), ruleGroup("South", ["thursday"], { vehicleId: fleet.vehicles.wh24.id })],
      })
      const [north, south] = created.collectionGroups
      const days = await refused(await patchGroup(south.id, { days: ["monday", "thursday"] }), 409)
      assert.equal(days.detail, "Vehicle WH-24 is on two collection groups that run on monday: North, South")
      assert.deepEqual((await oneGroup(south.id)).days, ["thursday"], "nothing written")
      const otherTruck = await patchedGroup(south.id, { vehicleId: fleet.vehicles.wh25.id, days: ["monday", "thursday"] })
      assert.deepEqual([otherTruck.vehicleId, otherTruck.days], [fleet.vehicles.wh25.id, ["monday", "thursday"]], "two trucks may run on one day")
      const sameTruck = await refused(await patchGroup(north.id, { vehicleId: fleet.vehicles.wh25.id }), 409)
      assert.equal(sameTruck.detail, "Vehicle WH-25 is on two collection groups that run on monday: North, South")
      const sameDriver = await refused(await patchGroup(south.id, { driverId: fleet.drivers.mads.id }), 409)
      assert.equal(sameDriver.detail, "Driver Mads Jensen is on two collection groups that run on monday: North, South")
      const addedTruck = await refused(await addGroup(created.id, ruleGroup("East", ["thursday"], { vehicleId: fleet.vehicles.wh25.id })), 409)
      assert.equal(addedTruck.detail, "Vehicle WH-25 is on two collection groups that run on thursday: South, East")
      const east = await added(created.id, ruleGroup("East", ["thursday"], { vehicleId: fleet.vehicles.wh24.id, driverId: fleet.drivers.mads.id }))
      assert.equal(east.vehicleId, fleet.vehicles.wh24.id, "North's truck and driver are free on Thursday")
      assert.deepEqual(
        (await oneScheme(created.id)).collectionGroups.map((group) => [group.name, group.days, group.vehicleId, group.driverId]),
        [
          ["North", ["monday"], fleet.vehicles.wh24.id, fleet.drivers.mads.id],
          ["South", ["monday", "thursday"], fleet.vehicles.wh25.id, null],
          ["East", ["thursday"], fleet.vehicles.wh24.id, fleet.drivers.mads.id],
        ],
      )
    })
  })
})
