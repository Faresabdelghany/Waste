import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { PlanningArea } from "@waste/contracts/planning-areas"
import { PROVIDER_NEEDS_A_DAY, ServiceArea, ServiceAreaAssignment, ServiceAreaCreated, ServiceAreaDetail } from "@waste/contracts/service-areas"
import { ServiceProviderPrice } from "@waste/contracts/service-provider-prices"
import { ENDS_AFTER_IT_STARTS } from "@waste/contracts/validity"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { serviceArea, serviceAreaPlanningArea } from "@waste/db/schema/finance"
import { planningArea } from "@waste/db/schema/planning-areas"
import { withCompany } from "@waste/db/tenant"
import { sql } from "drizzle-orm"
import * as z from "zod"

import { createApp } from "../app"
import { lockRow } from "../routes/shared"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { seedProducts, type ProductFixtures } from "./finance-fixtures"
import { readProblem } from "./read-problem"
import { seedPlanning, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const ServiceAreaPage = Page(ServiceArea)
const AssignmentPage = Page(ServiceAreaAssignment)
const Assignments = z.array(ServiceAreaAssignment)

const MODULE = "service-providers.service-areas"

/** The days the periods of this file are cut from; every test says which of them it means. */
const JANUARY = "2026-01-01"
const MARCH = "2026-03-01"
const JULY = "2026-07-01"
const AUGUST = "2026-08-20"
const NEXT_YEAR = "2027-01-01"
const YEAR_AFTER = "2028-01-01"

/** The sentences this family answers with, pinned here so a change to one is a change to this file too. */
const AREA_RUNNING = "A service area of this code is already in force over part of that period"
const ASSIGNMENT_RUNNING = "This service area is already assigned over part of that period; end the assignment first"
const OUTSIDE_AREA = "Outside the service area's period"
const awardedElsewhere = (planningAreaCode: string, serviceAreaCode: string) => `Planning area ${planningAreaCode} is already in service area ${serviceAreaCode} over part of that period`

/** The order a set reads back in: by the id an entry names, which it names once. */
const inReadOrder = (ids: readonly string[]): string[] => [...ids].sort()

describe("the service area and assignment endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let planning: PlanningFixtures
  let products: ProductFixtures
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager at NordRen: `view` and `edit` on the workspace by charter, no project, so it reads its own and writes nothing. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** Copenhagen Central's planning areas beside Planning's `OP-CEN-01`: five more, so awards can cover different ground — `north` is claimed by no award of 2026, `west` and `south` by the one-award tests, `east` and `bridge` by the first area made. */
  let north: PlanningArea
  let west: PlanningArea
  let south: PlanningArea
  let east: PlanningArea
  let bridge: PlanningArea
  let residual: WasteFraction
  let glass: WasteFraction
  /** The other company's rows, for the 400s and 404s. */
  let theirFraction: WasteFraction
  let theirArea: ServiceAreaCreated

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    planning = await seedPlanning(pool, a)
    products = await seedProducts(pool, a)
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    const area = (code: string, name: string) => create(olivia, "/planning-areas", { projectId: a.projects.copenhagen.id, code, name, purpose: "route-planning" }, PlanningArea)
    north = await area("OP-CEN-02", "Centrum Nord")
    west = await area("OP-CEN-03", "Centrum Vest")
    south = await area("OP-CEN-04", "Centrum Syd")
    east = await area("OP-CEN-05", "Centrum Øst")
    bridge = await area("OP-CEN-06", "Broerne")
    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    glass = await create(olivia, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
    theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirArea = await post(other, { projectId: b.projects.copenhagen.id, code: "CA-THEIRS", name: "Theirs", boundaryText: "Their contract", validFrom: JANUARY, assignment: { serviceProviderId: b.serviceProviders.nordren.id } })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** An area body a caller may send: Copenhagen Central, the year 2026, no planning areas, no fractions, no assignment. */
  const body = (code: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    code,
    name: `Area ${code}`,
    boundaryText: `The boundary of ${code} as the contract spells it`,
    validFrom: JANUARY,
    validTo: NEXT_YEAR,
    ...values,
  })

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  /** An area's create: the 201 body is `ServiceAreaCreated`, the area with its first assignment, and its address answers the detail, which parses as the area alone. */
  const post = async (call: Call, values: unknown): Promise<ServiceAreaCreated> => {
    const response = await call("/service-areas", { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const made = ServiceAreaCreated.parse(await response.clone().json())
    await created(call, "/service-areas", response, ServiceArea)
    return made
  }
  const area = (code: string, values: Record<string, unknown> = {}) => post(olivia, body(code, values))
  /** An assignment posted under its area, read at `/service-area-assignments/{id}`. */
  const assign = async (call: Call, areaId: string, values: Record<string, unknown>): Promise<ServiceAreaAssignment> =>
    created(call, `/service-areas/${areaId}/assignments`, await call(`/service-areas/${areaId}/assignments`, { method: "POST", body: values }), ServiceAreaAssignment, "/service-area-assignments")
  const detail = async (call: Call, id: string): Promise<ServiceAreaDetail> => {
    const response = await call(`/service-areas/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ServiceAreaDetail.parse(await response.json())
  }
  const oneAssignment = async (call: Call, id: string): Promise<ServiceAreaAssignment> => {
    const response = await call(`/service-area-assignments/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ServiceAreaAssignment.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<ServiceArea> => {
    const response = await call(`/service-areas/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ServiceArea.parse(await response.json())
  }
  const patchAssignment = async (call: Call, id: string, values: unknown): Promise<ServiceAreaAssignment> => {
    const response = await call(`/service-area-assignments/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ServiceAreaAssignment.parse(await response.json())
  }
  const put = async (call: Call, id: string, set: "planning-areas" | "waste-fractions", ids: unknown): Promise<ServiceArea> => {
    const response = await call(`/service-areas/${id}/${set}`, { method: "PUT", body: { ids } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ServiceArea.parse(await response.json())
  }
  const page = async (call: Call, query = "") => {
    const response = await call(`/service-areas${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ServiceAreaPage.parse(await response.json())
  }
  const assignments = async (call: Call, query = "") => {
    const response = await call(`/service-area-assignments${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return AssignmentPage.parse(await response.json())
  }
  const assignmentsOf = async (call: Call, areaId: string) => {
    const response = await call(`/service-areas/${areaId}/assignments`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Assignments.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)
  const messages = (problem: { errors?: { message: string }[] }) => problem.errors?.map((error) => error.message)

  describe("POST /service-areas", () => {
    test("makes the award with its two sets and no assignment, mints the id, answers the sets in read order, and the detail agrees", async () => {
      const made = await area("CA-Ø-1", { planningAreaIds: [east.id, bridge.id], wasteFractionIds: [glass.id, residual.id], notes: "Municipal facilities excluded" })
      assert.equal(Id.parse(made.id), made.id, "a version 7 id the server minted")
      assert.deepEqual([made.projectId, made.code, made.name, made.notes], [a.projects.copenhagen.id, "CA-Ø-1", "Area CA-Ø-1", "Municipal facilities excluded"])
      assert.deepEqual(made.planningAreaIds, inReadOrder([east.id, bridge.id]))
      assert.deepEqual(made.wasteFractionIds, inReadOrder([glass.id, residual.id]))
      assert.equal(made.assignment, null, "no assignment when the body made none")
      const read = await detail(olivia, made.id)
      const { assignment: _assignment, ...areaAlone } = made
      assert.deepEqual(read, { ...areaAlone, assignments: [] })
      const bare = await area("CA-BARE")
      assert.deepEqual([bare.planningAreaIds, bare.wasteFractionIds], [[], []], "none when absent")
    })

    test("writes the first assignment in the same transaction, its period the area's when absent, and answers it beside the area", async () => {
      const made = await area("CA-Ø-2", { planningAreaIds: [planning.areas.centrum.id], assignment: { serviceProviderId: a.serviceProviders.nordren.id } })
      assert.ok(made.assignment)
      assert.deepEqual([made.assignment.serviceAreaId, made.assignment.projectId, made.assignment.serviceProviderId], [made.id, made.projectId, a.serviceProviders.nordren.id])
      assert.deepEqual([made.assignment.validFrom, made.assignment.validTo], [JANUARY, NEXT_YEAR], "the area's period when the body gave none")
      assert.deepEqual(await oneAssignment(olivia, made.assignment.id), made.assignment)
      assert.deepEqual((await detail(olivia, made.id)).assignments, [made.assignment])
      const later = await area("CA-LATER", { assignment: { serviceProviderId: a.serviceProviders.cityhaul.id, validFrom: MARCH, validTo: JULY } })
      assert.deepEqual([later.assignment?.validFrom, later.assignment?.validTo], [MARCH, JULY])
    })

    test("refuses a first assignment naming a provider of another company, or a period outside the area's, at the assignment's paths, and writes neither the area nor the assignment", async () => {
      const foreign = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-FOREIGN", { assignment: { serviceProviderId: b.serviceProviders.nordren.id } }) }), 400)
      assert.deepEqual([paths(foreign), messages(foreign)], [["assignment.serviceProviderId"], ["Not a service provider of this company"]])
      const outside = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-OUTSIDE", { assignment: { serviceProviderId: a.serviceProviders.nordren.id, validFrom: "2025-12-01", validTo: null } }) }), 400)
      assert.deepEqual([paths(outside), messages(outside)], [["assignment.validFrom", "assignment.validTo"], [OUTSIDE_AREA, OUTSIDE_AREA]])
      const backwards = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-BACK", { assignment: { serviceProviderId: a.serviceProviders.nordren.id, validFrom: JULY, validTo: MARCH } }) }), 400)
      assert.deepEqual(paths(backwards), ["assignment.validTo"])
      const codes = (await page(olivia, "?limit=200")).items.map((item) => item.code)
      assert.equal(codes.some((code) => ["CA-FOREIGN", "CA-OUTSIDE", "CA-BACK"].includes(code)), false, "a refused assignment took the area with it")
    })

    test("refuses a planning area of another project and a fraction of another company at the indexed path, the same twice, a project the caller does not work in, and a member the server owns", async () => {
      const foreignArea = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-PA", { planningAreaIds: [north.id, planning.areas.harbor.id] }) }), 400)
      assert.deepEqual([paths(foreignArea), messages(foreignArea)], [["planningAreaIds.1"], ["Not a planning area of this project"]])
      const foreignFraction = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-WF", { wasteFractionIds: [theirFraction.id] }) }), 400)
      assert.deepEqual([paths(foreignFraction), messages(foreignFraction)], [["wasteFractionIds.0"], ["Not a waste fraction of this company"]])
      const twice = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-TWICE", { planningAreaIds: [north.id, north.id] }) }), 400)
      assert.deepEqual(paths(twice), ["planningAreaIds"])
      const harbor = await refused(await viewer("/service-areas", { method: "POST", body: body("CA-H", { projectId: a.projects.harbor.id }) }), 400)
      assert.deepEqual(paths(harbor), ["projectId"])
      const owned = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-OWNED", { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a code already in force over the period with its sentence, and takes it back to back", async () => {
      await area("CA-CODE")
      const overlapping = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-CODE", { validFrom: JULY, validTo: null }) }), 409)
      assert.equal(overlapping.detail, AREA_RUNNING)
      const relet = await area("CA-CODE", { validFrom: NEXT_YEAR, validTo: null })
      assert.equal(relet.validFrom, NEXT_YEAR, "an award re-let is a new row of the code")
    })

    test("the one-award rule: a planning area in another area over an overlapping period is refused at the entry in either order, and taken once the periods do not overlap", async () => {
      await area("CA-W-1", { planningAreaIds: [west.id] })
      const second = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-W-2", { planningAreaIds: [north.id, west.id], validFrom: JULY, validTo: null }) }), 409)
      assert.equal(second.detail, awardedElsewhere("OP-CEN-03", "CA-W-1"))
      assert.deepEqual([paths(second), messages(second)], [["planningAreaIds.1"], [awardedElsewhere("OP-CEN-03", "CA-W-1")]])
      const next = await area("CA-W-3", { planningAreaIds: [west.id], validFrom: NEXT_YEAR, validTo: null })
      assert.deepEqual(next.planningAreaIds, [west.id], "the next award of the ground begins where the earlier ends")
      // The other order: a later award first, then an earlier one that would reach into it.
      await area("CA-S-2", { planningAreaIds: [south.id], validFrom: NEXT_YEAR, validTo: YEAR_AFTER })
      await area("CA-S-1", { planningAreaIds: [south.id], validFrom: JANUARY, validTo: NEXT_YEAR })
      const reaching = await refused(await olivia("/service-areas", { method: "POST", body: body("CA-S-3", { planningAreaIds: [south.id], validFrom: JULY, validTo: YEAR_AFTER }) }), 409)
      // Two areas are in the way; the one found first in id order names the sentence.
      assert.equal(reaching.detail, awardedElsewhere("OP-CEN-04", "CA-S-2"))
      assert.deepEqual(paths(reaching), ["planningAreaIds.0"])
      assert.equal((await page(olivia, "?limit=200")).items.some((item) => item.code === "CA-S-3"), false)
    })

    test("serialises two awards of one planning area on its row lock: a create sent while another award of the ground is in flight waits for it, and is then refused naming the award that won", async () => {
      // The winner is hand-driven — the planning area locked as the create locks it, the award and its membership written the way the create writes them, the transaction held open — so a create that took no lock on the ground would read no membership (READ COMMITTED: an uncommitted row is invisible), pass the one-award rule, and leave two live awards over one planning area, paid twice. With the lock the create waits: the winner commits only once Postgres reports the create blocked behind it (`pg_blocking_pids`, the driver suite's precedent), and the create then finds the membership the winner wrote.
      const ground = await create(olivia, "/planning-areas", { projectId: a.projects.copenhagen.id, code: "OP-CEN-07", name: "Nørrebro", purpose: "route-planning" }, PlanningArea)
      const winnersArea = testId()
      const released = Promise.withResolvers<void>()
      const held = Promise.withResolvers<number>()
      const winner = withCompany(pool.db, a.companyId, async (tx: Tx) => {
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        await lockRow(tx, planningArea, { companyId: a.companyId, id: ground.id })
        await tx.insert(serviceArea).values({ id: winnersArea, companyId: a.companyId, projectId: a.projects.copenhagen.id, code: "CA-N-1", name: "Nørrebro 1", boundaryText: "The contract's boundary for CA-N-1", validFrom: JANUARY, validTo: NEXT_YEAR })
        await tx.insert(serviceAreaPlanningArea).values({ id: testId(), companyId: a.companyId, projectId: a.projects.copenhagen.id, serviceAreaId: winnersArea, planningAreaId: ground.id })
        held.resolve(pid)
        await released.promise
      })
      /** Rejects if the winner ends before it is released — an insert refused, say — so a broken winner fails the test instead of hanging it on the pid. */
      const endedEarly = winner.then(() => Promise.reject(new Error("the winner's transaction ended before it was released")))
      void endedEarly.catch(() => undefined)
      // The create is sent once the winner holds the ground, so what it meets is the lock and not the timing.
      let losing: Promise<Response> | undefined
      try {
        const pid = await Promise.race([held.promise, endedEarly])
        losing = olivia("/service-areas", { method: "POST", body: body("CA-N-2", { planningAreaIds: [ground.id], validFrom: JULY, validTo: null }) })
        // Postgres names the backends a process blocks: the create is waiting on the winner's transaction once this answers a row, and not before.
        const blocked = async (): Promise<boolean> => (await pool.sql`select pid from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`).length > 0
        const deadline = Date.now() + 10_000
        while (!(await blocked())) {
          assert.ok(Date.now() < deadline, "the create never waited on the planning area: the one-award rule took no lock on the ground")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } finally {
        released.resolve()
        await winner
        await losing?.catch(() => undefined)
      }
      assert.ok(losing, "the create was sent")
      const lost = await refused(await losing, 409)
      assert.deepEqual([lost.detail, paths(lost)], [awardedElsewhere("OP-CEN-07", "CA-N-1"), ["planningAreaIds.0"]], "the rule's sentence, naming the award that won")
      assert.deepEqual((await page(olivia, `?planningAreaId=${ground.id}&limit=200`)).items.map((item) => item.code), ["CA-N-1"], "one live award over the ground, the winner's")
    })

    test("two creates naming one planning area at once: one is made and the other refused naming it, whichever the timing gives", async () => {
      const ground = await create(olivia, "/planning-areas", { projectId: a.projects.copenhagen.id, code: "OP-CEN-08", name: "Vesterbro", purpose: "route-planning" }, PlanningArea)
      const [left, right] = await Promise.all([
        olivia("/service-areas", { method: "POST", body: body("CA-V-1", { planningAreaIds: [ground.id] }) }),
        olivia("/service-areas", { method: "POST", body: body("CA-V-2", { planningAreaIds: [ground.id] }) }),
      ])
      assert.deepEqual([left.status, right.status].sort(), [201, 409], `${JSON.stringify(await left.clone().json())} / ${JSON.stringify(await right.clone().json())}`)
      const won = left.status === 201 ? "CA-V-1" : "CA-V-2"
      const lost = await readProblem(left.status === 409 ? left : right)
      assert.deepEqual([lost.detail, paths(lost)], [awardedElsewhere("OP-CEN-08", won), ["planningAreaIds.0"]])
      assert.deepEqual((await page(olivia, `?planningAreaId=${ground.id}&limit=200`)).items.map((item) => item.code), [won], "the ground is awarded once")
    })

    test("refuses a role without create, and a provider's account, which works in no project", async () => {
      await refused(await ungranted("/service-areas", { method: "POST", body: body("CA-U") }), 403)
      const lars_ = await refused(await lars("/service-areas", { method: "POST", body: body("CA-LARS") }), 403)
      assert.match(lars_.detail ?? "", /create/, "the manager's charter grants view and edit on the workspace, never create")
    })
  })

  describe("GET /service-areas", () => {
    test("answers the company's areas in id order with their sets, filters by project, day, planning area and provider on a day, and demands the day with the provider", async () => {
      const all = await page(olivia, "?limit=200")
      const ids = all.items.map((item) => item.id)
      assert.deepEqual(ids, [...ids].sort(), "oldest first")
      assert.equal(all.items.some((item) => item.id === theirArea.id), false)
      const withWest = await page(olivia, `?planningAreaId=${west.id}&limit=200`)
      assert.deepEqual(withWest.items.map((item) => item.code).sort(), ["CA-W-1", "CA-W-3"])
      assert.ok(withWest.items.every((item) => item.planningAreaIds.includes(west.id)))
      const inAugust = await page(olivia, `?validOn=${AUGUST}&planningAreaId=${west.id}&limit=200`)
      assert.deepEqual(inAugust.items.map((item) => item.code), ["CA-W-1"])
      const withEast = await page(olivia, `?planningAreaId=${east.id}&limit=200`)
      assert.deepEqual(withEast.items.map((item) => item.code), ["CA-Ø-1"])
      const nordrens = await page(olivia, `?serviceProviderId=${a.serviceProviders.nordren.id}&validOn=${AUGUST}&limit=200`)
      assert.deepEqual(nordrens.items.map((item) => item.code), ["CA-Ø-2"])
      const noDay = await refused(await olivia(`/service-areas?serviceProviderId=${a.serviceProviders.nordren.id}`), 400)
      assert.deepEqual([paths(noDay), messages(noDay)], [["validOn"], [PROVIDER_NEEDS_A_DAY]])
      const cairo = await refused(await viewer(`/service-areas?projectId=${a.projects.cairo.id}`), 400)
      assert.deepEqual(paths(cairo), ["projectId"])
    })

    test("shows an office account only its projects, and a provider's account exactly the areas its own assignments name", async () => {
      const seen = await page(viewer, "?limit=200")
      assert.ok(seen.items.length > 0)
      assert.ok(seen.items.every((item) => item.projectId === a.projects.copenhagen.id))
      const his = await page(lars, "?limit=200")
      assert.deepEqual(his.items.map((item) => item.code), ["CA-Ø-2"], "Lars, at NordRen, reads the one area NordRen holds")
      const cityhauls = await page(lars, `?serviceProviderId=${a.serviceProviders.cityhaul.id}&validOn=${AUGUST}`)
      assert.deepEqual(cityhauls.items, [], "and none of CityHaul's, whatever he asks for")
      await refused(await ungranted("/service-areas"), 403)
      assert.equal((await app.request("/service-areas")).status, 401)
    })
  })

  describe("GET /service-areas/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, for an id nobody minted, and, for a provider's account, an area another provider holds", async () => {
      const cityhaul = (await page(olivia, "?limit=200")).items.find((item) => item.code === "CA-LATER")
      assert.ok(cityhaul)
      await refused(await olivia(`/service-areas/${theirArea.id}`), 404)
      await refused(await viewer(`/service-areas/${(await area("CA-CAI", { projectId: a.projects.cairo.id })).id}`), 404)
      await refused(await olivia(`/service-areas/${testId()}`), 404)
      await refused(await lars(`/service-areas/${cityhaul.id}`), 404)
      const nordren = (await page(lars)).items[0]
      assert.equal((await detail(lars, nordren.id)).assignments.length, 1, "Lars reads NordRen's area with NordRen's assignment")
      await refused(await olivia("/service-areas/not-an-id"), 400)
    })
  })

  describe("PATCH /service-areas/:id", () => {
    test("changes the name, the boundary text and the notes, moving the stamp; the code and the project are not fields of the patch", async () => {
      const made = await area("CA-PATCH")
      await nextMillisecond()
      const changed = await patch(olivia, made.id, { name: "Renamed", boundaryText: "Redrawn in words", notes: "Now with notes" })
      assert.deepEqual([changed.name, changed.boundaryText, changed.notes], ["Renamed", "Redrawn in words", "Now with notes"])
      assert.ok(changed.updatedAt > made.updatedAt)
      for (const field of ["code", "projectId", "planningAreaIds"]) {
        const owned = await refused(await olivia(`/service-areas/${made.id}`, { method: "PATCH", body: { [field]: "x" } }), 400)
        assert.ok(owned.errors?.some((error) => error.message.includes(field)), `${field}: ${JSON.stringify(owned.errors)}`)
      }
    })

    test("refuses a shortening under its assignments counting them, and takes it once they end", async () => {
      const made = await area("CA-SHORT", { assignment: { serviceProviderId: a.serviceProviders.nordren.id } })
      assert.ok(made.assignment)
      const one = await refused(await olivia(`/service-areas/${made.id}`, { method: "PATCH", body: { validTo: JULY } }), 409)
      assert.equal(one.detail, "1 assignment falls outside the new period; end it first")
      await patchAssignment(olivia, made.assignment.id, { validTo: MARCH })
      await assign(olivia, made.id, { serviceProviderId: a.serviceProviders.cityhaul.id, validFrom: MARCH, validTo: NEXT_YEAR })
      const two = await refused(await olivia(`/service-areas/${made.id}`, { method: "PATCH", body: { validTo: "2026-02-01" } }), 409)
      assert.equal(two.detail, "2 assignments fall outside the new period; end them first")
      const shortened = await patch(olivia, made.id, { validTo: NEXT_YEAR })
      assert.equal(shortened.validTo, NEXT_YEAR, "an end the assignments fit inside is taken")
    })

    test("re-runs the one-award rule when the period widens, and not when it shrinks", async () => {
      const spring = await area("CA-SPRING", { planningAreaIds: [south.id], validFrom: YEAR_AFTER, validTo: "2028-07-01" })
      const autumn = await area("CA-AUTUMN", { planningAreaIds: [south.id], validFrom: "2028-07-01", validTo: "2029-01-01" })
      const widened = await refused(await olivia(`/service-areas/${spring.id}`, { method: "PATCH", body: { validTo: "2028-09-01" } }), 409)
      assert.equal(widened.detail, awardedElsewhere("OP-CEN-04", "CA-AUTUMN"))
      assert.deepEqual(paths(widened), ["planningAreaIds.0"])
      assert.equal((await patch(olivia, spring.id, { validTo: "2028-06-01" })).validTo, "2028-06-01", "a shortening claims no new day")
      assert.equal((await patch(olivia, autumn.id, { validFrom: "2028-06-01" })).validFrom, "2028-06-01", "and the neighbour may then reach into the days given up")
    })

    test("refuses an end before the stored start in the contracts' words, a widening onto another area of the code, an empty patch, another company's area, a provider's account, and a role without the grant", async () => {
      const made = await area("CA-MOVE", { validFrom: MARCH, validTo: JULY })
      const backwards = await refused(await olivia(`/service-areas/${made.id}`, { method: "PATCH", body: { validTo: JANUARY } }), 400)
      assert.deepEqual([paths(backwards), messages(backwards)], [["validTo"], [ENDS_AFTER_IT_STARTS]])
      await area("CA-MOVE", { validFrom: JULY, validTo: null })
      const overlapping = await refused(await olivia(`/service-areas/${made.id}`, { method: "PATCH", body: { validTo: AUGUST } }), 409)
      assert.equal(overlapping.detail, AREA_RUNNING)
      await refused(await olivia(`/service-areas/${made.id}`, { method: "PATCH", body: {} }), 400)
      await refused(await olivia(`/service-areas/${theirArea.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      const nordren = (await page(lars)).items[0]
      await refused(await lars(`/service-areas/${nordren.id}`, { method: "PATCH", body: { name: "Lars's" } }), 404)
      await refused(await ungranted(`/service-areas/${theirArea.id}`, { method: "PATCH", body: { name: "x" } }), 403)
    })
  })

  describe("PUT /service-areas/:id/planning-areas and /waste-fractions", () => {
    test("replaces each set whole, moves the stamp, answers the ids in read order, and leaves the other set alone", async () => {
      // An award from 2029, when no other award of this file claims any ground.
      const made = await area("CA-SETS", { planningAreaIds: [north.id], wasteFractionIds: [residual.id], validFrom: "2029-01-01", validTo: null })
      await nextMillisecond()
      const areas = await put(olivia, made.id, "planning-areas", [east.id, north.id])
      assert.deepEqual(areas.planningAreaIds, inReadOrder([east.id, north.id]))
      assert.deepEqual(areas.wasteFractionIds, [residual.id])
      assert.ok(areas.updatedAt > made.updatedAt)
      const fractions = await put(olivia, made.id, "waste-fractions", [glass.id, residual.id])
      assert.deepEqual(fractions.wasteFractionIds, inReadOrder([glass.id, residual.id]))
      assert.deepEqual(fractions.planningAreaIds, inReadOrder([east.id, north.id]))
      const emptied = await put(olivia, made.id, "planning-areas", [])
      assert.deepEqual(emptied.planningAreaIds, [], "an empty list is an award that reaches no route")
      const { assignments: _assignments, ...read } = await detail(olivia, made.id)
      assert.deepEqual(read, emptied)
    })

    test("refuses a planning area of another project and a fraction of another company at ids.N, the same twice, and a planning area another area holds over the period at ids.N", async () => {
      const made = await area("CA-SETS-2", { validFrom: JULY, validTo: NEXT_YEAR })
      const foreign = await refused(await olivia(`/service-areas/${made.id}/planning-areas`, { method: "PUT", body: { ids: [north.id, planning.areas.harbor.id] } }), 400)
      assert.deepEqual([paths(foreign), messages(foreign)], [["ids.1"], ["Not a planning area of this project"]])
      const twice = await refused(await olivia(`/service-areas/${made.id}/planning-areas`, { method: "PUT", body: { ids: [north.id, north.id] } }), 400)
      assert.deepEqual(paths(twice), ["ids"])
      // `west` is CA-W-1's through 2026, and this area runs from July.
      const taken = await refused(await olivia(`/service-areas/${made.id}/planning-areas`, { method: "PUT", body: { ids: [north.id, west.id] } }), 409)
      assert.deepEqual([taken.detail, paths(taken)], [awardedElsewhere("OP-CEN-03", "CA-W-1"), ["ids.1"]])
      assert.deepEqual((await detail(olivia, made.id)).planningAreaIds, [], "a refused set leaves the area as it was")
      const fraction = await refused(await olivia(`/service-areas/${made.id}/waste-fractions`, { method: "PUT", body: { ids: [theirFraction.id] } }), 400)
      assert.deepEqual([paths(fraction), messages(fraction)], [["ids.0"], ["Not a waste fraction of this company"]])
      await refused(await olivia(`/service-areas/${theirArea.id}/planning-areas`, { method: "PUT", body: { ids: [] } }), 404)
      const nordren = (await page(lars)).items[0]
      await refused(await lars(`/service-areas/${nordren.id}/waste-fractions`, { method: "PUT", body: { ids: [] } }), 404)
    })
  })

  describe("POST /service-areas/:id/assignments", () => {
    test("adds an assignment, refuses a provider of another company and a period outside the area's, and refuses an overlapping one with its sentence: a transfer is the old one ended and the new one from that day", async () => {
      const made = await area("CA-TRANSFER", { validTo: null })
      const nordren = await assign(olivia, made.id, { serviceProviderId: a.serviceProviders.nordren.id, validFrom: JANUARY, notes: "The first award" })
      assert.deepEqual([nordren.serviceAreaId, nordren.projectId, nordren.notes, nordren.validTo], [made.id, made.projectId, "The first award", null])
      const foreign = await refused(await olivia(`/service-areas/${made.id}/assignments`, { method: "POST", body: { serviceProviderId: b.serviceProviders.cityhaul.id, validFrom: JULY } }), 400)
      assert.deepEqual([paths(foreign), messages(foreign)], [["serviceProviderId"], ["Not a service provider of this company"]])
      const early = await refused(await olivia(`/service-areas/${made.id}/assignments`, { method: "POST", body: { serviceProviderId: a.serviceProviders.cityhaul.id, validFrom: "2025-06-01", validTo: JANUARY } }), 400)
      assert.deepEqual([paths(early), messages(early)], [["validFrom"], [OUTSIDE_AREA]])
      const overlapping = await refused(await olivia(`/service-areas/${made.id}/assignments`, { method: "POST", body: { serviceProviderId: a.serviceProviders.cityhaul.id, validFrom: JULY } }), 409)
      assert.equal(overlapping.detail, ASSIGNMENT_RUNNING)
      await patchAssignment(olivia, nordren.id, { validTo: JULY })
      const cityhaul = await assign(olivia, made.id, { serviceProviderId: a.serviceProviders.cityhaul.id, validFrom: JULY })
      const history = await assignmentsOf(olivia, made.id)
      assert.deepEqual(history.map((item) => [item.serviceProviderId, item.validFrom, item.validTo]), [
        [a.serviceProviders.nordren.id, JANUARY, JULY],
        [a.serviceProviders.cityhaul.id, JULY, null],
      ])
      assert.deepEqual((await detail(olivia, made.id)).assignments, history, "the detail's list is this read")
      assert.deepEqual(await assignmentsOf(lars, made.id), [history[0]], "Lars reads NordRen's part of the history and not CityHaul's")
      void cityhaul
    })

    test("answers 404 for an area outside the caller's reach and 403 for a role without create", async () => {
      await refused(await olivia(`/service-areas/${theirArea.id}/assignments`, { method: "POST", body: { serviceProviderId: a.serviceProviders.nordren.id, validFrom: JANUARY } }), 404)
      const nordren = (await page(lars)).items[0]
      await refused(await lars(`/service-areas/${nordren.id}/assignments`, { method: "POST", body: { serviceProviderId: a.serviceProviders.nordren.id, validFrom: JANUARY } }), 403)
      await refused(await ungranted(`/service-areas/${theirArea.id}/assignments`, { method: "POST", body: { serviceProviderId: b.serviceProviders.nordren.id, validFrom: JANUARY } }), 403)
    })
  })

  describe("GET /service-area-assignments", () => {
    test("answers the assignments of the caller's projects in id order, by project, area, provider and day, and a provider's account exactly its own", async () => {
      const all = await assignments(olivia, "?limit=200")
      const ids = all.items.map((item) => item.id)
      assert.deepEqual(ids, [...ids].sort(), "oldest first")
      assert.equal(all.items.some((item) => item.id === theirArea.assignment?.id), false)
      assert.ok(all.items.every((item) => item.serviceProviderId === a.serviceProviders.nordren.id || item.serviceProviderId === a.serviceProviders.cityhaul.id))
      const transfer = (await page(olivia, "?limit=200")).items.find((item) => item.code === "CA-TRANSFER")
      assert.ok(transfer)
      const ofArea = await assignments(olivia, `?serviceAreaId=${transfer.id}`)
      assert.equal(ofArea.items.length, 2)
      const inAugust = await assignments(olivia, `?serviceAreaId=${transfer.id}&validOn=${AUGUST}`)
      assert.deepEqual(inAugust.items.map((item) => item.serviceProviderId), [a.serviceProviders.cityhaul.id])
      const cityhauls = await assignments(olivia, `?serviceProviderId=${a.serviceProviders.cityhaul.id}&limit=200`)
      assert.ok(cityhauls.items.length >= 2)
      assert.ok(cityhauls.items.every((item) => item.serviceProviderId === a.serviceProviders.cityhaul.id))
      const his = await assignments(lars, "?limit=200")
      assert.ok(his.items.length >= 3)
      assert.ok(his.items.every((item) => item.serviceProviderId === a.serviceProviders.nordren.id), "Lars reads NordRen's assignments and no other's")
      assert.deepEqual((await assignments(lars, `?serviceProviderId=${a.serviceProviders.cityhaul.id}`)).items, [])
      assert.deepEqual((await assignments(viewer, "?limit=200")).items.every((item) => item.projectId === a.projects.copenhagen.id), true)
      const cairo = await refused(await viewer(`/service-area-assignments?projectId=${a.projects.cairo.id}`), 400)
      assert.deepEqual(paths(cairo), ["projectId"])
      await refused(await ungranted("/service-area-assignments"), 403)
    })
  })

  describe("GET and PATCH /service-area-assignments/:id", () => {
    test("changes the notes and the end, moving the stamp; the provider, the area and the start are not fields of the patch; a provider's account reads its own and 404s on another's", async () => {
      const made = await area("CA-A-PATCH", { validTo: null, assignment: { serviceProviderId: a.serviceProviders.nordren.id } })
      assert.ok(made.assignment)
      await nextMillisecond()
      const changed = await patchAssignment(olivia, made.assignment.id, { notes: "Extended by letter", validTo: NEXT_YEAR })
      assert.deepEqual([changed.notes, changed.validTo], ["Extended by letter", NEXT_YEAR])
      assert.ok(changed.updatedAt > made.assignment.updatedAt)
      for (const field of ["serviceProviderId", "serviceAreaId", "validFrom", "projectId"]) {
        const owned = await refused(await olivia(`/service-area-assignments/${made.assignment.id}`, { method: "PATCH", body: { [field]: "x" } }), 400)
        assert.ok(owned.errors?.some((error) => error.message.includes(field)), `${field}: ${JSON.stringify(owned.errors)}`)
      }
      assert.deepEqual(await oneAssignment(lars, made.assignment.id), changed, "Lars reads NordRen's own")
      const cityhaul = (await assignments(olivia, `?serviceProviderId=${a.serviceProviders.cityhaul.id}`)).items[0]
      await refused(await lars(`/service-area-assignments/${cityhaul.id}`), 404)
      await refused(await lars(`/service-area-assignments/${made.assignment.id}`, { method: "PATCH", body: { notes: "Lars's" } }), 404)
      await refused(await olivia(`/service-area-assignments/${theirArea.assignment?.id}`), 404)
      await refused(await olivia(`/service-area-assignments/${testId()}`), 404)
      await refused(await ungranted(`/service-area-assignments/${theirArea.assignment?.id}`), 403)
    })

    test("refuses an end before the start in the contracts' words, an end outside the area's period, an end that strands the provider prices under it counting them, and an end meeting the next holder with the overlap sentence", async () => {
      const made = await area("CA-A-MOVE", { validFrom: JANUARY, validTo: NEXT_YEAR, assignment: { serviceProviderId: a.serviceProviders.nordren.id, validFrom: JANUARY, validTo: JULY } })
      assert.ok(made.assignment)
      await assign(olivia, made.id, { serviceProviderId: a.serviceProviders.cityhaul.id, validFrom: JULY, validTo: NEXT_YEAR })
      const backwards = await refused(await olivia(`/service-area-assignments/${made.assignment.id}`, { method: "PATCH", body: { validTo: "2025-12-01" } }), 400)
      assert.deepEqual([paths(backwards), messages(backwards)], [["validTo"], [ENDS_AFTER_IT_STARTS]])
      const outside = await refused(await olivia(`/service-area-assignments/${made.assignment.id}`, { method: "PATCH", body: { validTo: null } }), 400)
      assert.deepEqual([paths(outside), messages(outside)], [["validTo"], [OUTSIDE_AREA]])
      const overlapping = await refused(await olivia(`/service-area-assignments/${made.assignment.id}`, { method: "PATCH", body: { validTo: AUGUST } }), 409)
      assert.equal(overlapping.detail, ASSIGNMENT_RUNNING)
      // Two prices under the assignment, and an end that leaves them outside.
      const price = (productId: string) => create(olivia, "/service-provider-prices", { serviceAreaAssignmentId: made.assignment?.id, productId, bidMinor: 3_000, validFrom: MARCH, validTo: JULY }, ServiceProviderPrice)
      const residualPrice = await price(products.residual.id)
      const glassPrice = await price(products.glass.id)
      const two = await refused(await olivia(`/service-area-assignments/${made.assignment.id}`, { method: "PATCH", body: { validTo: "2026-05-01" } }), 409)
      assert.equal(two.detail, "2 service provider prices fall outside the new period; end them first")
      const endPrice = async (id: string) => assert.equal((await olivia(`/service-provider-prices/${id}`, { method: "PATCH", body: { validTo: "2026-05-01" } })).status, 200)
      await endPrice(glassPrice.id)
      const one = await refused(await olivia(`/service-area-assignments/${made.assignment.id}`, { method: "PATCH", body: { validTo: "2026-05-01" } }), 409)
      assert.equal(one.detail, "1 service provider price falls outside the new period; end it first")
      await endPrice(residualPrice.id)
      assert.equal((await patchAssignment(olivia, made.assignment.id, { validTo: "2026-06-01" })).validTo, "2026-06-01", "an end past the last price is taken")
      await refused(await olivia(`/service-area-assignments/${made.assignment.id}`, { method: "PATCH", body: {} }), 400)
    })
  })
})
