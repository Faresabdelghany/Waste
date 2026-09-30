// One request for a scheme edit that moves its collection groups (#205):
// `PATCH /route-schemes/:id` with `collectionGroups`, the scheme's groups
// whole, held once on the state the edit leaves behind and written in one
// transaction. The edits here are the ones no order of single requests could
// make — a service day added to a validated scheme under its one group, a
// group split in two that share a vehicle, two manual groups trading
// containers on a shared day — and the refusals that write nothing. The patch
// without the member is route-schemes.test.ts's and scheme-fleet.test.ts's.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ContainerType, WasteFraction } from "@waste/contracts/catalogue"
import { Container } from "@waste/contracts/containers"
import { OUTSIDE_SERVICE_DAYS, RouteScheme, type CollectionGroup } from "@waste/contracts/route-schemes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { vehicle } from "@waste/db/schema/fleet"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

const MODULE = "route-studio.schemes"
const JANUARY = "2026-01-01"
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"]

describe("a scheme edit that moves its collection groups, in one request (#205)", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let residual: WasteFraction
  let bin1: Container
  let bin2: Container

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    residual = await create("/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    const bin = await create("/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    bin1 = await create("/containers", { projectId: a.projects.copenhagen.id, label: "BIN-1", containerTypeId: bin.id }, Container)
    bin2 = await create("/containers", { projectId: a.projects.copenhagen.id, label: "BIN-2", containerTypeId: bin.id }, Container)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
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
  /** A manual group picking the containers given, in stop order. */
  const manualGroup = (name: string, days: string[], containerIds: string[]) => ({ name, days, stopSource: "manual", containerIds })
  /** A validated scheme on Copenhagen Central inside Centrum, over the days and with the groups given. */
  const scheme = (name: string, serviceDays: string[], collectionGroups: unknown[]) =>
    create(
      "/route-schemes",
      {
        projectId: a.projects.copenhagen.id,
        name,
        planningAreaId: planning.areas.centrum.id,
        serviceType: "container-collection",
        frequency: "weekly",
        serviceDays,
        status: "validated",
        validFrom: JANUARY,
        collectionGroups,
      },
      RouteScheme,
    )
  /** A group of the resource as an entry of the patch restates it: whole, by its id. */
  const entryOf = (group: CollectionGroup) => ({
    id: group.id,
    name: group.name,
    position: group.position,
    days: group.days,
    stopSource: group.stopSource,
    rule: group.rule,
    containerIds: group.containerIds,
    serviceProviderId: group.serviceProviderId,
    vehicleId: group.vehicleId,
    driverId: group.driverId,
  })
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
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  test("adds a service day to a validated scheme and to the one group that runs every day, which no order of two requests could", async () => {
    const weekdays = await scheme("Weekdays", WEEKDAYS, [ruleGroup("Residual", WEEKDAYS)])
    const [group] = weekdays.collectionGroups
    const sixDays = [...WEEKDAYS, "saturday"]

    const edited = await patchedScheme(weekdays.id, { serviceDays: sixDays, collectionGroups: [{ ...entryOf(group), days: sixDays }] })
    assert.deepEqual(edited.serviceDays, sixDays)
    assert.equal(edited.status, "validated")
    assert.deepEqual(
      edited.collectionGroups.map((each) => [each.id, each.days]),
      [[group.id, sixDays]],
    )
    assert.deepEqual(await oneScheme(weekdays.id), edited, "what the patch answers is what the next read says")
  })

  test("splits a group in two that share a vehicle on no common day, and the group the edit adds comes back with the id the server minted", async () => {
    const truck = fleet.vehicles.wh24.id
    const weekdays = await scheme("Split", WEEKDAYS, [ruleGroup("Residual", WEEKDAYS, { vehicleId: truck })])
    const [group] = weekdays.collectionGroups

    const edited = await patchedScheme(weekdays.id, {
      collectionGroups: [
        { ...entryOf(group), name: "Residual, early week", days: ["monday", "tuesday", "wednesday"] },
        ruleGroup("Residual, late week", ["thursday", "friday"], { vehicleId: truck }),
      ],
    })
    assert.deepEqual(
      edited.collectionGroups.map((each) => [each.name, each.position, each.days, each.vehicleId]),
      [
        ["Residual, early week", 1, ["monday", "tuesday", "wednesday"], truck],
        ["Residual, late week", 2, ["thursday", "friday"], truck],
      ],
    )
    const [kept, added] = edited.collectionGroups
    assert.equal(kept.id, group.id, "the restated group keeps its id")
    assert.notEqual(added.id, group.id)
    assert.deepEqual(added.rule, { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null })
    assert.deepEqual(await oneScheme(weekdays.id), edited)
  })

  test("trades the containers of two manual groups that run on a shared day, which either list alone would refuse", async () => {
    const byHand = await scheme("By hand", ["monday"], [manualGroup("First", ["monday"], [bin1.id]), manualGroup("Second", ["monday"], [bin2.id])])
    const [first, second] = byHand.collectionGroups

    const edited = await patchedScheme(byHand.id, {
      collectionGroups: [
        { ...entryOf(first), containerIds: [bin2.id] },
        { ...entryOf(second), containerIds: [bin1.id] },
      ],
    })
    assert.deepEqual(
      edited.collectionGroups.map((each) => [each.id, each.containerIds]),
      [
        [first.id, [bin2.id]],
        [second.id, [bin1.id]],
      ],
    )
    assert.deepEqual(await oneScheme(byHand.id), edited)
  })

  test("refuses an edit that leaves the validated scheme broken with every sentence, and writes none of it", async () => {
    const truck = fleet.vehicles.wh24
    const weekdays = await scheme("Broken", WEEKDAYS, [ruleGroup("Residual", WEEKDAYS)])
    const [group] = weekdays.collectionGroups

    const problem = await refused(
      await patchScheme(weekdays.id, {
        name: "Broken, renamed",
        collectionGroups: [
          { ...entryOf(group), days: ["monday", "tuesday"], vehicleId: truck.id },
          ruleGroup("Mondays too", ["monday"], { vehicleId: truck.id }),
        ],
      }),
      409,
    )
    assert.equal(
      problem.detail,
      ["Service days without a collection group: wednesday, thursday, friday", `Vehicle ${truck.label} is on two collection groups that run on monday: Residual, Mondays too`].join(". "),
    )
    assert.deepEqual(await oneScheme(weekdays.id), weekdays, "nothing of the edit was written")
  })

  test("parks a group the list leaves out, since there is no delete: it keeps its name and runs on nothing", async () => {
    const twoGroups = await scheme("Two groups", ["monday", "thursday"], [ruleGroup("Mondays", ["monday"]), ruleGroup("Thursdays", ["thursday"])])
    const [mondays, thursdays] = twoGroups.collectionGroups

    const edited = await patchedScheme(twoGroups.id, { collectionGroups: [{ ...entryOf(mondays), days: ["monday", "thursday"] }] })
    assert.deepEqual(
      edited.collectionGroups.map((each) => [each.id, each.name, each.days]),
      [
        [mondays.id, "Mondays", ["monday", "thursday"]],
        [thursdays.id, "Thursdays", []],
      ],
    )
    assert.deepEqual(await oneScheme(twoGroups.id), edited)
  })

  test("refuses an entry naming a group the scheme does not have, and a group turned to find its stops the other way, at that entry", async () => {
    const mine = await scheme("Mine", ["monday"], [ruleGroup("Mondays", ["monday"])])
    const another = await scheme("Another", ["monday"], [ruleGroup("Elsewhere", ["monday"])])
    const [group] = mine.collectionGroups

    const borrowed = await refused(await patchScheme(mine.id, { collectionGroups: [entryOf(group), { ...entryOf(another.collectionGroups[0]), name: "Borrowed" }] }), 400)
    assert.deepEqual(borrowed.errors, [{ path: "collectionGroups.1.id", message: "Not a collection group of this scheme" }])
    const turned = await refused(await patchScheme(mine.id, { collectionGroups: [{ ...entryOf(group), stopSource: "manual", rule: null, containerIds: [bin1.id] }] }), 400)
    assert.deepEqual(turned.errors, [{ path: "collectionGroups.0.stopSource", message: "A collection group keeps how it finds its stops: one that finds them the other way is another group" }])
    assert.deepEqual(await oneScheme(mine.id), mine)
    assert.deepEqual(await oneScheme(another.id), another)
  })

  test("holds every entry's days within the service days the scheme is left with, at that entry's days", async () => {
    const mondays = await scheme("Mondays only", ["monday"], [ruleGroup("Mondays", ["monday"])])
    const [group] = mondays.collectionGroups

    const outside = await refused(await patchScheme(mondays.id, { collectionGroups: [entryOf(group), ruleGroup("Fridays", ["friday"])] }), 400)
    assert.deepEqual(outside.errors, [{ path: "collectionGroups.1.days", message: OUTSIDE_SERVICE_DAYS }])
    assert.deepEqual(await oneScheme(mondays.id), mondays)
  })

  test("holds what each entry names to the scope its key allows, and a container to one group a day, at the entry that is wrong", async () => {
    const byHand = await scheme("Scoped", ["monday"], [manualGroup("First", ["monday"], [bin1.id])])
    const [first] = byHand.collectionGroups

    const harborTruck = await refused(await patchScheme(byHand.id, { collectionGroups: [{ ...entryOf(first), vehicleId: fleet.vehicles.harborTruck.id }] }), 400)
    assert.deepEqual(harborTruck.errors, [{ path: "collectionGroups.0.vehicleId", message: "Not a powered vehicle of this project" }])
    const twice = await refused(await patchScheme(byHand.id, { collectionGroups: [entryOf(first), manualGroup("Second", ["monday"], [bin2.id, bin1.id])] }), 400)
    assert.deepEqual(twice.errors, [{ path: "collectionGroups.1.containerIds.1", message: "Already picked by First on monday" }])
    assert.deepEqual(await oneScheme(byHand.id), byHand)
  })

  test("gates the fleet an entry names afresh by its status, a group un-parked included, and asks nothing of the vehicle a group already runs with", async () => {
    const drifting = fleet.vehicles.drifting
    const crew = await scheme("Drifting crew", ["monday", "thursday"], [ruleGroup("Mondays", ["monday"], { vehicleId: drifting.id }), ruleGroup("Thursdays", ["thursday"])])
    await withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(vehicle).set({ status: "retired" }).where(and(eq(vehicle.companyId, a.companyId), eq(vehicle.id, drifting.id))))
    const [mondays, thursdays] = crew.collectionGroups
    const retiredSentence = (label: string) => `${label} is retired; a collection group needs a vehicle in service`

    const renamed = await patchedScheme(crew.id, { collectionGroups: [{ ...entryOf(mondays), name: "Mondays, renamed" }, entryOf(thursdays)] })
    assert.equal(renamed.collectionGroups[0].vehicleId, drifting.id, "a reference already made stands")
    const kept = entryOf(renamed.collectionGroups[0])
    const onAnother = await refused(await patchScheme(crew.id, { collectionGroups: [kept, { ...entryOf(thursdays), vehicleId: drifting.id }] }), 409)
    assert.equal(onAnother.detail, retiredSentence(drifting.label), "named afresh on another group, the same vehicle is refused")
    const added = await refused(await patchScheme(crew.id, { collectionGroups: [kept, entryOf(thursdays), ruleGroup("Retired", ["monday"], { vehicleId: fleet.vehicles.retired.id })] }), 409)
    assert.equal(added.detail, retiredSentence(fleet.vehicles.retired.label))

    const parked = await patchedScheme(crew.id, { collectionGroups: [{ ...entryOf(thursdays), days: ["monday", "thursday"] }] })
    assert.deepEqual(parked.collectionGroups[0].days, [], "the group the list leaves out is parked, its truck kept")
    const unparked = await refused(await patchScheme(crew.id, { collectionGroups: [{ ...entryOf(parked.collectionGroups[0]), days: ["monday"] }, { ...entryOf(parked.collectionGroups[1]), days: ["thursday"] }] }), 409)
    assert.equal(unparked.detail, retiredSentence(drifting.label), "un-parking names the stored truck afresh")
  })

  test("judges the licence where an entry moves the crew, at that entry's driver, and where the start moves later under a crew, at the start", async () => {
    const truck = fleet.vehicles.wh24
    const crewed = await scheme("Crewed", ["monday"], [ruleGroup("Mondays", ["monday"], { vehicleId: truck.id, driverId: fleet.drivers.mads.id })])
    const [group] = crewed.collectionGroups

    const tooLow = await refused(await patchScheme(crewed.id, { collectionGroups: [{ ...entryOf(group), driverId: fleet.drivers.freja.id }] }), 400)
    assert.deepEqual(tooLow.errors, [{ path: "collectionGroups.0.driverId", message: `Freja Holm needs a C licence for ${truck.label}` }])
    const later = await refused(await patchScheme(crewed.id, { validFrom: "2031-01-06", collectionGroups: [entryOf(group)] }), 400)
    assert.deepEqual(later.errors, [{ path: "validFrom", message: "Mads Jensen's licence expires on 2030-12-31, before the scheme starts" }], "the crew stands as it was, so the bound that moved is refused")
    assert.deepEqual(await oneScheme(crewed.id), crewed)
  })

  test("holds the names on the state the edit leaves: groups shift and trade names, and a name a parked group keeps is refused with nothing written", async () => {
    const routes = await scheme("Numbered", ["monday", "thursday"], [ruleGroup("Route 1", ["monday"]), ruleGroup("Route 2", ["thursday"])])
    const [one, two] = routes.collectionGroups
    const names = (scheme: RouteScheme) => scheme.collectionGroups.map((group) => [group.id === one.id ? "one" : group.id === two.id ? "two" : "added", group.name])

    const shifted = await patchedScheme(routes.id, { collectionGroups: [ruleGroup("Route 1", ["monday"]), { ...entryOf(one), name: "Route 2" }, { ...entryOf(two), name: "Route 3" }] })
    assert.deepEqual(names(shifted), [["one", "Route 2"], ["two", "Route 3"], ["added", "Route 1"]])
    const [, , added] = shifted.collectionGroups
    const traded = await patchedScheme(routes.id, { collectionGroups: [{ ...entryOf(one), name: "Route 3" }, { ...entryOf(two), name: "Route 2" }, entryOf(added)] })
    assert.deepEqual(names(traded), [["one", "Route 3"], ["two", "Route 2"], ["added", "Route 1"]])

    const taken = await refused(await patchScheme(routes.id, { name: "Numbered, again", collectionGroups: [entryOf(traded.collectionGroups[0]), { ...entryOf(added), days: ["monday", "thursday"] }, ruleGroup("Route 2", ["thursday"])] }), 409)
    assert.equal(taken.detail, 'This scheme already has a collection group called "Route 2"', "the group the list leaves out is parked and keeps its name")
    assert.deepEqual(await oneScheme(routes.id), traded, "the scheme's own rename was not written either")
  })
})
