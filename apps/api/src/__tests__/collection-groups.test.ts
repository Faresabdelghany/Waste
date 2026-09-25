import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { ContainerType, WasteFraction } from "@waste/contracts/catalogue"
import { Container } from "@waste/contracts/containers"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { CollectionGroup, RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropPlanning, seedPlanning, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const GroupPage = Page(CollectionGroup)

const MODULE = "route-studio.schemes"
const JANUARY = "2026-01-01"

describe("the collection group endpoints", { skip: database.skip }, () => {
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

  let residual: WasteFraction
  let glass: WasteFraction
  let bin: ContainerType
  let igloo: ContainerType
  let bin1: Container
  let bin2: Container
  let bin3: Container
  /** A container of Harbor Commercial, which a Copenhagen group may not pick. */
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
    igloo = await create(olivia, "/container-types", { name: "Igloo · 2,500 L", volumeLitres: 2500 }, ContainerType)
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
        collectionGroups: [{ name: "Theirs", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [theirFraction.id], containerTypeIds: [], vehicleType: null } }],
      },
      RouteScheme,
    )
  })
  after(async () => {
    if (a) await dropPlanning(pool, a.companyId)
    if (b) await dropPlanning(pool, b.companyId)
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  const rule = (values: Record<string, unknown> = {}) => ({ wasteFractionIds: [residual.id], containerTypeIds: [], vehicleType: null, ...values })
  const ruleGroup = (name: string, days: string[], values: Record<string, unknown> = {}) => ({ name, days, stopSource: "rule", rule: rule(), ...values })
  const manualGroup = (name: string, days: string[], containerIds: string[], values: Record<string, unknown> = {}) => ({ name, days, stopSource: "manual", containerIds, ...values })

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  /** A scheme on Copenhagen Central inside Centrum, Mondays and Thursdays, with the groups given — one rule group over both days unless a test says otherwise. */
  const scheme = (name: string, values: Record<string, unknown> = {}) =>
    create(
      olivia,
      "/route-schemes",
      {
        projectId: a.projects.copenhagen.id,
        name,
        planningAreaId: planning.areas.centrum.id,
        serviceType: "container-collection",
        frequency: "weekly",
        serviceDays: ["monday", "thursday"],
        validFrom: JANUARY,
        collectionGroups: [ruleGroup("Residual", ["monday", "thursday"])],
        ...values,
      },
      RouteScheme,
    )
  const add = (schemeId: string, group: unknown) => create(olivia, `/route-schemes/${schemeId}/collection-groups`, group, CollectionGroup)
  const one = async (call: Call, id: string): Promise<CollectionGroup> => {
    const response = await call(`/collection-groups/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionGroup.parse(await response.json())
  }
  const oneScheme = async (id: string): Promise<RouteScheme> => {
    const response = await olivia(`/route-schemes/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteScheme.parse(await response.json())
  }
  const patch = async (id: string, values: unknown): Promise<CollectionGroup> => {
    const response = await olivia(`/collection-groups/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionGroup.parse(await response.json())
  }
  const put = async (id: string, set: "stop-matching-rule" | "containers", values: unknown): Promise<CollectionGroup> => {
    const response = await olivia(`/collection-groups/${id}/${set}`, { method: "PUT", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionGroup.parse(await response.json())
  }
  const page = async (call: Call, schemeId: string, query = "") => GroupPage.parse(await (await call(`/route-schemes/${schemeId}/collection-groups${query}`)).json())
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const post = (schemeId: string, group: unknown) => olivia(`/route-schemes/${schemeId}/collection-groups`, { method: "POST", body: group })

  describe("POST /route-schemes/:id/collection-groups", () => {
    test("adds a group after the last, taking the scheme and the project from the path, and the scheme reads it by position", async () => {
      const created = await scheme("Added to")
      const bank = await add(created.id, manualGroup("Bank", ["thursday"], [bin2.id, bin1.id], { serviceProviderId: a.serviceProviders.nordren.id }))
      assert.equal(Id.parse(bank.id), bank.id, "a version 7 id the server minted")
      assert.equal(bank.routeSchemeId, created.id)
      assert.equal(bank.position, 2, "after the last")
      assert.deepEqual([bank.stopSource, bank.rule, bank.containerIds], ["manual", null, [bin2.id, bin1.id]])
      assert.equal(bank.serviceProviderId, a.serviceProviders.nordren.id)
      assert.deepEqual(await one(olivia, bank.id), bank)

      const glassRun = await add(created.id, ruleGroup("Glass", ["monday"], { position: 1, rule: rule({ wasteFractionIds: [glass.id], containerTypeIds: [igloo.id], vehicleType: "glass-crane" }) }))
      assert.deepEqual(glassRun.rule, { wasteFractionIds: [glass.id], containerTypeIds: [igloo.id], vehicleType: "glass-crane" })
      assert.deepEqual((await oneScheme(created.id)).collectionGroups.map((group) => [group.name, group.position]), [["Residual", 1], ["Glass", 1], ["Bank", 2]], "by position, ties by id — the order they were made in")
    })

    test("refuses a name the scheme already has, and a group running on a day the scheme does not serve", async () => {
      const created = await scheme("Named")
      const taken = await refused(await post(created.id, manualGroup("Residual", ["thursday"], [bin1.id])), 409)
      assert.equal(taken.detail, 'This scheme already has a collection group called "Residual"')
      assert.doesNotMatch(taken.detail ?? "", /_key/)
      const outside = await refused(await post(created.id, manualGroup("Fridays", ["friday"], [bin1.id])), 400)
      assert.deepEqual(outside.errors, [{ path: "days", message: "Outside the scheme's service days" }])
      const paused = await add(created.id, manualGroup("Paused", [], [bin1.id]))
      assert.deepEqual(paused.days, [], "a group with no days runs on none of them")
    })

    test("holds the references to the scope its key allows, naming the entry", async () => {
      const created = await scheme("Referenced")
      const container = await refused(await post(created.id, manualGroup("Bank", ["thursday"], [bin1.id, harborBin.id])), 400)
      assert.deepEqual(container.errors, [{ path: "containerIds.1", message: "Not a container of this project" }])
      const fraction = await refused(await post(created.id, ruleGroup("Theirs", ["thursday"], { rule: rule({ wasteFractionIds: [theirFraction.id] }) })), 400)
      assert.deepEqual(fraction.errors, [{ path: "rule.wasteFractionIds.0", message: "Not a waste fraction of this company" }])
      const type = await refused(await post(created.id, ruleGroup("Typed", ["thursday"], { rule: rule({ containerTypeIds: [testId()] }) })), 400)
      assert.deepEqual(type.errors, [{ path: "rule.containerTypeIds.0", message: "Not a container type of this company" }])
      const provider = await refused(await post(created.id, ruleGroup("Provided", ["thursday"], { serviceProviderId: b.serviceProviders.nordren.id })), 400)
      assert.deepEqual(provider.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
      const both = await refused(await post(created.id, { ...ruleGroup("Both", ["thursday"]), containerIds: [bin1.id] }), 400)
      assert.deepEqual(both.errors, [{ path: "stopSource", message: "A collection group matches by rule or picks containers, never both" }])
    })

    test("refuses a container another group picks on a shared day, and takes it on a group with none in common", async () => {
      const created = await scheme("Picked twice", { collectionGroups: [manualGroup("Mondays", ["monday"], [bin1.id, bin2.id])] })
      const shared = await refused(await post(created.id, manualGroup("Also Mondays", ["monday", "thursday"], [bin3.id, bin1.id])), 400)
      assert.deepEqual(shared.errors, [{ path: "containerIds.1", message: "Already picked by Mondays on monday" }])
      const thursdays = await add(created.id, manualGroup("Thursdays", ["thursday"], [bin1.id, bin2.id]))
      assert.deepEqual(thursdays.containerIds, [bin1.id, bin2.id], "Thursday's route may empty Monday's bins")
    })

    test("holds a validated scheme to the structural rules with the new group: a rule group needs a planning area", async () => {
      const created = await scheme("Validated manual", { status: "validated", planningAreaId: null, collectionGroups: [manualGroup("Bank", ["monday", "thursday"], [bin1.id])] })
      const problem = await refused(await post(created.id, ruleGroup("Residual", ["monday"])), 409)
      assert.equal(problem.detail, "The scheme has no planning area and a collection group matches by rule")
      assert.equal((await oneScheme(created.id)).collectionGroups.length, 1, "nothing written")
      const manual = await add(created.id, manualGroup("More bins", ["monday"], [bin2.id]))
      assert.equal(manual.stopSource, "manual", "a manual group needs no area")
    })

    test("answers 404 for a scheme outside the caller's scope, and 403 for a role that may view but not create", async () => {
      await refused(await olivia(`/route-schemes/${theirScheme.id}/collection-groups`, { method: "POST", body: manualGroup("Mine", ["monday"], [bin1.id]) }), 404)
      const harbor = await scheme("Harbor scheme", { projectId: a.projects.harbor.id, planningAreaId: planning.areas.harbor.id, collectionGroups: [manualGroup("Havnen", ["monday", "thursday"], [harborBin.id])] })
      await refused(await viewer(`/route-schemes/${harbor.id}/collection-groups`, { method: "POST", body: manualGroup("Mine", ["monday"], [harborBin.id]) }), 404)
      const created = await scheme("Guarded")
      assert.match((await refused(await lars(`/route-schemes/${created.id}/collection-groups`, { method: "POST", body: manualGroup("Lars", ["monday"], [bin1.id]) }), 403)).detail ?? "", /create on route-studio\.schemes/)
    })
  })

  describe("GET /route-schemes/:id/collection-groups", () => {
    test("answers the scheme's groups in id order with their sets, and only that scheme's", async () => {
      const created = await scheme("Listed")
      const bank = await add(created.id, manualGroup("Bank", ["thursday"], [bin3.id]))
      const elsewhere = await scheme("Listed elsewhere")
      const { items, nextCursor } = await page(olivia, created.id, "?limit=200")
      assert.deepEqual(items.map((group) => group.name), ["Residual", "Bank"])
      assert.deepEqual(items[1], bank)
      assert.equal(nextCursor, null)
      assert.ok(!items.some((group) => group.routeSchemeId === elsewhere.id))

      const first = await page(olivia, created.id, "?limit=1")
      assert.equal(first.items.length, 1)
      assert.ok(first.nextCursor !== null)
      assert.deepEqual((await page(olivia, created.id, `?limit=1&cursor=${first.nextCursor}`)).items.map((group) => group.id), [bank.id])

      await refused(await olivia(`/route-schemes/${theirScheme.id}/collection-groups`), 404)
      await refused(await lars(`/route-schemes/${created.id}/collection-groups`), 404)
      assert.match((await refused(await ungranted(`/route-schemes/${created.id}/collection-groups`), 403)).detail ?? "", /view on route-studio\.schemes/)
    })
  })

  describe("GET /collection-groups/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      await refused(await olivia(`/collection-groups/${theirScheme.collectionGroups[0].id}`), 404)
      assert.equal((await one(other, theirScheme.collectionGroups[0].id)).name, "Theirs", "still there for its own company")
      const harbor = await scheme("Harbor read", { projectId: a.projects.harbor.id, planningAreaId: planning.areas.harbor.id, collectionGroups: [manualGroup("Havnen", ["monday", "thursday"], [harborBin.id])] })
      await refused(await viewer(`/collection-groups/${harbor.collectionGroups[0].id}`), 404)
      assert.equal((await one(olivia, harbor.collectionGroups[0].id)).name, "Havnen")
      await refused(await olivia(`/collection-groups/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/collection-groups/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
      assert.equal((await app.request(`/collection-groups/${testId()}`)).status, 401)
    })
  })

  describe("PATCH /collection-groups/:id", () => {
    test("changes the name, the position, the days and the provider, leaves the rule, and moves the stamp", async () => {
      const created = await scheme("Patched")
      const [group] = created.collectionGroups
      const changed = await patch(group.id, { name: "Residual run", position: 3, days: ["monday"], serviceProviderId: a.serviceProviders.cityhaul.id })
      assert.deepEqual([changed.name, changed.position, changed.days, changed.serviceProviderId], ["Residual run", 3, ["monday"], a.serviceProviders.cityhaul.id])
      assert.deepEqual(changed.rule, group.rule, "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > group.updatedAt)
      assert.deepEqual(await one(olivia, group.id), changed)
      assert.equal((await patch(group.id, { serviceProviderId: null })).serviceProviderId, null, "a null clears the provider")
    })

    test("never moves the source, the rule or the list, and refuses an empty patch", async () => {
      const created = await scheme("Fixed source")
      const [group] = created.collectionGroups
      for (const body of [{ stopSource: "manual" }, { rule: rule() }, { containerIds: [bin1.id] }]) {
        const problem = await refused(await olivia(`/collection-groups/${group.id}`, { method: "PATCH", body }), 400)
        assert.ok(problem.errors?.some((error) => new RegExp(Object.keys(body)[0]).test(error.message)), JSON.stringify(problem.errors))
      }
      assert.deepEqual((await refused(await olivia(`/collection-groups/${group.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path), [""])
    })

    test("holds new days within the scheme's, and off a day another group picks one of this group's containers", async () => {
      const created = await scheme("Days moved", { collectionGroups: [manualGroup("Mondays", ["monday"], [bin1.id]), manualGroup("Thursdays", ["thursday"], [bin1.id, bin2.id])] })
      const [, thursdays] = created.collectionGroups
      const outside = await refused(await olivia(`/collection-groups/${thursdays.id}`, { method: "PATCH", body: { days: ["thursday", "friday"] } }), 400)
      assert.deepEqual(outside.errors, [{ path: "days", message: "Outside the scheme's service days" }])
      const collides = await refused(await olivia(`/collection-groups/${thursdays.id}`, { method: "PATCH", body: { days: ["monday", "thursday"] } }), 400)
      assert.deepEqual(collides.errors, [{ path: "days", message: `Container ${bin1.id} is already picked by Mondays on monday` }])
      assert.deepEqual((await one(olivia, thursdays.id)).days, ["thursday"])
    })

    test("holds a validated scheme to its structure when a group's days move, and refuses a taken name", async () => {
      const created = await scheme("Validated days", { status: "validated", collectionGroups: [ruleGroup("Residual", ["monday", "thursday"]), manualGroup("Bank", ["thursday"], [bin3.id])] })
      const [residualRun, bank] = created.collectionGroups
      const uncovered = await refused(await olivia(`/collection-groups/${residualRun.id}`, { method: "PATCH", body: { days: ["thursday"] } }), 409)
      assert.equal(uncovered.detail, "Service days without a collection group: monday")
      assert.deepEqual((await one(olivia, residualRun.id)).days, ["monday", "thursday"], "nothing written")
      const paused = await patch(bank.id, { days: [] })
      assert.deepEqual(paused.days, [], "the rule group still covers both days")
      const taken = await refused(await olivia(`/collection-groups/${bank.id}`, { method: "PATCH", body: { name: "Residual" } }), 409)
      assert.equal(taken.detail, 'This scheme already has a collection group called "Residual"')
    })

    test("holds the provider to this company, and refuses another company's group and a role that may view but not edit", async () => {
      const created = await scheme("Provider patched")
      const [group] = created.collectionGroups
      const provider = await refused(await olivia(`/collection-groups/${group.id}`, { method: "PATCH", body: { serviceProviderId: b.serviceProviders.nordren.id } }), 400)
      assert.deepEqual(provider.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
      await refused(await olivia(`/collection-groups/${theirScheme.collectionGroups[0].id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirScheme.collectionGroups[0].id)).name, "Theirs")
      assert.match((await refused(await lars(`/collection-groups/${group.id}`, { method: "PATCH", body: { name: "Lars" } }), 403)).detail ?? "", /edit on route-studio\.schemes/)
    })
  })

  describe("PUT /collection-groups/:id/stop-matching-rule", () => {
    test("replaces the whole rule of a rule group and moves the stamp; a manual group has no rule to replace", async () => {
      const created = await scheme("Re-ruled", { status: "validated", collectionGroups: [ruleGroup("Residual", ["monday", "thursday"]), manualGroup("Bank", ["thursday"], [bin3.id])] })
      const [residualRun, bank] = created.collectionGroups
      const replaced = await put(residualRun.id, "stop-matching-rule", { wasteFractionIds: [glass.id, residual.id], containerTypeIds: [igloo.id, bin.id], vehicleType: "glass-crane" })
      assert.deepEqual(replaced.rule, { wasteFractionIds: [glass.id, residual.id], containerTypeIds: [igloo.id, bin.id], vehicleType: "glass-crane" }, "in the body's order")
      assert.deepEqual(replaced.containerIds, [])
      assert.ok(replaced.updatedAt > residualRun.updatedAt, "the rule is part of the group on the wire")
      assert.deepEqual(await one(olivia, residualRun.id), replaced)
      const narrowed = await put(residualRun.id, "stop-matching-rule", { wasteFractionIds: [glass.id], containerTypeIds: [], vehicleType: null })
      assert.deepEqual(narrowed.rule, { wasteFractionIds: [glass.id], containerTypeIds: [], vehicleType: null }, "what the body left out is gone")

      const manual = await refused(await olivia(`/collection-groups/${bank.id}/stop-matching-rule`, { method: "PUT", body: rule() }), 409)
      assert.equal(manual.detail, "This collection group picks containers; it has no stop matching rule")
      assert.equal((await one(olivia, bank.id)).updatedAt, bank.updatedAt)
    })

    test("holds the fractions and the types to this company, naming the entry, and refuses an empty rule", async () => {
      const created = await scheme("Rule refs")
      const [group] = created.collectionGroups
      const fraction = await refused(await olivia(`/collection-groups/${group.id}/stop-matching-rule`, { method: "PUT", body: rule({ wasteFractionIds: [residual.id, theirFraction.id] }) }), 400)
      assert.deepEqual(fraction.errors, [{ path: "wasteFractionIds.1", message: "Not a waste fraction of this company" }])
      const type = await refused(await olivia(`/collection-groups/${group.id}/stop-matching-rule`, { method: "PUT", body: rule({ containerTypeIds: [testId()] }) }), 400)
      assert.deepEqual(type.errors, [{ path: "containerTypeIds.0", message: "Not a container type of this company" }])
      const empty = await refused(await olivia(`/collection-groups/${group.id}/stop-matching-rule`, { method: "PUT", body: rule({ wasteFractionIds: [] }) }), 400)
      assert.deepEqual(empty.errors?.map((error) => error.path), ["wasteFractionIds"])
      assert.deepEqual((await one(olivia, group.id)).rule, group.rule, "a refused body leaves the rule as it was")

      await refused(await olivia(`/collection-groups/${theirScheme.collectionGroups[0].id}/stop-matching-rule`, { method: "PUT", body: rule() }), 404)
      assert.match((await refused(await lars(`/collection-groups/${group.id}/stop-matching-rule`, { method: "PUT", body: rule() }), 403)).detail ?? "", /edit on route-studio\.schemes/)
    })
  })

  describe("PUT /collection-groups/:id/containers", () => {
    test("replaces the whole list in stop order and moves the stamp; a rule group's containers are not picked", async () => {
      const created = await scheme("Re-picked", { collectionGroups: [ruleGroup("Residual", ["monday"]), manualGroup("Bank", ["thursday"], [bin1.id])] })
      const [residualRun, bank] = created.collectionGroups
      const replaced = await put(bank.id, "containers", { containerIds: [bin3.id, bin1.id, bin2.id] })
      assert.deepEqual(replaced.containerIds, [bin3.id, bin1.id, bin2.id], "positions 1..n in the body's order")
      assert.equal(replaced.rule, null)
      assert.ok(replaced.updatedAt > bank.updatedAt)
      assert.deepEqual(await one(olivia, bank.id), replaced)
      assert.deepEqual((await put(bank.id, "containers", { containerIds: [bin2.id] })).containerIds, [bin2.id], "what the body left out is gone")

      const byRule = await refused(await olivia(`/collection-groups/${residualRun.id}/containers`, { method: "PUT", body: { containerIds: [bin1.id] } }), 409)
      assert.equal(byRule.detail, "This collection group matches by rule; its containers are not picked")
    })

    test("holds every container to the scheme's project and off the other groups' shared days, naming the entry", async () => {
      const created = await scheme("Pick refs", { collectionGroups: [manualGroup("Mondays", ["monday"], [bin1.id]), manualGroup("Thursdays", ["thursday"], [bin2.id]), manualGroup("Both", ["monday", "thursday"], [bin3.id])] })
      const [, , both] = created.collectionGroups
      const elsewhere = await refused(await olivia(`/collection-groups/${both.id}/containers`, { method: "PUT", body: { containerIds: [bin3.id, harborBin.id] } }), 400)
      assert.deepEqual(elsewhere.errors, [{ path: "containerIds.1", message: "Not a container of this project" }])
      const shared = await refused(await olivia(`/collection-groups/${both.id}/containers`, { method: "PUT", body: { containerIds: [bin3.id, bin2.id] } }), 400)
      assert.deepEqual(shared.errors, [{ path: "containerIds.1", message: "Already picked by Thursdays on thursday" }])
      const twice = await refused(await olivia(`/collection-groups/${both.id}/containers`, { method: "PUT", body: { containerIds: [bin3.id, bin3.id] } }), 400)
      assert.deepEqual(twice.errors?.map((error) => error.path), ["containerIds"])
      const none = await refused(await olivia(`/collection-groups/${both.id}/containers`, { method: "PUT", body: { containerIds: [] } }), 400)
      assert.deepEqual(none.errors?.map((error) => error.path), ["containerIds"])
      assert.deepEqual((await one(olivia, both.id)).containerIds, [bin3.id], "a refused body leaves the list as it was")

      const [mondays] = created.collectionGroups
      const disjoint = await put(mondays.id, "containers", { containerIds: [bin1.id, bin2.id] })
      assert.deepEqual(disjoint.containerIds, [bin1.id, bin2.id], "Monday's route may empty Thursday's bin")

      await refused(await olivia(`/collection-groups/${theirScheme.collectionGroups[0].id}/containers`, { method: "PUT", body: { containerIds: [bin1.id] } }), 404)
      assert.match((await refused(await lars(`/collection-groups/${both.id}/containers`, { method: "PUT", body: { containerIds: [bin1.id] } }), 403)).detail ?? "", /edit on route-studio\.schemes/)
    })
  })
})
