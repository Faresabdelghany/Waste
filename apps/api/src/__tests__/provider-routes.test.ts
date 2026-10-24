// A Service Provider's reach on the routes and the pickups (#291 slice 23,
// the first of #112 §7.21's follow-ups): Lars, NordRen's manager, reads the
// routes NordRen runs — a route whose scheme plans inside a planning area of
// a Service Area assigned to NordRen, the assignment and the area in force on
// the route's operating date (`servesRoute`) — and their stops, Plans, device
// log and proof objects, each as the office reads it, and nothing else; and
// he commands none of them but the two he crews them with, `assign` and
// `dispatch` (#291 slice 23b, provider-doors.test.ts) — a route command finds
// no row for him (the family's 404, the settlements' precedent) and the
// pickups' and weights' are refused at the grant his charter does not give.
// The office's reads and commands keep `inProjects`, which their own suites
// hold.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import { Page } from "@waste/contracts/pagination"
import { PickupDetail, PickupListItem } from "@waste/contracts/pickups"
import { Plan, PlanDetail } from "@waste/contracts/plans"
import { ProofObjectLinks } from "@waste/contracts/proof-objects"
import { LiveRoute, RouteDetail, RouteListItem } from "@waste/contracts/routes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { role, roleGrant, serviceProviderAccess, userAccount } from "@waste/db/schema/access"
import { route } from "@waste/db/schema/execution"
import { serviceAreaAssignment } from "@waste/db/schema/finance"
import { plan, planStop } from "@waste/db/schema/routing"
import { routeScheme } from "@waste/db/schema/route-schemes"
import type { ProofStorage } from "@waste/db/storage"
import { withCompany } from "@waste/db/tenant"
import { normaliseGrants } from "@waste/domain/access/grants"
import { and, eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import { createApp } from "../app"
import { NOT_A_ROUTE } from "../routes/references"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures, type SeededRoute } from "./execution-fixtures"
import { seedFinance, type FinanceFixtures } from "./finance-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Account, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the fixtures' proofs and the Plan's stops, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const RoutePage = Page(RouteListItem)
const PickupPage = Page(PickupListItem)
const PlanPage = Page(Plan)
const ReceiptPage = Page(DriverCommandReceipt)
const LivePage = Page(LiveRoute)

/** The fixtures' Monday, mid-morning in Copenhagen: the request's clock. */
const MORNING = new Date("2026-10-05T08:00:00Z")

/** A Storage that signs a read URL for every key, and nothing else: the proof-object read is what is proved here, not Storage. */
const storage: ProofStorage = {
  async signUpload() {
    throw new Error("not the provider's")
  },
  async signReads(keys) {
    return new Map(keys.map((key) => [key, `https://storage.test/read/${key}`]))
  },
  async remove() {
    throw new Error("not the provider's")
  },
}

describe("a Service Provider's reach on the routes and the pickups", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let finance: FinanceFixtures
  let olivia: Call
  /** Lars, NordRen's Service Provider Manager: `route-studio` view by charter, no project. */
  let lars: Call
  /** CityHaul's manager, on the same charter: the other provider of the company. */
  let mikkel: Call
  /** A NordRen account on a custom role granted every action on the routes, the pickups and the weights, no project. */
  let nora: Call
  /** Lars of another company. */
  let otherLars: Call
  /**
   * The routes by what they prove. NordRen runs the fixtures' three (Copenhagen, Centrum, 2026-10-05) and `later`
   * (2026-11-02); it runs none of `beforeAssignment` (the day before its award starts), `harbor` (a scheme with no
   * planning area), `cairo` (an area nobody holds) or `adHoc` (the office's own route, no scheme).
   */
  let routes: { later: SeededRoute; beforeAssignment: SeededRoute; harbor: SeededRoute; cairo: SeededRoute; adHoc: RouteDetail }
  /** The manual Plan on the planned route, its stops reversed, active. */
  let manualPlanId: string

  /** An account of a's, on a role, under a provider's access: what a NordRen or a CityHaul user is. */
  const providerAccount = async (tx: Tx, roleId: string, serviceProviderId: string, localPart: string): Promise<Account> => {
    const account: Account = { id: testId(), authUserId: randomUUID(), email: `${localPart}@${a.users.olivia.email.split("@")[1]}`, fullName: localPart }
    await tx.insert(userAccount).values({ id: account.id, companyId: a.companyId, authUserId: account.authUserId, email: account.email, fullName: account.fullName, roleId, serviceProviderId })
    await tx.insert(serviceProviderAccess).values({ companyId: a.companyId, userAccountId: account.id, serviceProviderId })
    return account
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    ex = await seedExecution(pool, a, fleet)
    // NordRen holds Centrum from 2026-03-01 to the year's end.
    finance = await seedFinance(pool, a, planning)
    const day = (operatingDate: string, seed: Parameters<typeof seedRoute>[4] = {}) => seedRoute(pool, a, fleet, ex, { operatingDate, ...seed })
    let accounts: { mikkel: Account; nora: Account } | undefined
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      // The Copenhagen scheme plans inside Centrum, NordRen's; the Cairo scheme inside Maadi, which nobody holds; the Harbor scheme names no area.
      await tx.update(routeScheme).set({ planningAreaId: planning.areas.centrum.id }).where(and(eq(routeScheme.companyId, a.companyId), eq(routeScheme.id, ex.schemes.copenhagen.id)))
      await tx.update(routeScheme).set({ planningAreaId: planning.areas.cairo.id }).where(and(eq(routeScheme.companyId, a.companyId), eq(routeScheme.id, ex.schemes.cairo.id)))
      const dispatcherRole = testId()
      await tx.insert(role).values({ id: dispatcherRole, companyId: a.companyId, key: null, name: "Provider dispatcher", scope: "Own service provider", description: "Every action on the routes, the pickups and the weights", system: false })
      const grants = normaliseGrants([
        { moduleKey: "route-studio.routes", actions: ["view", "create", "edit"] },
        { moduleKey: "route-studio.pickups", actions: ["view", "edit"] },
        { moduleKey: "route-studio.weights", actions: ["view", "create", "edit"] },
      ])
      await tx.insert(roleGrant).values(grants.flatMap((grant) => grant.actions.map((action) => ({ companyId: a.companyId, roleId: dispatcherRole, moduleKey: grant.moduleKey, action }))))
      accounts = {
        mikkel: await providerAccount(tx, a.roles.providerManager.id, a.serviceProviders.cityhaul.id, "mikkel.andersen"),
        nora: await providerAccount(tx, dispatcherRole, a.serviceProviders.nordren.id, "nora.dispatcher"),
      }
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => MORNING, storage })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    mikkel = callingAs(app, keys, accounts!.mikkel, a.companyId)
    nora = callingAs(app, keys, accounts!.nora, a.companyId)
    otherLars = callingAs(app, keys, b.users.lars, b.companyId)

    const adHoc = await olivia("/routes", { method: "POST", body: { projectId: a.projects.copenhagen.id, operatingDate: "2026-10-06" } })
    assert.equal(adHoc.status, 201, JSON.stringify(await adHoc.clone().json()))
    routes = {
      later: await day("2026-11-02"),
      beforeAssignment: await day("2026-02-27"),
      harbor: await day("2026-10-05", { project: "harbor" }),
      cairo: await day("2026-10-05", { project: "cairo" }),
      adHoc: RouteDetail.parse(await adHoc.json()),
    }

    // A manual Plan on the planned route, its stops in reverse: the sequence a stop carries is the Plan's, not its position.
    manualPlanId = testId()
    const planned = ex.routes.planned
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(plan).values({ id: manualPlanId, companyId: a.companyId, projectId: planned.projectId, routeId: planned.id, solver: "manual", status: "calculating", fingerprint: `test-${manualPlanId}`, trip: "stops-only", provider: "fake" })
      await tx.insert(planStop).values(
        [...planned.pickupIds].reverse().map((pickupId, index) => ({ id: testId(), companyId: a.companyId, projectId: planned.projectId, routeId: planned.id, planId: manualPlanId, pickupId, position: index + 1 })),
      )
      await tx.update(route).set({ activePlanId: manualPlanId }).where(and(eq(route.companyId, a.companyId), eq(route.id, planned.id)))
    })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const ok = async (response: Response): Promise<unknown> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return await response.json()
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const routePage = async (call: Call, query = "?limit=200") => RoutePage.parse(await ok(await call(`/routes${query}`)))
  const pickupPage = async (call: Call, query = "?limit=200") => PickupPage.parse(await ok(await call(`/pickups${query}`)))
  const routeIds = async (call: Call, query = "?limit=200") => (await routePage(call, query)).items.map((item) => item.id).sort()
  const pickupIds = async (call: Call, query = "?limit=200") => (await pickupPage(call, query)).items.map((item) => item.id).sort()
  /** The routes NordRen runs, as the fixtures put them. */
  const nordrens = () => [ex.routes.ready.id, ex.routes.planned.id, ex.routes.completed.id, routes.later.id].sort()
  /** The routes NordRen does not run. */
  const notNordrens = () => [routes.beforeAssignment.id, routes.harbor.id, routes.cairo.id, routes.adHoc.id]

  describe("the routes", () => {
    test("Lars lists exactly the routes NordRen runs, each as the office lists it", async () => {
      assert.deepEqual(await routeIds(lars), nordrens())
      const office = await routePage(olivia)
      for (const id of notNordrens()) assert.ok(office.items.some((item) => item.id === id), "the office lists the rest")
      const his = await routePage(lars)
      assert.deepEqual(
        his.items,
        office.items.filter((item) => nordrens().includes(item.id)),
        "the same rows, progress and active Plan included, in the same order",
      )
    })

    test("the list pages and filters inside the reach, and a project named from a provider's account is refused", async () => {
      const walked: string[] = []
      let cursor: string | null = null
      do {
        const page: ReturnType<typeof RoutePage.parse> = await routePage(lars, `?limit=1${cursor === null ? "" : `&cursor=${cursor}`}`)
        walked.push(...page.items.map((item) => item.id))
        cursor = page.nextCursor
      } while (cursor !== null)
      assert.deepEqual([...walked].sort(), nordrens(), "one at a time, the same four")
      assert.deepEqual(await routeIds(lars, "?status=completed"), [ex.routes.completed.id])
      assert.deepEqual(await routeIds(lars, "?from=2026-11-01"), [routes.later.id])
      assert.deepEqual(await routeIds(lars, "?serviceDate=2026-10-05"), [ex.routes.ready.id, ex.routes.planned.id, ex.routes.completed.id].sort(), "the Harbor and Cairo routes of the day are not NordRen's")
      assert.deepEqual(
        (await refused(await lars(`/routes?projectId=${a.projects.copenhagen.id}`), 400)).errors?.map((error) => error.path),
        ["projectId"],
        "a provider's account works in no project",
      )
    })

    test("a route NordRen runs reads as the office reads it; one it does not run is the family's 404", async () => {
      for (const id of [ex.routes.ready.id, ex.routes.completed.id, routes.later.id]) {
        assert.deepEqual(RouteDetail.parse(await ok(await lars(`/routes/${id}`))), RouteDetail.parse(await ok(await olivia(`/routes/${id}`))), id)
      }
      for (const id of [...notNordrens(), testId()]) {
        assert.equal((await refused(await lars(`/routes/${id}`), 404)).detail, `No route ${id} in the projects this account works in`)
      }
    })

    test("the device log and the Plans of a route NordRen runs, as the office reads them, and of no other", async () => {
      const completed = ex.routes.completed.id
      assert.deepEqual(ReceiptPage.parse(await ok(await lars(`/routes/${completed}/commands`))), ReceiptPage.parse(await ok(await olivia(`/routes/${completed}/commands`))))
      const planned = ex.routes.planned.id
      const plans = PlanPage.parse(await ok(await lars(`/routes/${planned}/plans`)))
      assert.deepEqual(
        plans.items.map((item) => item.id),
        [manualPlanId],
      )
      assert.deepEqual(plans, PlanPage.parse(await ok(await olivia(`/routes/${planned}/plans`))))
      assert.deepEqual(PlanDetail.parse(await ok(await lars(`/plans/${manualPlanId}`))), PlanDetail.parse(await ok(await olivia(`/plans/${manualPlanId}`))))
      for (const id of notNordrens()) {
        await refused(await lars(`/routes/${id}/commands`), 404)
        await refused(await lars(`/routes/${id}/plans`), 404)
      }
      await refused(await mikkel(`/plans/${manualPlanId}`), 404)
    })

    test("the live dashboard stays the office's: Lars reads an empty page", async () => {
      assert.deepEqual(LivePage.parse(await ok(await lars("/routes/live"))), { items: [], nextCursor: null })
      assert.ok(LivePage.parse(await ok(await olivia("/routes/live"))).items.some((item) => item.id === ex.routes.ready.id), "the office's live page has the ready route due today")
    })
  })

  describe("the pickups", () => {
    test("Lars lists exactly the stops of the routes NordRen runs, each with the sequence the office reads", async () => {
      const theirs = [ex.routes.ready, ex.routes.planned, ex.routes.completed, routes.later].flatMap((seeded) => seeded.pickupIds).sort()
      assert.deepEqual(await pickupIds(lars), theirs)
      const office = await pickupPage(olivia)
      const his = await pickupPage(lars)
      assert.deepEqual(
        his.items,
        office.items.filter((item) => theirs.includes(item.id)),
        "the same rows in the same order",
      )
      // The planned route's stops carry the manual Plan's order, read through the reach: reversed.
      const planned = his.items.filter((item) => item.routeId === ex.routes.planned.id).sort((x, y) => x.position - y.position)
      assert.deepEqual(
        planned.map((item) => item.sequence),
        [3, 2, 1],
      )
    })

    test("a route of NordRen's narrows the list to its stops; one it does not run, or a project, is refused on the query", async () => {
      assert.deepEqual(await pickupIds(lars, `?routeId=${ex.routes.ready.id}`), [...ex.routes.ready.pickupIds].sort())
      assert.deepEqual(await pickupIds(lars, `?status=failed`), [ex.routes.completed.pickupIds[1]])
      for (const id of [routes.beforeAssignment.id, routes.harbor.id]) {
        const problem = await refused(await lars(`/pickups?routeId=${id}`), 400)
        assert.deepEqual(
          problem.errors?.map((error) => [error.path, error.message]),
          [["routeId", NOT_A_ROUTE]],
        )
      }
      assert.deepEqual(
        (await refused(await lars(`/pickups?projectId=${a.projects.copenhagen.id}`), 400)).errors?.map((error) => error.path),
        ["projectId"],
      )
      // The office's rule is the one it was: a route of the project named, or of any it works in.
      assert.deepEqual(await pickupIds(olivia, `?routeId=${routes.beforeAssignment.id}`), [...routes.beforeAssignment.pickupIds].sort())
      await refused(await olivia(`/pickups?routeId=${ex.routes.ready.id}&projectId=${a.projects.harbor.id}`), 400)
    })

    test("a stop NordRen runs reads as the office reads it, its proof objects too; any other is the family's 404", async () => {
      for (const id of [ex.routes.completed.pickupIds[0], ex.routes.planned.pickupIds[0]]) {
        assert.deepEqual(PickupDetail.parse(await ok(await lars(`/pickups/${id}`))), PickupDetail.parse(await ok(await olivia(`/pickups/${id}`))), id)
        assert.deepEqual(ProofObjectLinks.parse(await ok(await lars(`/pickups/${id}/proof-objects`))), ProofObjectLinks.parse(await ok(await olivia(`/pickups/${id}/proof-objects`))))
      }
      const theirs = routes.beforeAssignment.pickupIds[0]
      assert.equal((await refused(await lars(`/pickups/${theirs}`), 404)).detail, `No pickup ${theirs} in the projects this account works in`)
      await refused(await lars(`/pickups/${theirs}/proof-objects`), 404)
      assert.equal((await ok(await olivia(`/pickups/${theirs}`)) as { id: string }).id, theirs, "the office reads it")
    })
  })

  describe("who else reaches what", () => {
    test("CityHaul's manager reaches nothing of NordRen's, and another company's Lars nothing of this company's", async () => {
      for (const call of [mikkel, otherLars]) {
        assert.deepEqual(await routeIds(call), [])
        assert.deepEqual(await pickupIds(call), [])
        await refused(await call(`/routes/${ex.routes.ready.id}`), 404)
        await refused(await call(`/pickups/${ex.routes.ready.pickupIds[0]}`), 404)
      }
    })

    test("the reach follows the assignment: ended on 2026-11-01, the route after its end leaves Lars's list and reads 404, the office's read unchanged", async () => {
      const setEnd = (validTo: string) =>
        withCompany(pool.db, a.companyId, async (tx: Tx) => {
          await tx
            .update(serviceAreaAssignment)
            .set({ validTo })
            .where(and(eq(serviceAreaAssignment.companyId, a.companyId), eq(serviceAreaAssignment.id, finance.nordren.assignmentId ?? "")))
        })
      await setEnd("2026-11-01")
      try {
        assert.deepEqual(await routeIds(lars), [ex.routes.ready.id, ex.routes.planned.id, ex.routes.completed.id].sort())
        await refused(await lars(`/routes/${routes.later.id}`), 404)
        assert.equal((await pickupIds(lars)).includes(routes.later.pickupIds[0]), false)
        await ok(await olivia(`/routes/${routes.later.id}`))
      } finally {
        await setEnd("2027-01-01")
      }
      assert.ok((await routeIds(lars)).includes(routes.later.id), "and back once the assignment runs again")
    })
  })

  describe("the commands", () => {
    /**
     * Every command of the two families a provider does not crew with, with a body each validator takes, on a route and a stop NordRen
     * runs, and the module whose grant it asks. `assign` and `dispatch`, the two a provider crews its routes with (#291 slice 23b), are
     * provider-doors.test.ts's.
     */
    const commands = () => {
      const planned = ex.routes.planned
      const completed = ex.routes.completed
      return [
        { path: `/routes/${planned.id}/reschedule`, method: "POST", body: { plannedStartTime: "07:00" }, family: "route", module: "routes" },
        { path: `/routes/${planned.id}/release-hold`, method: "POST", body: {}, family: "route", module: "routes" },
        { path: `/routes/${planned.id}/cancel`, method: "POST", body: { reasonCode: "other", reason: "Not ours" }, family: "route", module: "routes" },
        { path: `/routes/${planned.id}/pickup-order`, method: "PUT", body: { pickupIds: [...planned.pickupIds] }, family: "route", module: "routes" },
        { path: `/routes/${planned.id}/optimise`, method: "POST", body: undefined, family: "route", module: "routes" },
        { path: `/routes/${planned.id}/pickups`, method: "POST", body: { containerId: ex.containers.bin1.id }, family: "route", module: "pickups" },
        { path: `/routes/${completed.id}/unloads`, method: "POST", body: { unloadingStationId: fleet.stations.amager.id, wasteFractionId: ex.fractions.residual.id, netKg: 4_200, occurredAt: "2026-10-05T07:00:00Z" }, family: "route", module: "weights" },
        { path: `/pickups/${planned.pickupIds[0]}/remove`, method: "POST", body: { reason: "Not ours" }, family: "pickup", module: "pickups" },
        { path: `/pickups/${completed.pickupIds[1]}/correct-outcome`, method: "POST", body: { outcome: "completed", note: "We emptied it after all" }, family: "pickup", module: "pickups" },
      ] as const
    }

    test("under the charter, which grants the routes `edit` for crewing and the pickups and the weights `view`, a route command finds no row and the rest are refused at the grant", async () => {
      for (const { path, method, body, module } of commands()) {
        if (module === "routes") {
          assert.match((await refused(await lars(path, { method, body }), 404)).detail ?? "", /^No route .* in the projects this account works in$/, path)
        } else {
          assert.match((await refused(await lars(path, { method, body }), 403)).detail ?? "", new RegExp(`does not allow (edit|create) on route-studio\\.${module}`), path)
        }
      }
    })

    test("on a role granted `edit` everywhere, every command on a route NordRen runs is the family's 404, nothing is written, and the route still reads", async () => {
      const before = await Promise.all([ex.routes.planned.id, ex.routes.completed.id].map(async (id) => RouteDetail.parse(await ok(await olivia(`/routes/${id}`)))))
      for (const { path, method, body, family } of commands()) {
        const problem = await refused(await nora(path, { method, body }), 404)
        assert.match(problem.detail ?? "", family === "route" ? /^No route .* in the projects this account works in$/ : /^No pickup .* in the projects this account works in$/, path)
      }
      // A create names a project, and a provider's account works in none.
      assert.deepEqual(
        (await refused(await nora("/routes", { method: "POST", body: { projectId: a.projects.copenhagen.id, operatingDate: "2026-10-07" } }), 400)).errors?.map((error) => error.path),
        ["projectId"],
      )
      const after = await Promise.all([ex.routes.planned.id, ex.routes.completed.id].map(async (id) => RouteDetail.parse(await ok(await olivia(`/routes/${id}`)))))
      assert.deepEqual(after, before, "nothing moved")
      assert.deepEqual(RouteDetail.parse(await ok(await nora(`/routes/${ex.routes.planned.id}`))), after[0], "and the account still reads the route it runs")
    })
  })
})
