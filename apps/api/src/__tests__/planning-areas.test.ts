import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Polygon } from "@waste/contracts/geojson"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { PlanningArea, PlanningAreaBoundary, PlanningAreaCreated } from "@waste/contracts/planning-areas"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const PlanningAreaPage = Page(PlanningArea)
const BoundaryPage = Page(PlanningAreaBoundary)

const MODULE = "configure.areas"

/** The days the periods of this file are cut from; every test says which of them it means. */
const JANUARY = "2026-01-01"
const APRIL = "2026-04-01"
const JULY = "2026-07-01"
const OCTOBER = "2026-10-01"
const NEXT_YEAR = "2027-01-01"

/** A square over central Copenhagen: four distinct corners closing on the first, which is all the shape rule asks. */
const SQUARE: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [12.5, 55.65],
      [12.65, 55.65],
      [12.65, 55.75],
      [12.5, 55.75],
      [12.5, 55.65],
    ],
  ],
}
/** A smaller square inside it: another outline of the same area, for a later version or a redraw. */
const INNER: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [12.55, 55.68],
      [12.6, 55.68],
      [12.6, 55.72],
      [12.55, 55.72],
      [12.55, 55.68],
    ],
  ],
}
/** The same four corners visited in the wrong order: a closed ring of four distinct positions that crosses itself, which the contracts' shape rule cannot see and ST_IsValid does. */
const BOW_TIE: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [12.5, 55.65],
      [12.65, 55.75],
      [12.65, 55.65],
      [12.5, 55.75],
      [12.5, 55.65],
    ],
  ],
}

/** One sentence for whatever PostGIS refuses: the constraint cannot say which of its reasons it was. */
const NOT_A_VALID_POLYGON = "Not a valid polygon"
const BOUNDARY_RUNNING = "This planning area already has a boundary in force over that period; end it first"

describe("the planning area and boundary endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted view: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** The other company's, with one boundary. */
  let theirArea: PlanningArea
  let theirBoundary: PlanningAreaBoundary

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    theirArea = await create(
      other,
      "/planning-areas",
      { projectId: b.projects.copenhagen.id, code: "THEIRS-01", name: "Their area", purpose: "route-planning", boundary: { boundary: SQUARE, validFrom: JANUARY } },
      PlanningArea,
    )
    const theirs = await boundaries(other, theirArea.id)
    theirBoundary = theirs.items[0]
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** An area body a caller may send: the fields with no default, on Copenhagen Central unless a test says otherwise. */
  const body = (code: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    code,
    name: `Area ${code}`,
    purpose: "route-planning",
    ...values,
  })

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const area = (code: string, values: Record<string, unknown> = {}) => create(olivia, "/planning-areas", body(code, values), PlanningArea)
  const one = async (call: Call, id: string): Promise<PlanningArea> => {
    const response = await call(`/planning-areas/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PlanningArea.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<PlanningArea> => {
    const response = await call(`/planning-areas/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PlanningArea.parse(await response.json())
  }
  const page = async (call: Call, query = "") => {
    const response = await call(`/planning-areas${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PlanningAreaPage.parse(await response.json())
  }
  const boundaries = async (call: Call, areaId: string, query = "") => {
    const response = await call(`/planning-areas/${areaId}/boundaries${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BoundaryPage.parse(await response.json())
  }
  const allBoundaries = async (call: Call, query = "") => {
    const response = await call(`/planning-area-boundaries${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return BoundaryPage.parse(await response.json())
  }
  const oneBoundary = async (call: Call, id: string): Promise<PlanningAreaBoundary> => {
    const response = await call(`/planning-area-boundaries/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PlanningAreaBoundary.parse(await response.json())
  }
  /** One version of an area: the square from January unless a test says otherwise. */
  const addBoundary = (areaId: string, values: Record<string, unknown> = {}) =>
    create(olivia, `/planning-areas/${areaId}/boundaries`, { boundary: SQUARE, validFrom: JANUARY, ...values }, PlanningAreaBoundary)
  const patchBoundary = async (call: Call, id: string, values: unknown): Promise<PlanningAreaBoundary> => {
    const response = await call(`/planning-area-boundaries/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PlanningAreaBoundary.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  describe("POST /planning-areas", () => {
    test("mints the id, keeps the code, the name and the purpose, and writes no boundary when none was given", async () => {
      const created = await area("OP-CEN-01", { name: "Copenhagen Central North", purpose: "service-operations" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.deepEqual([created.code, created.name, created.purpose], ["OP-CEN-01", "Copenhagen Central North", "service-operations"])
      assert.deepEqual(await one(olivia, created.id), created)
      assert.deepEqual((await boundaries(olivia, created.id)).items, [], "an area may be registered first and drawn later")

      const response = await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-01b") })
      assert.equal(response.status, 201)
      assert.equal(PlanningAreaCreated.parse(await response.json()).boundary, null, "the 201 says no version was drawn")
    })

    test("writes the first boundary in the same transaction when the body carries one, and answers it beside the area", async () => {
      const response = await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-02", { boundary: { boundary: SQUARE, validFrom: JANUARY, validTo: NEXT_YEAR } }) })
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
      const created = PlanningAreaCreated.parse(await response.json())
      assert.notEqual(created.boundary, null, "the client learns the version's id from the one request")
      const version = created.boundary as PlanningAreaBoundary
      assert.equal(Id.parse(version.id), version.id)
      assert.equal(version.planningAreaId, created.id)
      assert.equal(version.projectId, created.projectId, "the version's project is the area's")
      assert.deepEqual(version.boundary, SQUARE, "the polygon reads back as the GeoJSON it was written as")
      assert.deepEqual([version.validFrom, version.validTo], [JANUARY, NEXT_YEAR])
      assert.deepEqual((await boundaries(olivia, created.id)).items, [version], "and it is the one version the area has")
      assert.deepEqual(await oneBoundary(olivia, version.id), version)
      const { boundary: _boundary, ...areaAlone } = created
      assert.deepEqual(await one(olivia, created.id), areaAlone, "the area on its own carries no version")
    })

    test("refuses a first boundary whose ring crosses itself as a 400 on boundary.boundary, and writes neither the area nor the version", async () => {
      const problem = await refused(await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-03", { boundary: { boundary: BOW_TIE, validFrom: JANUARY } }) }), 400)
      assert.deepEqual(problem.errors, [{ path: "boundary.boundary", message: NOT_A_VALID_POLYGON }])
      assert.equal((await page(olivia, "?limit=200")).items.some((row) => row.code === "OP-CEN-03"), false, "the area went with the version: one transaction")

      const backwards = await refused(await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-03", { boundary: { boundary: SQUARE, validFrom: JULY, validTo: JULY } }) }), 400)
      assert.deepEqual(backwards.errors?.map((error) => error.path), ["boundary.validTo"])
    })

    test("refuses a project the caller does not work in, a member the server owns, and a purpose outside the three", async () => {
      const foreign = await refused(await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-04", { projectId: b.projects.copenhagen.id }) }), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-04", { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
      const purpose = await refused(await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-04", { purpose: "decoration" }) }), 400)
      assert.deepEqual(purpose.errors?.map((error) => error.path), ["purpose"])
    })

    test("refuses a code and a name the project already uses, each with its own sentence, and lets another project use them", async () => {
      await area("OP-CEN-05", { name: "Østerbro" })
      const code = await refused(await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-05", { name: "Something else" }) }), 409)
      assert.equal(code.detail, 'This project already has a planning area coded "OP-CEN-05"')
      const name = await refused(await olivia("/planning-areas", { method: "POST", body: body("OP-CEN-06", { name: "Østerbro" }) }), 409)
      assert.equal(name.detail, 'This project already has a planning area called "Østerbro"')
      assert.doesNotMatch(`${code.detail}${name.detail}`, /_key/)

      const harbor = await area("OP-CEN-05", { name: "Østerbro", projectId: a.projects.harbor.id })
      assert.equal(harbor.code, "OP-CEN-05", "a code is one area's inside a project, and free in the next")
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/planning-areas", { method: "POST", body: body("OP-CEN-07") }), 403)
      assert.match(problem.detail ?? "", /create on configure\.areas/)
    })
  })

  describe("GET /planning-areas", () => {
    test("answers the company's areas in id order and holds nothing of another company's", async () => {
      const mine = await area("OP-CEN-10")
      const ids = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.ok(!ids.includes(theirArea.id))
      assert.deepEqual((await page(other, "?limit=200")).items.map((row) => row.code), ["THEIRS-01"])
    })

    test("filters by project and by purpose", async () => {
      const harbor = await area("OP-HAR-11", { projectId: a.projects.harbor.id, purpose: "notification" })
      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)

      const byPurpose = await page(olivia, "?limit=200&purpose=notification")
      assert.ok(byPurpose.items.some((row) => row.id === harbor.id))
      for (const row of byPurpose.items) assert.equal(row.purpose, "notification")
      assert.deepEqual((await refused(await olivia("/planning-areas?purpose=decoration"), 400)).errors?.map((error) => error.path), ["purpose"])
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await area("OP-CEN-12")
      const elsewhere = await area("OP-HAR-12", { projectId: a.projects.harbor.id })
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      const { items, nextCursor } = await page(lars, "?limit=200")
      assert.deepEqual(items, [], "a service provider's account works in no project and reads none of this")
      assert.equal(nextCursor, null)

      const problem = await refused(await viewer(`/planning-areas?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without configure.areas view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/planning-areas"), 403)).detail ?? "", /view on configure\.areas/)
      assert.equal((await app.request("/planning-areas")).status, 401)
    })
  })

  describe("GET /planning-areas/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/planning-areas/${theirArea.id}`), 404)
      assert.match(foreign.detail ?? "", /planning area/i)
      assert.equal((await one(other, theirArea.id)).code, "THEIRS-01", "still there for its own company")

      const elsewhere = await area("OP-HAR-20", { projectId: a.projects.harbor.id })
      await refused(await viewer(`/planning-areas/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).code, "OP-HAR-20")
      await refused(await lars(`/planning-areas/${elsewhere.id}`), 404)
      await refused(await olivia(`/planning-areas/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/planning-areas/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /planning-areas/:id", () => {
    test("changes the name and the purpose and leaves the code, which is not a field of the patch", async () => {
      const created = await area("OP-CEN-30")
      await nextMillisecond()
      const changed = await patch(olivia, created.id, { name: "Nørrebro", purpose: "notification" })
      assert.deepEqual([changed.code, changed.name, changed.purpose], ["OP-CEN-30", "Nørrebro", "notification"])
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)

      const code = await refused(await olivia(`/planning-areas/${created.id}`, { method: "PATCH", body: { code: "OP-CEN-31" } }), 400)
      assert.ok(code.errors?.some((error) => /code/.test(error.message)), JSON.stringify(code.errors))
      assert.equal((await one(olivia, created.id)).code, "OP-CEN-30", "the code is the reference the rest of the system quotes")
    })

    test("refuses a rename onto a name the project already uses, and changes nothing", async () => {
      await area("OP-CEN-32", { name: "Amager" })
      const created = await area("OP-CEN-33", { name: "Amager Øst" })
      const problem = await refused(await olivia(`/planning-areas/${created.id}`, { method: "PATCH", body: { name: "Amager" } }), 409)
      assert.equal(problem.detail, 'This project already has a planning area called "Amager"')
      assert.equal((await one(olivia, created.id)).name, "Amager Øst")
    })

    test("refuses another company's area, one out of the caller's projects, an empty patch, and a role that may view but not edit", async () => {
      await refused(await olivia(`/planning-areas/${theirArea.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirArea.id)).name, "Their area")
      const elsewhere = await area("OP-HAR-34", { projectId: a.projects.harbor.id })
      await refused(await viewer(`/planning-areas/${elsewhere.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.deepEqual((await refused(await olivia(`/planning-areas/${elsewhere.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path), [""])
      assert.match((await refused(await lars(`/planning-areas/${elsewhere.id}`, { method: "PATCH", body: { name: "x" } }), 403)).detail ?? "", /edit on configure\.areas/)
    })
  })

  describe("POST /planning-areas/:id/boundaries", () => {
    test("writes one version, taking the area and the project from the path, and reads the polygon back as written", async () => {
      const created = await area("OP-CEN-40")
      const written = await addBoundary(created.id, { validTo: NEXT_YEAR })
      assert.equal(Id.parse(written.id), written.id)
      assert.equal(written.planningAreaId, created.id)
      assert.equal(written.projectId, created.projectId, "the project is the area's; a body cannot name one")
      assert.deepEqual(written.boundary, SQUARE)
      assert.deepEqual([written.validFrom, written.validTo], [JANUARY, NEXT_YEAR])
      assert.deepEqual(await oneBoundary(olivia, written.id), written)

      const running = await addBoundary(created.id, { boundary: INNER, validFrom: NEXT_YEAR })
      assert.equal(running.validTo, null, "a version with no end is the one still in force")
    })

    test("refuses a ring that crosses itself as a 400 on boundary — PostGIS's check, answered as the schema's would be — and writes nothing", async () => {
      const created = await area("OP-CEN-41")
      const problem = await refused(await olivia(`/planning-areas/${created.id}/boundaries`, { method: "POST", body: { boundary: BOW_TIE, validFrom: JANUARY } }), 400)
      assert.equal(problem.detail, "The request body is invalid")
      assert.deepEqual(problem.errors, [{ path: "boundary", message: NOT_A_VALID_POLYGON }])
      assert.deepEqual((await boundaries(olivia, created.id)).items, [])

      // What the shape rule can see never reaches the database: an ordinate off the globe is the contracts' 400, at the ordinate.
      const offTheGlobe: Polygon = { type: "Polygon", coordinates: [SQUARE.coordinates[0].map(([lng, lat]) => [lng + 180, lat])] }
      const shape = await refused(await olivia(`/planning-areas/${created.id}/boundaries`, { method: "POST", body: { boundary: offTheGlobe, validFrom: JANUARY } }), 400)
      assert.match(shape.errors?.[0].path ?? "", /^boundary\.coordinates\./)
      const open: Polygon = { type: "Polygon", coordinates: [SQUARE.coordinates[0].slice(0, 4)] }
      const unclosed = await refused(await olivia(`/planning-areas/${created.id}/boundaries`, { method: "POST", body: { boundary: open, validFrom: JANUARY } }), 400)
      assert.match(unclosed.errors?.[0].path ?? "", /^boundary/)
    })

    test("refuses a period overlapping another version of the area with its sentence, and takes one back to back", async () => {
      const created = await area("OP-CEN-42")
      await addBoundary(created.id, { validFrom: JANUARY, validTo: JULY })
      const next = await addBoundary(created.id, { boundary: INNER, validFrom: JULY, validTo: NEXT_YEAR })
      assert.equal(next.validFrom, JULY, "the day one version ends is the day the next may begin")

      const problem = await refused(await olivia(`/planning-areas/${created.id}/boundaries`, { method: "POST", body: { boundary: SQUARE, validFrom: APRIL, validTo: OCTOBER } }), 409)
      assert.equal(problem.detail, BOUNDARY_RUNNING)
      assert.doesNotMatch(problem.detail ?? "", /no_overlap/)
      assert.equal((await boundaries(olivia, created.id)).items.length, 2)

      const another = await area("OP-CEN-43")
      const overlapping = await addBoundary(another.id, { validFrom: APRIL, validTo: OCTOBER })
      assert.equal(overlapping.planningAreaId, another.id, "two areas of one project may overlap in time and on the map: that is a read, not a constraint")
    })

    test("refuses a period that ends where it starts, an area outside the caller's projects, and a role that may view but not create", async () => {
      const created = await area("OP-CEN-44")
      const empty = await refused(await olivia(`/planning-areas/${created.id}/boundaries`, { method: "POST", body: { boundary: SQUARE, validFrom: JULY, validTo: JULY } }), 400)
      assert.deepEqual(empty.errors?.map((error) => error.path), ["validTo"])

      const elsewhere = await area("OP-HAR-44", { projectId: a.projects.harbor.id })
      await refused(await viewer(`/planning-areas/${elsewhere.id}/boundaries`, { method: "POST", body: { boundary: SQUARE, validFrom: JANUARY } }), 404)
      await refused(await olivia(`/planning-areas/${theirArea.id}/boundaries`, { method: "POST", body: { boundary: SQUARE, validFrom: NEXT_YEAR } }), 404)
      assert.equal((await boundaries(other, theirArea.id)).items.length, 1, "nothing landed on the other company's area")
      assert.match((await refused(await lars(`/planning-areas/${created.id}/boundaries`, { method: "POST", body: { boundary: SQUARE, validFrom: JANUARY } }), 403)).detail ?? "", /create on configure\.areas/)
    })
  })

  describe("GET /planning-areas/:id/boundaries", () => {
    test("answers the area's versions, picks the one in force on the day asked, and none on a day between two", async () => {
      const created = await area("OP-CEN-50")
      const first = await addBoundary(created.id, { validFrom: JANUARY, validTo: APRIL })
      const second = await addBoundary(created.id, { boundary: INNER, validFrom: JULY })
      const elsewhere = await area("OP-CEN-51")
      const outside = await addBoundary(elsewhere.id)

      const all = await boundaries(olivia, created.id, "?limit=200")
      assert.deepEqual(all.items.map((row) => row.id), [first.id, second.id], "oldest written first")
      assert.ok(!all.items.some((row) => row.id === outside.id), "another area's versions are not this one's")

      assert.deepEqual((await boundaries(olivia, created.id, "?validOn=2026-02-01")).items.map((row) => row.id), [first.id])
      assert.deepEqual((await boundaries(olivia, created.id, `?validOn=${NEXT_YEAR}`)).items.map((row) => row.id), [second.id])
      assert.deepEqual((await boundaries(olivia, created.id, `?validOn=${APRIL}`)).items, [], "validTo is the first day out of force, and no version covers the gap")
      assert.deepEqual((await boundaries(olivia, created.id, "?validOn=2026-05-15")).items, [])
      assert.deepEqual((await refused(await olivia(`/planning-areas/${created.id}/boundaries?validOn=2026-02-30`), 400)).errors?.map((error) => error.path), ["validOn"])

      await refused(await viewer(`/planning-areas/${theirArea.id}/boundaries`), 404)
      await refused(await lars(`/planning-areas/${created.id}/boundaries`), 404)
    })
  })

  describe("GET /planning-area-boundaries", () => {
    test("answers the versions across the caller's projects' areas, by project, by area and by day", async () => {
      const central = await area("OP-CEN-60")
      const centralNow = await addBoundary(central.id, { validFrom: JANUARY })
      const north = await area("OP-CEN-61")
      const northThen = await addBoundary(north.id, { validFrom: JANUARY, validTo: JULY })
      const northNow = await addBoundary(north.id, { boundary: INNER, validFrom: JULY })
      const harbor = await area("OP-HAR-62", { projectId: a.projects.harbor.id })
      const harborNow = await addBoundary(harbor.id)

      const mine = (await allBoundaries(olivia, "?limit=200")).items.map((row) => row.id)
      for (const id of [centralNow.id, northThen.id, northNow.id, harborNow.id]) assert.ok(mine.includes(id))
      assert.ok(!mine.includes(theirBoundary.id))
      assert.deepEqual(mine, [...mine].sort(), "ascending by id")

      const byProject = (await allBoundaries(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)).items
      assert.ok(byProject.some((row) => row.id === harborNow.id))
      for (const row of byProject) assert.equal(row.projectId, a.projects.harbor.id)
      assert.deepEqual((await allBoundaries(olivia, `?limit=200&planningAreaId=${north.id}`)).items.map((row) => row.id), [northThen.id, northNow.id])

      // The Layers control's read: the outlines in force today, one per area.
      const today = (await allBoundaries(olivia, `?limit=200&validOn=${OCTOBER}&projectId=${a.projects.copenhagen.id}`)).items
      assert.ok(today.some((row) => row.id === centralNow.id))
      assert.ok(today.some((row) => row.id === northNow.id))
      assert.ok(!today.some((row) => row.id === northThen.id), "the version that ended in July is not in force in October")
      const areas = today.map((row) => row.planningAreaId)
      assert.equal(new Set(areas).size, areas.length, "at most one version of an area on a day")
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await addBoundary((await area("OP-CEN-63")).id)
      const elsewhere = await addBoundary((await area("OP-HAR-63", { projectId: a.projects.harbor.id })).id)
      const seen = (await allBoundaries(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      assert.deepEqual(await allBoundaries(lars, "?limit=200"), { items: [], nextCursor: null })
      assert.deepEqual((await allBoundaries(other, "?limit=200")).items.map((row) => row.id), [theirBoundary.id])
      assert.deepEqual((await refused(await viewer(`/planning-area-boundaries?projectId=${a.projects.harbor.id}`), 400)).errors?.map((error) => error.path), ["projectId"])
      assert.match((await refused(await ungranted("/planning-area-boundaries"), 403)).detail ?? "", /view on configure\.areas/)
    })
  })

  describe("GET and PATCH /planning-area-boundaries/:id", () => {
    test("answers one version, and 404 for another company's, for one out of the caller's projects, and for an id nobody minted", async () => {
      const created = await area("OP-CEN-70")
      const written = await addBoundary(created.id)
      assert.deepEqual(await oneBoundary(olivia, written.id), written)
      await refused(await olivia(`/planning-area-boundaries/${theirBoundary.id}`), 404)
      const elsewhere = await addBoundary((await area("OP-HAR-70", { projectId: a.projects.harbor.id })).id)
      await refused(await viewer(`/planning-area-boundaries/${elsewhere.id}`), 404)
      await refused(await olivia(`/planning-area-boundaries/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/planning-area-boundaries/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })

    test("ends a version, reopens it, and redraws it, moving the stamp each time", async () => {
      const created = await area("OP-CEN-71")
      const written = await addBoundary(created.id)
      await nextMillisecond()
      const ended = await patchBoundary(olivia, written.id, { validTo: JULY })
      assert.equal(ended.validTo, JULY)
      assert.equal(ended.validFrom, JANUARY, "the start does not move")
      assert.ok(ended.updatedAt > written.updatedAt)
      const reopened = await patchBoundary(olivia, written.id, { validTo: null })
      assert.equal(reopened.validTo, null, "a null takes the end off again")
      const redrawn = await patchBoundary(olivia, written.id, { boundary: INNER })
      assert.deepEqual(redrawn.boundary, INNER)
      assert.deepEqual(await oneBoundary(olivia, written.id), redrawn)
    })

    test("refuses an end before the stored start, which the body alone cannot see, in the contracts' words", async () => {
      const created = await area("OP-CEN-72")
      const written = await addBoundary(created.id, { validFrom: JULY })
      const problem = await refused(await olivia(`/planning-area-boundaries/${written.id}`, { method: "PATCH", body: { validTo: APRIL } }), 400)
      assert.deepEqual(problem.errors?.map((error) => error.path), ["validTo"])
      assert.match(problem.errors?.[0].message ?? "", /comes after validFrom/)
      const empty = await refused(await olivia(`/planning-area-boundaries/${written.id}`, { method: "PATCH", body: { validTo: JULY } }), 400)
      assert.deepEqual(empty.errors?.map((error) => error.path), ["validTo"])
      assert.equal((await oneBoundary(olivia, written.id)).validTo, null)
    })

    test("refuses an end moved past the next version, and a version reopened under one, with the overlap sentence", async () => {
      const created = await area("OP-CEN-73")
      const first = await addBoundary(created.id, { validFrom: JANUARY, validTo: JULY })
      await addBoundary(created.id, { boundary: INNER, validFrom: JULY, validTo: NEXT_YEAR })
      const past = await refused(await olivia(`/planning-area-boundaries/${first.id}`, { method: "PATCH", body: { validTo: OCTOBER } }), 409)
      assert.equal(past.detail, BOUNDARY_RUNNING)
      const reopened = await refused(await olivia(`/planning-area-boundaries/${first.id}`, { method: "PATCH", body: { validTo: null } }), 409)
      assert.equal(reopened.detail, BOUNDARY_RUNNING)
      assert.equal((await oneBoundary(olivia, first.id)).validTo, JULY, "a refused patch changes nothing")
      const earlier = await patchBoundary(olivia, first.id, { validTo: APRIL })
      assert.equal(earlier.validTo, APRIL, "an end pulled in leaves a gap, which is allowed: no version is in force in the gap")
    })

    test("refuses a redraw whose ring crosses itself as a 400 on boundary, and keeps the stored outline", async () => {
      const created = await area("OP-CEN-74")
      const written = await addBoundary(created.id)
      const problem = await refused(await olivia(`/planning-area-boundaries/${written.id}`, { method: "PATCH", body: { boundary: BOW_TIE } }), 400)
      assert.deepEqual(problem.errors, [{ path: "boundary", message: NOT_A_VALID_POLYGON }])
      const stored = await oneBoundary(olivia, written.id)
      assert.deepEqual(stored.boundary, SQUARE)
      assert.equal(stored.updatedAt, written.updatedAt, "a refused patch does not move the stamp")
    })

    test("refuses the start, an empty patch, another company's version, and a role that may view but not edit", async () => {
      const created = await area("OP-CEN-75")
      const written = await addBoundary(created.id)
      const start = await refused(await olivia(`/planning-area-boundaries/${written.id}`, { method: "PATCH", body: { validFrom: APRIL } }), 400)
      assert.ok(start.errors?.some((error) => /validFrom/.test(error.message)), JSON.stringify(start.errors))
      assert.deepEqual((await refused(await olivia(`/planning-area-boundaries/${written.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path), [""])
      await refused(await olivia(`/planning-area-boundaries/${theirBoundary.id}`, { method: "PATCH", body: { validTo: JULY } }), 404)
      assert.equal((await oneBoundary(other, theirBoundary.id)).validTo, null)
      assert.match((await refused(await lars(`/planning-area-boundaries/${written.id}`, { method: "PATCH", body: { validTo: JULY } }), 403)).detail ?? "", /edit on configure\.areas/)
    })
  })
})
