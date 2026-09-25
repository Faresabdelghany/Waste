// The provider predicate (Issue #112 §3, ADR-0001), run as a statement over
// seeded routes: `servesRoute` reaches exactly the routes whose scheme's
// planning area is in a service area assigned to the account's provider on
// the route's operating date, and is a SQL `false` for an office account;
// `reachesAssignments` is a provider's own assignments, an office account's
// projects', and `false` for an account with neither. Built here, wired into
// nothing (§7.21): the follow-up issues put it on each family's list and
// single read.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database, type Tx } from "@waste/db/client"
import { route } from "@waste/db/schema/execution"
import { serviceAreaAssignment } from "@waste/db/schema/finance"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import type { Principal } from "../auth/principal"
import { providerIdOf, reachesAssignments, servesRoute } from "../auth/provider"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { FINANCE_YEAR, NORDREN_ASSIGNED_FROM, seedFinance, seedServiceArea, type FinanceFixtures } from "./finance-fixtures"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"

const database = databaseUnderTest()
/** The owner sweeps the proofs the execution fixtures append, which `wms_api` may not delete. */
const owner = ownerUnderTest()

describe("the provider predicate", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let tenant: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let execution: ExecutionFixtures
  let finance: FinanceFixtures
  /** Routes by what they prove: the day inside the assignment, the day before it starts, the first day of it, the last day of the area, the first day after, a scheme with no planning area, and a route of a planning area nobody holds. */
  let routes: Record<"inside" | "beforeAssignment" | "firstDay" | "lastDay" | "afterArea" | "noArea" | "unheld", string>

  /** A principal as the request path would build it, with only what the two predicates read. */
  const principalOf = (provider: { id: string; legalName: string } | null, projects: { id: string; name: string }[]): Principal => ({
    userId: testId(),
    companyId: tenant.companyId,
    user: { id: testId(), email: "someone@example", fullName: "Someone", allProjects: false, primaryAdministrator: false },
    company: { id: tenant.companyId, name: tenant.name },
    role: { id: testId(), key: null, name: "Role", scope: "Company", system: false },
    grants: [],
    projects,
    serviceProvider: provider,
  })

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    tenant = await seedTenant(pool)
    planning = await seedPlanning(pool, tenant)
    fleet = await seedFleet(pool, tenant, planning)
    execution = await seedExecution(pool, tenant, fleet)
    finance = await seedFinance(pool, tenant, planning)
    // The Copenhagen scheme plans inside Centrum, which NordRen's award covers; the Harbor scheme names no planning area.
    await withCompany(pool.db, tenant.companyId, async (tx: Tx) => {
      await tx
        .update(routeScheme)
        .set({ planningAreaId: planning.areas.centrum.id })
        .where(and(eq(routeScheme.companyId, tenant.companyId), eq(routeScheme.id, execution.schemes.copenhagen.id)))
      await tx
        .update(routeScheme)
        .set({ planningAreaId: planning.areas.cairo.id })
        .where(and(eq(routeScheme.companyId, tenant.companyId), eq(routeScheme.id, execution.schemes.cairo.id)))
    })
    const day = (operatingDate: string, seed: Parameters<typeof seedRoute>[4] = {}) => seedRoute(pool, tenant, fleet, execution, { operatingDate, ...seed })
    const dayBefore = (iso: string) => new Date(new Date(`${iso}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10)
    routes = {
      inside: execution.routes.ready.id,
      beforeAssignment: (await day(dayBefore(NORDREN_ASSIGNED_FROM))).id,
      firstDay: (await day(NORDREN_ASSIGNED_FROM)).id,
      lastDay: (await day(dayBefore(FINANCE_YEAR.to))).id,
      afterArea: (await day(FINANCE_YEAR.to)).id,
      noArea: (await day("2026-10-05", { project: "harbor" })).id,
      unheld: (await day("2026-10-05", { project: "cairo" })).id,
    }
  })
  after(async () => {
    if (tenant) await dropTenant(pool, tenant.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  /** The routes of the company the principal's provider serves, oldest first. */
  const served = (principal: Principal): Promise<string[]> =>
    withCompany(pool.db, tenant.companyId, async (tx) =>
      (
        await tx
          .select({ id: route.id })
          .from(route)
          .where(and(eq(route.companyId, tenant.companyId), servesRoute(tx, principal)))
          .orderBy(asc(route.id))
      ).map((row) => row.id),
    )

  /** The assignments the principal reaches. */
  const reached = (principal: Principal): Promise<string[]> =>
    withCompany(pool.db, tenant.companyId, async (tx) =>
      (
        await tx
          .select({ id: serviceAreaAssignment.id })
          .from(serviceAreaAssignment)
          .where(and(eq(serviceAreaAssignment.companyId, tenant.companyId), reachesAssignments(principal)))
          .orderBy(asc(serviceAreaAssignment.id))
      ).map((row) => row.id),
    )

  test("providerIdOf is the Service Provider Access's provider, or null for an office account", () => {
    assert.equal(providerIdOf(principalOf(tenant.serviceProviders.nordren, [])), tenant.serviceProviders.nordren.id)
    assert.equal(providerIdOf(principalOf(null, [tenant.projects.copenhagen])), null)
  })

  test("servesRoute reaches the routes of a scheme in the provider's planning area on a day inside the assignment and the area, and no other", async () => {
    const lars = principalOf(tenant.serviceProviders.nordren, [])
    const ids = await served(lars)
    assert.ok(ids.includes(routes.inside), "a Monday inside the assignment")
    assert.ok(ids.includes(routes.firstDay), "the first day of the assignment, validFrom inclusive")
    assert.ok(ids.includes(routes.lastDay), "the last day of the area, validTo exclusive")
    assert.equal(ids.includes(routes.beforeAssignment), false, "the day before the assignment starts, though the area ran")
    assert.equal(ids.includes(routes.afterArea), false, "the first day after the area ends")
    assert.equal(ids.includes(routes.noArea), false, "a scheme with no planning area is reached by no provider")
    assert.equal(ids.includes(routes.unheld), false, "a planning area nobody holds")
    // Everything the fixtures put in Centrum on a day inside: the three §8 routes and the two boundary days.
    assert.deepEqual(
      [...ids].sort(),
      [execution.routes.ready.id, execution.routes.planned.id, execution.routes.completed.id, routes.firstDay, routes.lastDay].sort(),
    )
  })

  test("another provider's account reaches nothing through NordRen's award, and its own once the ground is assigned to it", async () => {
    const cityhaul = principalOf(tenant.serviceProviders.cityhaul, [])
    assert.deepEqual(await served(cityhaul), [])
    // CityHaul holds Maadi from the start: the Cairo route is its, and still not NordRen's.
    await seedServiceArea(pool, tenant, { projectId: tenant.projects.cairo.id, code: "CA-MAADI", planningAreaIds: [planning.areas.cairo.id], validFrom: "2026-01-01", validTo: null, assignment: { serviceProviderId: tenant.serviceProviders.cityhaul.id } })
    assert.deepEqual(await served(cityhaul), [routes.unheld])
    assert.equal((await served(principalOf(tenant.serviceProviders.nordren, []))).includes(routes.unheld), false)
  })

  test("servesRoute is a SQL false for an office account, whatever projects it works in", async () => {
    assert.deepEqual(await served(principalOf(null, [tenant.projects.copenhagen, tenant.projects.harbor, tenant.projects.cairo])), [])
    assert.deepEqual(await served(principalOf(null, [])), [])
  })

  test("reachesAssignments is the provider's own for an account with a provider, the projects' for an office account, and false for an account with neither", async () => {
    const nordrens = await reached(principalOf(tenant.serviceProviders.nordren, []))
    assert.deepEqual(nordrens, [finance.nordren.assignmentId])
    const cityhauls = await reached(principalOf(tenant.serviceProviders.cityhaul, []))
    assert.equal(cityhauls.length, 1)
    assert.equal(cityhauls.includes(finance.nordren.assignmentId ?? ""), false)
    const copenhagen = await reached(principalOf(null, [tenant.projects.copenhagen]))
    assert.deepEqual(copenhagen, [finance.nordren.assignmentId], "the office reads its project's assignments, whoever holds them")
    const everywhere = await reached(principalOf(null, [tenant.projects.copenhagen, tenant.projects.cairo]))
    assert.deepEqual([...everywhere].sort(), [...nordrens, ...cityhauls].sort())
    assert.deepEqual(await reached(principalOf(null, [])), [], "an account with neither a provider nor a project reaches nothing")
    // An account with a provider is bounded to it whatever projects it holds: never both widened.
    assert.deepEqual(await reached(principalOf(tenant.serviceProviders.nordren, [tenant.projects.cairo])), [finance.nordren.assignmentId])
  })
})
