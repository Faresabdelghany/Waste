import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ContainerType, WasteFraction } from "@waste/contracts/catalogue"
import { Container } from "@waste/contracts/containers"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { Occurrence, RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database } from "@waste/db/client"
import * as z from "zod"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { CAIRO_HOLIDAYS, COPENHAGEN_HOLIDAYS, seedPlanning, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const RouteSchemePage = Page(RouteScheme)
const Occurrences = z.array(Occurrence)

const MODULE = "route-studio.schemes"

/** The days the periods of this file are cut from; every test says which of them it means. */
const JANUARY = "2026-01-01"
const APRIL = "2026-04-01"
const JULY = "2026-07-01"
const OCTOBER = "2026-10-01"
const NEXT_YEAR = "2027-01-01"

describe("the route scheme endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let planning: PlanningFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted view: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** What a rule matches and what a manual group picks. */
  let residual: WasteFraction
  let glass: WasteFraction
  let bin: ContainerType
  let bin1: Container
  let bin2: Container
  let bin3: Container
  /** A container of Harbor Commercial, which a Copenhagen scheme may not pick. */
  let harborBin: Container
  /** The other company's. */
  let theirFraction: WasteFraction
  let theirScheme: RouteScheme

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    // The Service Provider Manager's charter already grants `route-studio` view: Lars needs no grant here to be the account that reaches no project.
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    glass = await create(olivia, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    const registered = async (label: string, projectId = a.projects.copenhagen.id) =>
      create(olivia, "/containers", { projectId, label, containerTypeId: bin.id }, Container)
    bin1 = await registered("BIN-1")
    bin2 = await registered("BIN-2")
    bin3 = await registered("BIN-3")
    harborBin = await registered("HBIN-1", a.projects.harbor.id)
    theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirScheme = await create(
      other,
      "/route-schemes",
      {
        projectId: b.projects.copenhagen.id,
        name: "Theirs",
        serviceType: "container-collection",
        frequency: "weekly",
        serviceDays: ["monday"],
        validFrom: JANUARY,
        collectionGroups: [{ name: "Theirs", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [theirFraction.id], containerTypeIds: [], vehicleTypeId: null } }],
      },
      RouteScheme,
    )
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A rule group on the residual fraction, running on the days given. */
  const ruleGroup = (name: string, days: string[], values: Record<string, unknown> = {}) => ({
    name,
    days,
    stopSource: "rule",
    rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null },
    ...values,
  })
  /** A manual group picking the containers given, in that order. */
  const manualGroup = (name: string, days: string[], containerIds: string[], values: Record<string, unknown> = {}) => ({
    name,
    days,
    stopSource: "manual",
    containerIds,
    ...values,
  })

  /** A scheme body a caller may send: the fields with no default, on Copenhagen Central inside Centrum, Mondays and Thursdays, one rule group over both. */
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

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const scheme = (name: string, values: Record<string, unknown> = {}) => create(olivia, "/route-schemes", body(name, values), RouteScheme)
  const one = async (call: Call, id: string): Promise<RouteScheme> => {
    const response = await call(`/route-schemes/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteScheme.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<RouteScheme> => {
    const response = await call(`/route-schemes/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteScheme.parse(await response.json())
  }
  const page = async (call: Call, query = "") => RouteSchemePage.parse(await (await call(`/route-schemes${query}`)).json())
  const occurrences = async (id: string, from: string, to: string) => {
    const response = await olivia(`/route-schemes/${id}/occurrences?from=${from}&to=${to}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Occurrences.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const post = (values: unknown) => olivia("/route-schemes", { method: "POST", body: values })

  describe("POST /route-schemes", () => {
    test("mints the ids, takes the defaults, and writes the groups with their rule or their containers", async () => {
      const created = await scheme("Residual Mondays", {
        plannedStartTime: "06:30",
        collectionGroups: [ruleGroup("Residual", ["monday", "thursday"], { rule: { wasteFractionIds: [residual.id, glass.id], containerTypeIds: [bin.id], vehicleTypeId: planning.vehicleTypes.rearLoader.id } }), manualGroup("Bank", ["thursday"], [bin2.id, bin1.id])],
      })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.deepEqual(
        [created.status, created.holidayPolicy, created.editPolicy, created.planAhead, created.weekRotation, created.validTo],
        ["draft", "skip", "ask", true, null, null],
        "the defaults: a draft that skips holidays, planned ahead, no rotation, running on",
      )
      assert.equal(created.plannedStartTime, "06:30", "Postgres spells the time with seconds; the wire does not")
      assert.equal(created.planningAreaId, planning.areas.centrum.id)

      const [residualGroup, bank] = created.collectionGroups
      assert.equal(Id.parse(residualGroup.id), residualGroup.id)
      assert.deepEqual([residualGroup.position, bank.position], [1, 2], "positions 1..n in the body's order when absent")
      assert.equal(residualGroup.routeSchemeId, created.id)
      assert.deepEqual(residualGroup.rule, { wasteFractionIds: [residual.id, glass.id], containerTypeIds: [bin.id], vehicleTypeId: planning.vehicleTypes.rearLoader.id })
      assert.deepEqual(
        [created.depotId, created.unloadingStationId, residualGroup.vehicleId, residualGroup.driverId],
        [null, null, null, null],
        "Resources' columns on the scheme and the group, read as null until #101's slice 6 writes them",
      )
      assert.deepEqual(residualGroup.containerIds, [])
      assert.equal(bank.rule, null, "a manual group has no rule")
      assert.deepEqual(bank.containerIds, [bin2.id, bin1.id], "in the body's stop order, not by id")
      assert.equal(bank.serviceProviderId, null)
      assert.deepEqual(await one(olivia, created.id), created, "what the write answered is what the next read says")
    })

    test("keeps the positions a body gives, and answers the groups in position order", async () => {
      const created = await scheme("Positioned", {
        collectionGroups: [ruleGroup("Second", ["thursday"], { position: 2 }), ruleGroup("First", ["monday"], { position: 1 })],
      })
      assert.deepEqual(created.collectionGroups.map((group) => [group.name, group.position]), [["First", 1], ["Second", 2]])
      assert.deepEqual((await one(olivia, created.id)).collectionGroups.map((group) => group.name), ["First", "Second"])
    })

    test("takes a group's service provider from this company, and writes a start time without seconds", async () => {
      const created = await scheme("Provided", { collectionGroups: [ruleGroup("Residual", ["monday", "thursday"], { serviceProviderId: a.serviceProviders.nordren.id })] })
      assert.equal(created.collectionGroups[0].serviceProviderId, a.serviceProviders.nordren.id)
    })

    test("holds the planning area to the scheme's project, naming the field", async () => {
      const elsewhere = await refused(await post(body("Elsewhere", { planningAreaId: planning.areas.harbor.id })), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "planningAreaId", message: "Not a planning area of this project" }])
      const nobody = await refused(await post(body("Nobody", { planningAreaId: testId() })), 400)
      assert.deepEqual(nobody.errors, [{ path: "planningAreaId", message: "Not a planning area of this project" }])
      const none = await scheme("Arealess draft", { planningAreaId: null })
      assert.equal(none.planningAreaId, null, "a draft may have no planning area yet")
    })

    test("holds every group's references to the scope its key allows, naming the entry", async () => {
      const fraction = await refused(
        await post(body("Fraction", { collectionGroups: [ruleGroup("Residual", ["monday", "thursday"]), ruleGroup("Theirs", ["monday"], { rule: { wasteFractionIds: [residual.id, theirFraction.id], containerTypeIds: [], vehicleTypeId: null } })] })),
        400,
      )
      assert.deepEqual(fraction.errors, [{ path: "collectionGroups.1.rule.wasteFractionIds.1", message: "Not a waste fraction of this company" }])
      const type = await refused(
        await post(body("Type", { collectionGroups: [ruleGroup("Residual", ["monday", "thursday"], { rule: { wasteFractionIds: [residual.id], containerTypeIds: [testId()], vehicleTypeId: null } })] })),
        400,
      )
      assert.deepEqual(type.errors, [{ path: "collectionGroups.0.rule.containerTypeIds.0", message: "Not a container type of this company" }])
      const vehicleType = await refused(
        await post(body("Vehicle type", { collectionGroups: [ruleGroup("Residual", ["monday", "thursday"], { rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: testId() } })] })),
        400,
      )
      assert.deepEqual(vehicleType.errors, [{ path: "collectionGroups.0.rule.vehicleTypeId", message: "Not a vehicle type of this company" }])
      const container = await refused(
        await post(body("Container", { collectionGroups: [ruleGroup("Residual", ["monday"]), manualGroup("Bank", ["thursday"], [bin1.id, harborBin.id])] })),
        400,
      )
      assert.deepEqual(container.errors, [{ path: "collectionGroups.1.containerIds.1", message: "Not a container of this project" }])
      const provider = await refused(
        await post(body("Provider", { collectionGroups: [ruleGroup("Residual", ["monday", "thursday"], { serviceProviderId: b.serviceProviders.nordren.id })] })),
        400,
      )
      assert.deepEqual(provider.errors, [{ path: "collectionGroups.0.serviceProviderId", message: "Not a service provider of this company" }])
    })

    test("refuses a project the caller does not work in, a member the server owns, and a group running on a day the scheme does not serve", async () => {
      const foreign = await refused(await post(body("Foreign", { projectId: b.projects.copenhagen.id })), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(await post(body("Owned", { id: testId() })), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
      const outside = await refused(await post(body("Outside", { collectionGroups: [ruleGroup("Residual", ["monday", "friday"])] })), 400)
      assert.deepEqual(outside.errors, [{ path: "collectionGroups.0.days", message: "Outside the scheme's service days" }])
    })

    test("refuses a container picked by two groups that share a day, and takes it on two groups with none in common", async () => {
      const shared = await refused(
        await post(body("Shared", { collectionGroups: [manualGroup("Mondays", ["monday", "thursday"], [bin1.id, bin2.id]), manualGroup("Thursdays", ["thursday"], [bin3.id, bin2.id])] })),
        400,
      )
      assert.deepEqual(shared.errors, [{ path: "collectionGroups.1.containerIds.1", message: "Already picked by Mondays on thursday" }])
      const disjoint = await scheme("Disjoint", { collectionGroups: [manualGroup("Mondays", ["monday"], [bin1.id, bin2.id]), manualGroup("Thursdays", ["thursday"], [bin2.id, bin1.id])] })
      assert.deepEqual(disjoint.collectionGroups.map((group) => group.containerIds), [[bin1.id, bin2.id], [bin2.id, bin1.id]], "Monday's route and Thursday's may empty the same bins")
    })

    test("holds a scheme created validated to the structural rules, listing every sentence, and lets a draft stand half-configured", async () => {
      const uncovered = await refused(await post(body("Uncovered", { status: "validated", collectionGroups: [ruleGroup("Residual", ["monday"])] })), 409)
      assert.equal(uncovered.detail, "Service days without a collection group: thursday")
      const arealess = await refused(await post(body("Arealess", { status: "validated", planningAreaId: null })), 409)
      assert.equal(arealess.detail, "The scheme has no planning area and a collection group matches by rule")
      const several = await refused(
        await post(body("Several", { status: "validated", planningAreaId: null, serviceDays: ["monday", "tuesday", "thursday"], collectionGroups: [ruleGroup("Residual", ["monday"])] })),
        409,
      )
      assert.equal(several.detail, "Service days without a collection group: tuesday, thursday. The scheme has no planning area and a collection group matches by rule")

      const draft = await scheme("Half-configured draft", { planningAreaId: null, collectionGroups: [ruleGroup("Residual", ["monday"])] })
      assert.equal(draft.status, "draft")
      const validated = await scheme("Validated", { status: "validated", collectionGroups: [ruleGroup("Residual", ["monday"]), manualGroup("Bank", ["thursday"], [bin3.id])] })
      assert.equal(validated.status, "validated", "every day covered, the rule group has a fraction, the manual group a container, and there is a planning area")
      const validatedIds = (await page(olivia, "?limit=200&status=validated")).items.map((row) => row.id)
      assert.ok(validatedIds.includes(validated.id))
      assert.ok(!validatedIds.includes(draft.id))
    })

    test("lets one name name a later scheme once the earlier one has ended, refuses an overlap, and frees the name in another project", async () => {
      const first = await scheme("Versioned", { validFrom: JANUARY, validTo: JULY })
      const second = await scheme("Versioned", { validFrom: JULY, validTo: NEXT_YEAR })
      assert.notEqual(first.id, second.id, "a new version of a name starts when the old ends")
      const problem = await refused(await post(body("Versioned", { validFrom: APRIL, validTo: OCTOBER })), 409)
      assert.equal(problem.detail, "A route scheme of this name is already in force over that period")
      assert.doesNotMatch(problem.detail ?? "", /no_overlap/)
      const harbor = await scheme("Versioned", { projectId: a.projects.harbor.id, planningAreaId: planning.areas.harbor.id, collectionGroups: [manualGroup("Havnen", ["monday", "thursday"], [harborBin.id])] })
      assert.equal(harbor.projectId, a.projects.harbor.id, "a name is one project's")
    })

    test("refuses two groups of one name in the body before anything is written", async () => {
      const problem = await refused(await post(body("Twice", { collectionGroups: [ruleGroup("Residual", ["monday"]), ruleGroup("Residual", ["thursday"])] })), 400)
      assert.deepEqual(problem.errors, [{ path: "collectionGroups", message: "A collection group name is used once in a scheme" }])
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/route-schemes", { method: "POST", body: body("Lars") }), 403)
      assert.match(problem.detail ?? "", /create on route-studio\.schemes/)
    })
  })

  describe("GET /route-schemes", () => {
    test("answers the company's schemes with their groups in id order and holds nothing of another company's", async () => {
      const mine = await scheme("Listed")
      const { items } = await page(olivia, "?limit=200")
      const ids = items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirScheme.id))
      assert.deepEqual(items.find((row) => row.id === mine.id), mine, "a page carries the groups a single read does")
      assert.deepEqual((await page(other, "?limit=200")).items.map((row) => row.name), ["Theirs"])
    })

    test("filters by project, by planning area, by status, by plan-ahead and by the day the period covers", async () => {
      const harbor = await scheme("Harbor filtered", { projectId: a.projects.harbor.id, planningAreaId: planning.areas.harbor.id, planAhead: false, collectionGroups: [manualGroup("Havnen", ["monday", "thursday"], [harborBin.id])] })
      const ended = await scheme("Ended filtered", { validFrom: JANUARY, validTo: APRIL })

      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)
      const byArea = (await page(olivia, `?limit=200&planningAreaId=${planning.areas.harbor.id}`)).items
      assert.ok(byArea.some((row) => row.id === harbor.id))
      for (const row of byArea) assert.equal(row.planningAreaId, planning.areas.harbor.id)
      const notPlanned = (await page(olivia, "?limit=200&planAhead=false")).items
      assert.ok(notPlanned.some((row) => row.id === harbor.id))
      for (const row of notPlanned) assert.equal(row.planAhead, false)
      const planned = (await page(olivia, "?limit=200&planAhead=true")).items
      assert.ok(planned.some((row) => row.id === ended.id))
      assert.ok(!planned.some((row) => row.id === harbor.id))
      const drafts = (await page(olivia, "?limit=200&status=draft")).items
      assert.ok(drafts.some((row) => row.id === ended.id))
      for (const row of drafts) assert.equal(row.status, "draft")

      const inFebruary = (await page(olivia, `?limit=200&validOn=2026-02-01&planningAreaId=${planning.areas.centrum.id}`)).items
      assert.ok(inFebruary.some((row) => row.id === ended.id))
      const onJuly = (await page(olivia, `?limit=200&validOn=${JULY}&planningAreaId=${planning.areas.centrum.id}`)).items
      assert.ok(!onJuly.some((row) => row.id === ended.id), "a scheme that ended in April is in force on no day in July")
      const onTheLastDay = (await page(olivia, `?limit=200&validOn=${APRIL}&planningAreaId=${planning.areas.centrum.id}`)).items
      assert.ok(!onTheLastDay.some((row) => row.id === ended.id), "validTo is the first day out of force")
      const bad = await refused(await olivia("/route-schemes?planAhead=yes"), 400)
      assert.deepEqual(bad.errors?.map((error) => error.path), ["planAhead"])
    })

    test("shows an account only the projects it works in, and answers an empty page to a service provider's account", async () => {
      const here = await scheme("Seen")
      const elsewhere = await scheme("Unseen", { projectId: a.projects.harbor.id, planningAreaId: planning.areas.harbor.id, collectionGroups: [manualGroup("Havnen", ["monday", "thursday"], [harborBin.id])] })
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      const { items, nextCursor } = await page(lars, "?limit=200")
      assert.deepEqual(items, [])
      assert.equal(nextCursor, null)
      await refused(await lars(`/route-schemes/${here.id}`), 404)

      const problem = await refused(await viewer(`/route-schemes?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("pages by cursor without repeating or skipping a scheme", async () => {
      const made = [await scheme("Paged 1"), await scheme("Paged 2"), await scheme("Paged 3")].map((row) => row.id)
      const all = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      const seen: string[] = []
      let cursor: string | null = null
      do {
        const current: Awaited<ReturnType<typeof page>> = await page(olivia, `?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`)
        assert.ok(current.items.length <= 2)
        seen.push(...current.items.map((row) => row.id))
        cursor = current.nextCursor
      } while (cursor !== null)
      assert.deepEqual(seen, all, "walking the pages visits every scheme once, in id order")
      for (const id of made) assert.ok(seen.includes(id))
    })

    test("refuses a role without route-studio.schemes view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/route-schemes"), 403)).detail ?? "", /view on route-studio\.schemes/)
      assert.equal((await app.request("/route-schemes")).status, 401)
    })
  })

  describe("GET /route-schemes/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/route-schemes/${theirScheme.id}`), 404)
      assert.match(foreign.detail ?? "", /route scheme/i)
      assert.equal((await one(other, theirScheme.id)).name, "Theirs", "still there for its own company")

      const elsewhere = await scheme("Harbor only", { projectId: a.projects.harbor.id, planningAreaId: planning.areas.harbor.id, collectionGroups: [manualGroup("Havnen", ["monday", "thursday"], [harborBin.id])] })
      await refused(await viewer(`/route-schemes/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).name, "Harbor only")
      await refused(await olivia(`/route-schemes/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/route-schemes/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /route-schemes/:id", () => {
    test("changes what the body names, leaves the rest and the groups, and moves the stamp", async () => {
      const created = await scheme("Amended")
      const changed = await patch(olivia, created.id, { name: "Amended twice", holidayPolicy: "shift-next", plannedStartTime: "07:15", validTo: NEXT_YEAR })
      assert.deepEqual([changed.name, changed.holidayPolicy, changed.plannedStartTime, changed.validTo], ["Amended twice", "shift-next", "07:15", NEXT_YEAR])
      assert.deepEqual(changed.serviceDays, ["monday", "thursday"], "what the patch did not name it did not touch")
      assert.deepEqual(changed.collectionGroups, created.collectionGroups, "a scheme's patch never touches its groups")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const reopened = await patch(olivia, created.id, { validTo: null, plannedStartTime: null })
      assert.deepEqual([reopened.validTo, reopened.plannedStartTime], [null, null], "a null takes the end and the start time off again")
    })

    test("refuses an end before the stored start, which the body alone cannot see", async () => {
      const created = await scheme("Backwards", { validFrom: JULY })
      const problem = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { validTo: APRIL } }), 400)
      assert.deepEqual(problem.errors?.map((error) => error.path), ["validTo"])
      assert.equal((await one(olivia, created.id)).validTo, null)
    })

    test("holds the week rotation and the daily cadence against the merged row, in the contracts' words", async () => {
      const created = await scheme("Rotated")
      const rotation = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { weekRotation: "odd" } }), 400)
      assert.deepEqual(rotation.errors, [{ path: "weekRotation", message: "Give weekRotation with every-2-weeks and with nothing else" }])
      const fortnightly = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { frequency: "every-2-weeks" } }), 400)
      assert.deepEqual(fortnightly.errors?.map((error) => error.path), ["weekRotation"])
      const both = await patch(olivia, created.id, { frequency: "every-2-weeks", weekRotation: "odd" })
      assert.deepEqual([both.frequency, both.weekRotation], ["every-2-weeks", "odd"])
      const back = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { frequency: "weekly" } }), 400)
      assert.deepEqual(back.errors?.map((error) => error.path), ["weekRotation"], "the stored rotation now has no cadence to belong to")
      assert.equal((await patch(olivia, created.id, { frequency: "weekly", weekRotation: null })).weekRotation, null)

      const daily = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { frequency: "daily" } }), 400)
      assert.deepEqual(daily.errors, [{ path: "serviceDays", message: "A daily scheme serves every weekday" }])
    })

    test("refuses service days that drop a day a group runs on, counting the groups, and writes nothing", async () => {
      const created = await scheme("Narrowed", { collectionGroups: [ruleGroup("Residual", ["monday", "thursday"]), manualGroup("Bank", ["thursday"], [bin1.id])] })
      const two = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { serviceDays: ["monday"] } }), 409)
      assert.equal(two.detail, "2 collection groups run on days the scheme would no longer serve")
      const one_ = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { serviceDays: ["thursday"] } }), 409)
      assert.equal(one_.detail, "1 collection group runs on days the scheme would no longer serve")
      const stored = await one(olivia, created.id)
      assert.deepEqual(stored.serviceDays, ["monday", "thursday"])
      assert.equal(stored.updatedAt, created.updatedAt, "a refused patch does not move the stamp")
      const widened = await patch(olivia, created.id, { serviceDays: ["monday", "tuesday", "thursday"] })
      assert.deepEqual(widened.serviceDays, ["monday", "tuesday", "thursday"], "adding a day strands no group; a draft may leave it uncovered")
    })

    test("re-runs the structural rules when the scheme is or becomes validated, and holds none against a draft", async () => {
      const created = await scheme("Becoming validated", { planningAreaId: null, collectionGroups: [ruleGroup("Residual", ["monday"])] })
      const refusedTwice = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { status: "validated" } }), 409)
      assert.equal(refusedTwice.detail, "Service days without a collection group: thursday. The scheme has no planning area and a collection group matches by rule")
      assert.equal((await one(olivia, created.id)).status, "draft")

      await create(olivia, `/route-schemes/${created.id}/collection-groups`, manualGroup("Bank", ["thursday"], [bin2.id]), z.object({ id: Id }))
      const stillArealess = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { status: "validated" } }), 409)
      assert.equal(stillArealess.detail, "The scheme has no planning area and a collection group matches by rule")
      const validated = await patch(olivia, created.id, { status: "validated", planningAreaId: planning.areas.centrum.id })
      assert.equal(validated.status, "validated")

      const areaTaken = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { planningAreaId: null } }), 409)
      assert.equal(areaTaken.detail, "The scheme has no planning area and a collection group matches by rule")
      const dayAdded = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { serviceDays: ["monday", "tuesday", "thursday"] } }), 409)
      assert.equal(dayAdded.detail, "Service days without a collection group: tuesday", "a validated scheme cannot gain a day nobody runs on")

      const draft = await patch(olivia, created.id, { status: "draft", planningAreaId: null })
      assert.equal(draft.planningAreaId, null, "back to a draft, the rules are not held")
    })

    test("holds a new planning area to the scheme's project, and refuses a period that overlaps another version", async () => {
      const created = await scheme("Re-areaed", { validFrom: JANUARY, validTo: JULY })
      const elsewhere = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { planningAreaId: planning.areas.harbor.id } }), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "planningAreaId", message: "Not a planning area of this project" }])

      const later = await scheme("Re-areaed", { validFrom: JULY, validTo: NEXT_YEAR })
      const overlap = await refused(await olivia(`/route-schemes/${later.id}`, { method: "PATCH", body: { validFrom: APRIL } }), 409)
      assert.equal(overlap.detail, "A route scheme of this name is already in force over that period")
      assert.equal((await one(olivia, later.id)).validFrom, JULY)
      const shortened = await patch(olivia, created.id, { validTo: APRIL })
      assert.equal(shortened.validTo, APRIL, "shortening the period is free")
    })

    test("refuses another company's scheme, an empty patch, an empty list of groups, and a role that may view but not edit", async () => {
      await refused(await olivia(`/route-schemes/${theirScheme.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirScheme.id)).name, "Theirs")
      const created = await scheme("Untouched")
      assert.deepEqual((await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path), [""])
      // The groups are patched whole since #205 (scheme-edit.test.ts), and a scheme keeps at least one.
      const groups = await refused(await olivia(`/route-schemes/${created.id}`, { method: "PATCH", body: { collectionGroups: [] } }), 400)
      assert.deepEqual(groups.errors?.map((error) => error.path), ["collectionGroups"], JSON.stringify(groups.errors))
      assert.match((await refused(await lars(`/route-schemes/${created.id}`, { method: "PATCH", body: { name: "Lars" } }), 403)).detail ?? "", /edit on route-studio\.schemes/)
    })
  })

  describe("GET /route-schemes/:id/occurrences", () => {
    /** Thursdays and Fridays in December, when the Copenhagen calendar has its holidays; `values` picks the policy. */
    const december = (name: string, values: Record<string, unknown> = {}) =>
      scheme(name, { serviceDays: ["thursday", "friday"], validFrom: "2026-12-01", collectionGroups: [ruleGroup("Residual", ["thursday", "friday"])], ...values })
    const dates = (rows: Occurrence[]) => rows.map((row) => [row.date, row.status, row.n, row.note ?? null])

    test("skips the holidays of the project's list, naming each as the calendar or the list does, and numbers the collections", async () => {
      const skipping = await december("Skipping")
      const rows = await occurrences(skipping.id, "2026-12-17", "2026-12-31")
      assert.deepEqual(dates(rows), [
        ["2026-12-17", "planned", 1, null],
        ["2026-12-18", "planned", 2, null],
        [COPENHAGEN_HOLIDAYS.christmasEve, "skipped", null, "Christmas Eve"],
        [COPENHAGEN_HOLIDAYS.christmasDay, "skipped", null, "Juledag"],
        [COPENHAGEN_HOLIDAYS.newYearsEve, "skipped", null, "New Year's Eve"],
      ])
      assert.ok(rows.every((row) => row.plannedDate === row.date), "a skipped row keeps its date")
      assert.deepEqual(rows.map((row) => row.week), [51, 51, 52, 52, 53])
    })

    test("shifts past further holidays and the weekend to the next working day, keeping the recurrence date as the identity", async () => {
      const shifting = await december("Shifting", { holidayPolicy: "shift-next" })
      const rows = await occurrences(shifting.id, "2026-12-21", "2026-12-31")
      assert.deepEqual(
        rows.map((row) => [row.plannedDate, row.date, row.status, row.n, row.note]),
        [
          [COPENHAGEN_HOLIDAYS.christmasEve, "2026-12-28", "shifted", 1, "Christmas Eve"],
          [COPENHAGEN_HOLIDAYS.christmasDay, "2026-12-28", "shifted", 2, "Juledag"],
          // The list names New Year's Day; the calendar has no row for it, so the 1st of January is a working day.
          [COPENHAGEN_HOLIDAYS.newYearsEve, "2027-01-01", "shifted", 3, "New Year's Eve"],
        ],
        "Christmas Eve and Christmas Day both land on the Monday after the weekend; a shift may leave the window",
      )
      const backwards = await december("Shifting back", { holidayPolicy: "shift-prev" })
      assert.deepEqual(
        (await occurrences(backwards.id, "2026-12-24", "2026-12-25")).map((row) => [row.plannedDate, row.date]),
        [
          [COPENHAGEN_HOLIDAYS.christmasEve, "2026-12-23"],
          [COPENHAGEN_HOLIDAYS.christmasDay, "2026-12-23"],
        ],
      )
    })

    test("collects on the holiday when the policy says so", async () => {
      const collecting = await december("Collecting", { holidayPolicy: "collect" })
      assert.deepEqual(dates(await occurrences(collecting.id, "2026-12-24", "2026-12-25")), [
        [COPENHAGEN_HOLIDAYS.christmasEve, "holiday", 1, "Christmas Eve"],
        [COPENHAGEN_HOLIDAYS.christmasDay, "holiday", 2, "Juledag"],
      ])
    })

    test("a project without a holiday list reads no holidays, whatever calendar rows it has", async () => {
      const harbor = await december("Harbor December", { projectId: a.projects.harbor.id, planningAreaId: planning.areas.harbor.id, collectionGroups: [manualGroup("Havnen", ["thursday", "friday"], [harborBin.id])] })
      assert.deepEqual(dates(await occurrences(harbor.id, "2026-12-24", "2026-12-25")), [
        [COPENHAGEN_HOLIDAYS.christmasEve, "planned", 1, null],
        [COPENHAGEN_HOLIDAYS.christmasDay, "planned", 2, null],
      ])
    })

    test("follows the project's weekend: a Thursday holiday in Cairo shifts to the Sunday, and the Egyptian list names the days the calendar does not", async () => {
      const cairo = await scheme("Cairo Thursdays", {
        projectId: a.projects.cairo.id,
        planningAreaId: planning.areas.cairo.id,
        serviceDays: ["tuesday", "thursday"],
        holidayPolicy: "shift-next",
        validFrom: "2026-09-01",
        collectionGroups: [ruleGroup("Maadi", ["tuesday", "thursday"])],
      })
      assert.deepEqual(
        (await occurrences(cairo.id, "2026-09-29", "2026-10-08")).map((row) => [row.plannedDate, row.date, row.status, row.note ?? null]),
        [
          ["2026-09-29", "2026-09-29", "planned", null],
          [CAIRO_HOLIDAYS.companyHoliday, "2026-10-04", "shifted", "Company holiday"],
          [CAIRO_HOLIDAYS.armedForcesDay, "2026-10-07", "shifted", "Armed Forces Day"],
          ["2026-10-08", "2026-10-08", "planned", null],
        ],
        "Friday and Saturday are Cairo's weekend, so Thursday's collection lands on Sunday",
      )
    })

    test("stops at the scheme's period: validTo is the first day out of force, and the fortnightly rotation is read", async () => {
      const wednesdays = await scheme("Wednesdays", { serviceDays: ["wednesday"], validFrom: "2026-06-01", validTo: JULY, collectionGroups: [ruleGroup("Residual", ["wednesday"])] })
      assert.deepEqual(
        (await occurrences(wednesdays.id, "2026-05-01", "2026-07-31")).map((row) => row.date),
        ["2026-06-03", "2026-06-10", "2026-06-17", "2026-06-24"],
        "nothing before validFrom, and the 1st of July — a Wednesday — is already out of force",
      )
      const odd = await scheme("Odd weeks", { frequency: "every-2-weeks", weekRotation: "odd", serviceDays: ["monday"], validFrom: JANUARY, collectionGroups: [ruleGroup("Residual", ["monday"])] })
      const rows = await occurrences(odd.id, "2026-03-01", "2026-03-31")
      assert.deepEqual(
        rows.map((row) => [row.date, row.week]),
        [
          ["2026-03-09", 11],
          ["2026-03-23", 13],
        ],
        "the Mondays of the odd ISO weeks",
      )
    })

    test("refuses a window that runs backwards or spans more than a year, and answers 404 outside the caller's scope", async () => {
      const created = await scheme("Windowed")
      const backwards = await refused(await olivia(`/route-schemes/${created.id}/occurrences?from=2026-02-01&to=2026-01-01`), 400)
      assert.deepEqual(backwards.errors?.map((error) => error.path), ["to"])
      const long = await refused(await olivia(`/route-schemes/${created.id}/occurrences?from=2026-01-01&to=2027-01-03`), 400)
      assert.deepEqual(long.errors?.map((error) => error.path), ["to"])
      const missing = await refused(await olivia(`/route-schemes/${created.id}/occurrences?from=2026-01-01`), 400)
      assert.deepEqual(missing.errors?.map((error) => error.path), ["to"])
      const year = await occurrences(created.id, "2026-01-01", "2026-12-31")
      assert.ok(year.length > 100, "a year of Mondays and Thursdays")

      await refused(await olivia(`/route-schemes/${theirScheme.id}/occurrences?from=2026-01-01&to=2026-01-31`), 404)
      await refused(await lars(`/route-schemes/${created.id}/occurrences?from=2026-01-01&to=2026-01-31`), 404)
      assert.match((await refused(await ungranted(`/route-schemes/${created.id}/occurrences?from=2026-01-01&to=2026-01-31`), 403)).detail ?? "", /view on route-studio\.schemes/)
    })
  })
})
