// What a scheme's generation runs left, on the scheme resource (Issue #177,
// carried from #97 part B): `generation.lastGeneratedAt`, when the latest
// succeeded run finished, and `generation.groups`, each rule group's two
// latest match stamps, read from `generation_run` and `generation_match`
// against Postgres whenever the scheme is read — a list, a read, and the
// answer of a write. The runs and stamps are written here the way the worker
// leaves them (apps/worker/src/jobs/generate-routes.ts), through `tx` as
// `wms_api` inside `withCompany`, since this suite proves the reading and not
// the job; `dropTenant` drops them with the company.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { Page } from "@waste/contracts/pagination"
import { RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database } from "@waste/db/client"
import { generationMatch, generationRun } from "@waste/db/schema/generation"
import { withCompany } from "@waste/db/tenant"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { seedPlanning, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const RouteSchemePage = Page(RouteScheme)

/** Three instants a run finished at, oldest first, and one in between for a run that failed. */
const MONDAY_NIGHT = "2026-09-28T03:00:07.000Z"
const TUESDAY_NIGHT = "2026-09-29T03:00:09.000Z"
const TUESDAY_MORNING = "2026-09-29T08:15:00.000Z"

describe("a scheme's generation reading", { skip: database.skip }, () => {
  let pool: Database
  let a: Tenant
  let b: Tenant
  let planning: PlanningFixtures
  let olivia: Call
  let other: Call
  let residual: WasteFraction
  /** One rule group on Mondays, run four times and stamped three. */
  let scheme: RouteScheme
  /** Never run. */
  let fresh: RouteScheme
  /** Company b's, stamped under b: nothing of it may reach a. */
  let theirs: RouteScheme
  const containers = { first: testId(), second: testId(), third: testId() }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    scheme = await create(olivia, "/route-schemes", schemeBody(a.projects.copenhagen.id, "Residual weekly", residual.id), RouteScheme)
    fresh = await create(olivia, "/route-schemes", schemeBody(a.projects.copenhagen.id, "Never run", residual.id), RouteScheme)
    const theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirs = await create(other, "/route-schemes", schemeBody(b.projects.copenhagen.id, "Theirs", theirFraction.id, null), RouteScheme)

    // The containers a stamp names need not exist: a stamp is history, and no key holds it to the registry.
    const [ruleGroup] = scheme.collectionGroups
    // Monday night's run matched two containers, Tuesday night's three; a run that failed between them and one still queued leave no instant.
    const monday = await run(a, scheme, "succeeded", MONDAY_NIGHT)
    await run(a, scheme, "failed", TUESDAY_MORNING)
    const tuesday = await run(a, scheme, "succeeded", TUESDAY_NIGHT)
    await run(a, scheme, "queued", null)
    // Three stamps, oldest first: the reading carries the two latest.
    const earliest = await run(a, scheme, "succeeded", "2026-09-27T03:00:05.000Z")
    await stamp(a, scheme, ruleGroup.id, earliest, "sig-0", [containers.first])
    await stamp(a, scheme, ruleGroup.id, monday, "sig-1", [containers.first, containers.second])
    await stamp(a, scheme, ruleGroup.id, tuesday, "sig-1", [containers.first, containers.second, containers.third])
    const [theirGroup] = theirs.collectionGroups
    const theirRun = await run(b, theirs, "succeeded", TUESDAY_NIGHT)
    await stamp(b, theirs, theirGroup.id, theirRun, "theirs", [testId()])
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }
  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)

  /** A draft with one rule group on Mondays; a draft is enough, since the reading is the same for every status. */
  function schemeBody(projectId: string, name: string, fraction: string, planningAreaId: string | null = planning.areas.centrum.id) {
    return {
      projectId,
      name,
      planningAreaId,
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays: ["monday"],
      validFrom: "2026-01-01",
      collectionGroups: [{ name: "Residual", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [fraction], containerTypeIds: [], vehicleTypeId: null } }],
    }
  }

  /** A run of the scheme in the status given, finished at the instant given, as the worker leaves it. */
  async function run(tenant: Tenant, of: RouteScheme, status: string, finishedAt: string | null): Promise<string> {
    const id = testId()
    await withCompany(pool.db, tenant.companyId, (tx) =>
      tx.insert(generationRun).values({
        id,
        companyId: tenant.companyId,
        projectId: of.projectId,
        routeSchemeId: of.id,
        trigger: "cron",
        windowFrom: "2026-10-05",
        windowTo: "2026-10-11",
        status,
        startedAt: finishedAt === null ? null : new Date(finishedAt),
        finishedAt: finishedAt === null ? null : new Date(finishedAt),
      }),
    )
    return id
  }

  /** One group's stamp for a run; stamps are written oldest first, so their time-ordered ids order them. */
  async function stamp(tenant: Tenant, of: RouteScheme, groupId: string, runId: string, ruleSignature: string, containerIds: string[]): Promise<void> {
    await withCompany(pool.db, tenant.companyId, (tx) =>
      tx.insert(generationMatch).values({ id: testId(), companyId: tenant.companyId, projectId: of.projectId, collectionGroupId: groupId, generationRunId: runId, ruleSignature, containerIds: [...containerIds].sort() }),
    )
  }

  const read = async (id: string): Promise<RouteScheme> => {
    const response = await olivia(`/route-schemes/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteScheme.parse(await response.json())
  }

  test("a scheme read carries when its latest succeeded run finished, whatever failed or waits after it", async () => {
    assert.equal((await read(scheme.id)).generation.lastGeneratedAt, TUESDAY_NIGHT)
  })

  test("and each rule group's two latest stamps, the latest first, the one before it beside it", async () => {
    const [ruleGroup] = scheme.collectionGroups
    assert.deepEqual((await read(scheme.id)).generation.groups, [
      {
        groupId: ruleGroup.id,
        latest: { ruleSignature: "sig-1", containerIds: [containers.first, containers.second, containers.third].sort() },
        previous: { ruleSignature: "sig-1", containerIds: [containers.first, containers.second].sort() },
      },
    ])
  })

  test("a scheme no run has generated says so: no instant and no stamps", async () => {
    assert.deepEqual((await read(fresh.id)).generation, { lastGeneratedAt: null, groups: [] })
    assert.deepEqual(fresh.generation, { lastGeneratedAt: null, groups: [] }, "the create's answer reads the same")
  })

  test("a list reads it for every scheme of the page, and a write answers it too", async () => {
    const response = await olivia("/route-schemes?limit=200")
    assert.equal(response.status, 200)
    const page = RouteSchemePage.parse(await response.json())
    const listed = new Map(page.items.map((item) => [item.id, item.generation]))
    assert.equal(listed.get(scheme.id)?.lastGeneratedAt, TUESDAY_NIGHT)
    assert.equal(listed.get(scheme.id)?.groups.length, 1)
    assert.deepEqual(listed.get(fresh.id), { lastGeneratedAt: null, groups: [] })
    assert.equal(listed.has(theirs.id), false, "company b's scheme is not a's to list")

    const patched = await olivia(`/route-schemes/${scheme.id}`, { method: "PATCH", body: { plannedStartTime: "07:15" } })
    assert.equal(patched.status, 200, JSON.stringify(await patched.clone().json()))
    assert.equal(RouteScheme.parse(await patched.json()).generation.lastGeneratedAt, TUESDAY_NIGHT)
  })

  test("another company's runs and stamps are its own", async () => {
    const response = await other(`/route-schemes/${theirs.id}`)
    const read = RouteScheme.parse(await response.json())
    assert.equal(read.generation.lastGeneratedAt, TUESDAY_NIGHT)
    assert.deepEqual(read.generation.groups.map((group) => group.latest.ruleSignature), ["theirs"])
  })
})
