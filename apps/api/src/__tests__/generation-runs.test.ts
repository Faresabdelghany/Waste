// The office's door to generation against Postgres (Issue #97 part B, #128):
// `POST /route-schemes/:id/generate` and the two run reads, on the shared
// local database under a tenant of this file's own. What is proved is what
// the office sees and what the worker will find: the run answered at once and
// queued, its job on `planning.generate-routes` keyed by the scheme and
// carrying the run and the company, both written in the request's
// transaction as `wms_api`; a second click while a job of the scheme is in
// flight answering that run and writing nothing; a new run once the job has
// left the queue; a draft's 409 writing nothing; the window's 400s; and the
// fence. The job is read through pg-boss's own `findJobs`, the worker's side
// of the queue; nobody works the queue here, so what was sent stays sent, and
// the file removes its own jobs as the owner in `after`.
//
// The queue is the worker's to create when it starts (apps/worker/src/boss.ts,
// `exclusive` as its job definition says and its registry test pins); a
// database no worker has started against has none, so the suite creates it the
// same way, idempotently, before it sends.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { GenerationRun } from "@waste/contracts/generation"
import { Page } from "@waste/contracts/pagination"
import { WINDOW_AT_MOST_A_YEAR, WINDOW_ORDERED, RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database } from "@waste/db/client"
import { GENERATE_ROUTES_QUEUE } from "@waste/db/commands/generation"
import { generationRun } from "@waste/db/schema/generation"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { eq, inArray, sql } from "drizzle-orm"
import { PgBoss } from "pg-boss"

import { createApp } from "../app"
import { DRAFT_GENERATES_NOTHING } from "../routes/generation-runs"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { seedPlanning, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()
const GenerationRunPage = Page(GenerationRun)

const MODULE = "route-studio.schemes"

/** Monday 5 October 2026 to Sunday 11 October: the week the office asks for. */
const WEEK = { from: "2026-10-05", to: "2026-10-11" }

describe("the generation endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  /** pg-boss on the owner's connection: the worker's side of the queue, to read what the API sent and to take a job off it. */
  let boss: PgBoss
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let planning: PlanningFixtures
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  let other: Call
  /** Company b's custom role, granted `view` on the schemes and nothing more. */
  let reader: Call
  /** Company a's Service Provider Manager: `view` on route-studio by charter, and no project. */
  let lars: Call

  let residual: WasteFraction
  /** Copenhagen Central, validated, on Mondays and Thursdays. */
  let scheme: RouteScheme
  let draft: RouteScheme
  /** Harbor Commercial's, which the viewer does not work in. */
  let harbor: RouteScheme
  /** Company b's. */
  let theirs: RouteScheme
  const schemeIds = (): string[] => [scheme, draft, harbor, theirs].filter((row) => row !== undefined).map((row) => row.id)

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 2 })
    boss = new PgBoss({ connectionString: owner.url, schema: PGBOSS_SCHEMA, migrate: false, supervise: false, schedule: false })
    boss.on("error", (error) => {
      throw error
    })
    await boss.start()
    await boss.createQueue(GENERATE_ROUTES_QUEUE, { policy: "exclusive" })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    await grantRole(pool, b.companyId, b.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    reader = callingAs(app, keys, b.users.viewer, b.companyId)

    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    scheme = await create(olivia, "/route-schemes", schemeBody(a.projects.copenhagen.id, "Residual weekly", { planningAreaId: planning.areas.centrum.id, status: "validated" }), RouteScheme)
    draft = await create(olivia, "/route-schemes", schemeBody(a.projects.copenhagen.id, "Paper draft", { planningAreaId: planning.areas.centrum.id }), RouteScheme)
    harbor = await create(olivia, "/route-schemes", schemeBody(a.projects.harbor.id, "Harbor weekly", { planningAreaId: planning.areas.harbor.id, status: "validated" }), RouteScheme)
    const theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirs = await create(other, "/route-schemes", schemeBody(b.projects.copenhagen.id, "Theirs", {}, theirFraction.id), RouteScheme)
  })
  after(async () => {
    // Jobs first: nobody works this queue here, and a job names a run only in its data.
    if (ownerPool) await ownerPool.db.execute(sql`delete from ${sql.raw(PGBOSS_SCHEMA)}.job where name = ${GENERATE_ROUTES_QUEUE} and singleton_key in ${schemeIds()}`)
    await boss?.stop({ graceful: false, close: true })
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await ownerPool?.close()
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }
  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)

  /** A scheme with one rule group over its two days; validated only where `values` says so. */
  function schemeBody(projectId: string, name: string, values: Record<string, unknown>, fraction = residual.id) {
    return {
      projectId,
      name,
      serviceType: "container-collection",
      frequency: "weekly",
      serviceDays: ["monday", "thursday"],
      validFrom: "2026-01-01",
      collectionGroups: [{ name: "Residual", days: ["monday", "thursday"], stopSource: "rule", rule: { wasteFractionIds: [fraction], containerTypeIds: [], vehicleTypeId: null } }],
      ...values,
    }
  }

  const generate = (call: Call, id: string, body: unknown = WEEK) => call(`/route-schemes/${id}/generate`, { method: "POST", body })
  const answered = async (response: Response, status: number): Promise<GenerationRun> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return GenerationRun.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const runsOf = async (call: Call, id: string, query = "") => {
    const response = await call(`/route-schemes/${id}/generation-runs${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return GenerationRunPage.parse(await response.json())
  }
  /** The jobs of a scheme the worker would find on the queue, in any state. */
  const jobsOf = (schemeId: string) => boss.findJobs<{ generationRunId: string; companyId: string }>(GENERATE_ROUTES_QUEUE, { key: schemeId })
  /** The worker's part, by hand: take the scheme's queued job and finish it, as generate-routes does with the run it names. */
  const finish = async (schemeId: string, run: { routesCreated: number; pickupsWritten: number }) => {
    const [job] = await boss.fetch<{ generationRunId: string }>(GENERATE_ROUTES_QUEUE)
    assert.ok(job, "a job waits on the queue")
    assert.equal((await jobsOf(schemeId)).find((row) => row.id === job.id)?.singletonKey, schemeId, "the job taken is the scheme's")
    await ownerPool.db
      .update(generationRun)
      .set({ status: "succeeded", startedAt: new Date("2026-09-29T08:00:05Z"), finishedAt: new Date("2026-09-29T08:00:07Z"), ...run })
      .where(eq(generationRun.id, job.data.generationRunId))
    await boss.complete(GENERATE_ROUTES_QUEUE, job.id)
  }

  test("a click answers at once, 202, with the run queued and on-demand over the window and nothing generated yet; the worker's job waits on the queue, keyed by the scheme, carrying the run and the company", async () => {
    const run = await answered(await generate(olivia, scheme.id), 202)
    assert.deepEqual(
      { ...run, id: undefined, createdAt: undefined, updatedAt: undefined },
      {
        id: undefined,
        createdAt: undefined,
        updatedAt: undefined,
        projectId: a.projects.copenhagen.id,
        routeSchemeId: scheme.id,
        trigger: "on-demand",
        windowFrom: WEEK.from,
        windowTo: WEEK.to,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        routesCreated: 0,
        routesRefreshed: 0,
        routesCancelled: 0,
        pickupsWritten: 0,
        holidaysSkipped: 0,
        unlocated: 0,
        warnings: [],
        error: null,
      },
    )
    const read = await olivia(`/generation-runs/${run.id}`)
    assert.equal(read.status, 200)
    assert.deepEqual(GenerationRun.parse(await read.json()), run, "the run is committed with the answer, and reads back as it was answered")

    const jobs = await jobsOf(scheme.id)
    assert.deepEqual(
      jobs.map((job) => [job.state, job.data]),
      [["created", { generationRunId: run.id, companyId: a.companyId }]],
      "one job, queued for the worker, naming the run the office holds",
    )
  })

  test("a second click while the job waits starts nothing and answers the run in flight, 200, whatever window it asks for", async () => {
    const [first] = (await runsOf(olivia, scheme.id)).items
    const again = await answered(await generate(olivia, scheme.id, { from: "2026-11-02", to: "2026-11-08" }), 200)
    assert.equal(again.id, first.id)
    assert.deepEqual([again.windowFrom, again.windowTo], [WEEK.from, WEEK.to], "the run in flight is answered as it is, not re-aimed")
    assert.equal((await runsOf(olivia, scheme.id)).items.length, 1, "no second run")
    assert.equal((await jobsOf(scheme.id)).length, 1, "no second job")
  })

  test("once the worker has finished the job, the run reads what it did, and the next click starts a new run", async () => {
    const [first] = (await runsOf(olivia, scheme.id)).items
    await finish(scheme.id, { routesCreated: 2, pickupsWritten: 6 })
    const done = GenerationRun.parse(await (await olivia(`/generation-runs/${first.id}`)).json())
    assert.deepEqual(
      [done.status, done.startedAt, done.finishedAt, done.routesCreated, done.pickupsWritten],
      ["succeeded", "2026-09-29T08:00:05.000Z", "2026-09-29T08:00:07.000Z", 2, 6],
    )

    const second = await answered(await generate(olivia, scheme.id, { from: "2026-10-12", to: "2026-10-18" }), 202)
    assert.notEqual(second.id, first.id)
    assert.deepEqual([second.status, second.windowFrom, second.windowTo], ["queued", "2026-10-12", "2026-10-18"])
    const jobs = await jobsOf(scheme.id)
    assert.deepEqual(jobs.map((job) => job.state).sort(), ["completed", "created"], "the finished job and the new one")
  })

  test("the scheme's runs read newest first, a page at a time, the cursor handing on to the older ones, and by status", async () => {
    const all = await runsOf(olivia, scheme.id)
    assert.deepEqual(all.items.map((run) => run.status), ["queued", "succeeded"], "newest first")
    assert.equal(all.nextCursor, null)
    const firstPage = await runsOf(olivia, scheme.id, "?limit=1")
    assert.deepEqual(firstPage.items.map((run) => run.id), [all.items[0].id])
    assert.ok(firstPage.nextCursor)
    const secondPage = await runsOf(olivia, scheme.id, `?limit=1&cursor=${firstPage.nextCursor}`)
    assert.deepEqual(secondPage.items.map((run) => run.id), [all.items[1].id])
    assert.equal(secondPage.nextCursor, null)
    assert.deepEqual((await runsOf(olivia, scheme.id, "?status=succeeded")).items.map((run) => run.id), [all.items[1].id])
    assert.deepEqual((await runsOf(olivia, scheme.id, "?status=failed")).items, [])
    const bad = await refused(await olivia(`/route-schemes/${scheme.id}/generation-runs?status=requested`), 400)
    assert.deepEqual(bad.errors?.map((error) => error.path), ["status"])
  })

  test("a draft scheme generates nothing: 409 in the issue's words, and no run and no job are written", async () => {
    const problem = await refused(await generate(olivia, draft.id), 409)
    assert.equal(problem.detail, DRAFT_GENERATES_NOTHING)
    assert.deepEqual((await runsOf(olivia, draft.id)).items, [])
    assert.deepEqual(await jobsOf(draft.id), [])
  })

  test("the window is the occurrence read's: 400 at `to` for one that ends before it starts or spans more than 366 days, and a member the server decides is refused by name", async () => {
    const backwards = await refused(await generate(olivia, harbor.id, { from: "2026-10-11", to: "2026-10-05" }), 400)
    assert.deepEqual(backwards.errors, [{ path: "to", message: WINDOW_ORDERED }])
    const long = await refused(await generate(olivia, harbor.id, { from: "2026-01-01", to: "2027-01-02" }), 400)
    assert.deepEqual(long.errors, [{ path: "to", message: WINDOW_AT_MOST_A_YEAR }])
    const owned = await refused(await generate(olivia, harbor.id, { ...WEEK, trigger: "cron" }), 400)
    assert.match(JSON.stringify(owned.errors), /trigger/)
    const missing = await refused(await generate(olivia, harbor.id, { from: WEEK.from }), 400)
    assert.deepEqual(missing.errors?.map((error) => error.path), ["to"])
    assert.deepEqual(await jobsOf(harbor.id), [], "nothing refused reached the queue")
  })

  test("fenced like the scheme: another company's, or a project the caller does not work in, is a scheme that does not exist here — for the click and for both reads", async () => {
    const harborRun = await answered(await generate(olivia, harbor.id), 202)
    assert.equal((await refused(await generate(viewer, harbor.id), 404)).detail, `No route scheme ${harbor.id} in the projects this account works in`)
    assert.equal((await refused(await viewer(`/route-schemes/${harbor.id}/generation-runs`), 404)).detail, `No route scheme ${harbor.id} in the projects this account works in`)
    assert.equal((await refused(await viewer(`/generation-runs/${harborRun.id}`), 404)).detail, `No generation run ${harborRun.id} in the projects this account works in`)
    // An account that works in no project reads nothing of any scheme's.
    await refused(await lars(`/generation-runs/${harborRun.id}`), 404)
    // Company b sees nothing of a's, and its click on a's scheme starts nothing.
    await refused(await generate(other, scheme.id), 404)
    await refused(await other(`/generation-runs/${harborRun.id}`), 404)
    await refused(await other(`/route-schemes/${scheme.id}/generation-runs`), 404)
    assert.equal((await runsOf(olivia, scheme.id)).items.length, 2, "b's click wrote nothing on a's scheme")
    // The viewer works in Copenhagen Central and reads its runs.
    assert.equal((await runsOf(viewer, scheme.id)).items.length, 2)
  })

  test("`view` reads the runs and `edit` is needed to start one", async () => {
    const forbidden = await refused(await generate(reader, theirs.id), 403)
    assert.equal(forbidden.detail, `This account's role does not allow edit on ${MODULE}`)
    assert.deepEqual((await runsOf(reader, theirs.id)).items, [])
    assert.deepEqual(await jobsOf(theirs.id), [])
  })

  test("the runs are the company's: as wms_api under another company's fence, none of a's is there", async () => {
    const ours = (await ownerPool.db.select({ id: generationRun.id }).from(generationRun).where(inArray(generationRun.routeSchemeId, [scheme.id, harbor.id]))).length
    assert.equal(ours, 3, "two of Copenhagen's, one of Harbor's")
    const seen = await pool.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('wms.company_id', ${b.companyId}, true)`)
      return (await tx.select({ id: generationRun.id }).from(generationRun)).length
    })
    assert.equal(seen, 0)
  })
})
