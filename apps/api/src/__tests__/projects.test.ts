import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Id } from "@waste/contracts/ids"
import { Project } from "@waste/contracts/organisation"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { encodeCursor } from "../pagination"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const ProjectPage = Page(Project)

/** A project body a caller may send. */
const body = (name: string) => ({ name, kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen" })

describe("the project endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /**
   * Three companies. Tenant A is the one under test and is written to;
   * tenant C is the second company, for the rules that need a write from
   * somewhere else; tenant B is never written to by any test in this file,
   * so its three seeded projects are a page whose size holds however the tests are
   * ordered.
   */
  let a: Tenant
  let b: Tenant
  let c: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let viewer: Call
  let other: Call
  /** The second company: what it writes is its own, and tenant B's page stays as it was seeded. */
  let third: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    c = await seedTenant(pool)
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    third = callingAs(app, keys, c.users.olivia, c.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    if (c) await dropTenant(pool, c.companyId)
    await pool?.close()
  })

  const page = async (call: Call, query = "") => {
    const response = await call(`/projects${query}`)
    assert.equal(response.status, 200, query)
    return ProjectPage.parse(await response.json())
  }
  const one = async (call: Call, id: string) => {
    const response = await call(`/projects/${id}`)
    assert.equal(response.status, 200)
    return Project.parse(await response.json())
  }
  const create = async (call: Call, values: Record<string, unknown>) =>
    created(call, "/projects", await call("/projects", { method: "POST", body: values }), Project)

  describe("GET /projects", () => {
    test("answers the company's projects in id order, which for a version 7 id is the order they were made", async () => {
      const { items, nextCursor } = await page(other, "?limit=200")
      assert.equal(items.length, 3)
      assert.deepEqual(
        items.map((project) => project.name).sort(),
        ["Cairo Operations", "Copenhagen Central", "Harbor Commercial"],
      )
      const ids = items.map((project) => project.id)
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.equal(nextCursor, null, "three of three: there is no next page")
      assert.deepEqual(items[0], await one(other, ids[0]), "a row in the list is the row on its own")
    })

    test("holds nothing of another company's, whatever either of them writes", async () => {
      const mine = (await page(olivia, "?limit=200")).items.map((project) => project.id)
      const theirs = (await page(other, "?limit=200")).items.map((project) => project.id)
      assert.ok(mine.includes(a.projects.copenhagen.id))
      assert.ok(theirs.includes(b.projects.copenhagen.id))
      for (const id of theirs) assert.ok(!mine.includes(id), `${id} belongs to the other company`)
    })

    test("walks the pages with the cursor and says when there is no next one", async () => {
      const all = (await page(other, "?limit=200")).items
      const first = await page(other, "?limit=2")
      assert.deepEqual(first.items, all.slice(0, 2))
      assert.ok(first.nextCursor !== null)
      const second = await page(other, `?limit=2&cursor=${first.nextCursor}`)
      assert.deepEqual(second.items, all.slice(2))
      assert.equal(second.nextCursor, null)

      // One at a time: three pages, then nothing left.
      const walked: string[] = []
      let cursor: string | null = null
      for (let step = 0; step < 4; step += 1) {
        const next: Awaited<ReturnType<typeof page>> = await page(other, `?limit=1${cursor === null ? "" : `&cursor=${cursor}`}`)
        walked.push(...next.items.map((project) => project.id))
        cursor = next.nextCursor
        if (cursor === null) break
      }
      assert.deepEqual(walked, all.map((project) => project.id))
      assert.equal(cursor, null)
    })

    test("answers an empty last page for a cursor past the end: a row can go between two pages", async () => {
      const all = (await page(other, "?limit=200")).items
      const { items, nextCursor } = await page(other, `?limit=2&cursor=${encodeCursor(all[all.length - 1].id)}`)
      assert.deepEqual(items, [])
      assert.equal(nextCursor, null)
    })

    test("takes the default page size when the query says nothing", async () => {
      const { items } = await page(other)
      assert.equal(items.length, 3)
    })

    test("refuses a cursor it did not write, naming the cursor", async () => {
      for (const cursor of ["nonsense", encodeCursor("not-an-id"), "MjU="]) {
        const response = await other(`/projects?cursor=${encodeURIComponent(cursor)}`)
        assert.equal(response.status, 400, cursor)
        const problem = await readProblem(response)
        assert.deepEqual(problem.errors?.map((error) => error.path), ["cursor"], cursor)
        assert.match(problem.detail ?? "", /query/, cursor)
      }
    })

    test("refuses a page size outside 1..200, naming the limit", async () => {
      for (const limit of ["0", "201", "many", "2.5"]) {
        const response = await other(`/projects?limit=${limit}`)
        assert.equal(response.status, 400, limit)
        assert.deepEqual((await readProblem(response)).errors?.map((error) => error.path), ["limit"], limit)
      }
    })

    test("refuses a role without configure.organization view, and a caller with no token", async () => {
      const refused = await viewer("/projects")
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /view on configure\.organization/)
      assert.equal((await app.request("/projects")).status, 401)
    })
  })

  describe("POST /projects", () => {
    test("mints the id itself, defaults the status to onboarding, and answers the row it wrote", async () => {
      const created = await create(olivia, body("Nørrebro Collection"))
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.name, "Nørrebro Collection")
      assert.equal(created.kind, "Contract")
      assert.equal(created.status, "onboarding")
      assert.equal(created.createdAt, created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), created, "and it is there on the next read")
      assert.ok((await page(olivia, "?limit=200")).items.some((project) => project.id === created.id))
    })

    test("takes a status when the caller gives one", async () => {
      const created = await create(olivia, { ...body("Amager Ressourcecenter"), status: "active" })
      assert.equal(created.status, "active")
    })

    test("mints a fresh id for every project, in the order they were made", async () => {
      const first = await create(olivia, body("Valby Pilot"))
      const second = await create(olivia, body("Vesterbro Pilot"))
      assert.notEqual(first.id, second.id)
      assert.ok(second.id > first.id, `${second.id} must sort after ${first.id}`)
    })

    test("refuses an id from the client: the server owns identity", async () => {
      const response = await olivia("/projects", { method: "POST", body: { ...body("Client Minted"), id: testId() } })
      assert.equal(response.status, 400)
      const problem = await readProblem(response)
      assert.equal(problem.detail, "The request body is invalid")
      assert.ok(problem.errors?.some((error) => /id/.test(error.message)), JSON.stringify(problem.errors))
    })

    test("refuses a body that is missing a field or spells one wrongly, naming it", async () => {
      const { name: _name, ...nameless } = body("x")
      const missing = await olivia("/projects", { method: "POST", body: nameless })
      assert.equal(missing.status, 400)
      assert.deepEqual((await readProblem(missing)).errors?.map((error) => error.path), ["name"])

      const wrong = await olivia("/projects", { method: "POST", body: { ...body("Bad Zone"), timezone: "Copenhagen" } })
      assert.equal(wrong.status, 400)
      const problem = await readProblem(wrong)
      assert.deepEqual(problem.errors?.map((error) => error.path), ["timezone"])
      assert.match(problem.errors?.[0].message ?? "", /IANA/)
    })

    test("refuses a role that may view but not create", async () => {
      const response = await viewer("/projects", { method: "POST", body: body("Not mine to make") })
      assert.equal(response.status, 403)
      assert.match((await readProblem(response)).detail ?? "", /create on configure\.organization/)
    })

    test("refuses a name the company already uses, and writes nothing", async () => {
      const before_ = (await page(olivia, "?limit=200")).items.length
      const response = await olivia("/projects", { method: "POST", body: body("Copenhagen Central") })
      assert.equal(response.status, 409)
      const problem = await readProblem(response)
      assert.equal(problem.title, "Conflict")
      assert.match(problem.detail ?? "", /Copenhagen Central/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await page(olivia, "?limit=200")).items.length, before_)
    })

    test("lets another company use the same name: a project name is unique inside a company", async () => {
      const created = await create(third, body("Copenhagen Central II"))
      assert.equal((await create(olivia, body("Copenhagen Central II"))).name, created.name)
    })
  })

  describe("GET /projects/:id", () => {
    test("answers one project of the caller's company", async () => {
      const project = await one(olivia, a.projects.harbor.id)
      assert.equal(project.name, "Harbor Commercial")
      assert.equal(project.status, "onboarding")
    })

    test("answers 404 for another company's project: the fence makes it a row that does not exist", async () => {
      const response = await olivia(`/projects/${b.projects.copenhagen.id}`)
      assert.equal(response.status, 404)
      const problem = await readProblem(response)
      assert.match(problem.detail ?? "", /project/i)
      assert.equal((await one(other, b.projects.copenhagen.id)).name, "Copenhagen Central", "and it is still there for its own company")
    })

    test("answers 404 for an id nobody minted", async () => {
      assert.equal((await olivia(`/projects/${testId()}`)).status, 404)
    })

    test("refuses a role without configure.organization view, and a caller with no token", async () => {
      const refused = await viewer(`/projects/${a.projects.harbor.id}`)
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /view on configure\.organization/)
      assert.equal((await app.request(`/projects/${a.projects.harbor.id}`)).status, 401)
    })

    test("answers 400 for a path that is not an id, naming it", async () => {
      const response = await olivia("/projects/not-a-uuid")
      assert.equal(response.status, 400)
      const problem = await readProblem(response)
      assert.equal(problem.detail, "The request path is invalid")
      assert.deepEqual(problem.errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /projects/:id", () => {
    test("changes what the body names and answers the row as it now stands", async () => {
      const created = await create(olivia, body("Frederiksberg Trial"))
      const response = await olivia(`/projects/${created.id}`, { method: "PATCH", body: { name: "Frederiksberg", status: "active" } })
      assert.equal(response.status, 200)
      const patched = Project.parse(await response.json())
      assert.equal(patched.id, created.id)
      assert.equal(patched.name, "Frederiksberg")
      assert.equal(patched.status, "active")
      assert.equal(patched.currency, created.currency, "what the patch did not name it did not touch")
      assert.ok(patched.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), patched)
    })

    test("refuses an empty patch and a member it does not own", async () => {
      const empty = await olivia(`/projects/${a.projects.cairo.id}`, { method: "PATCH", body: {} })
      assert.equal(empty.status, 400)
      assert.deepEqual((await readProblem(empty)).errors?.map((error) => error.path), [""])

      const owned = await olivia(`/projects/${a.projects.cairo.id}`, { method: "PATCH", body: { name: "Cairo", createdAt: "2026-09-24T13:41:00.000Z" } })
      assert.equal(owned.status, 400)
      assert.ok((await readProblem(owned)).errors?.some((error) => /createdAt/.test(error.message)))
    })

    test("refuses a role without configure.organization edit", async () => {
      const response = await viewer(`/projects/${a.projects.cairo.id}`, { method: "PATCH", body: { name: "Not mine" } })
      assert.equal(response.status, 403)
      assert.match((await readProblem(response)).detail ?? "", /edit on configure\.organization/)
    })

    test("answers 404 for another company's project, and leaves it alone", async () => {
      const response = await olivia(`/projects/${b.projects.harbor.id}`, { method: "PATCH", body: { name: "Mine now" } })
      assert.equal(response.status, 404)
      await readProblem(response)
      assert.equal((await one(other, b.projects.harbor.id)).name, "Harbor Commercial")
    })

    test("refuses a rename onto a name the company already uses, and changes nothing", async () => {
      const created = await create(olivia, body("Sydhavn Trial"))
      const response = await olivia(`/projects/${created.id}`, { method: "PATCH", body: { name: "Harbor Commercial" } })
      assert.equal(response.status, 409)
      const problem = await readProblem(response)
      assert.match(problem.detail ?? "", /Harbor Commercial/)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await one(olivia, created.id)).name, "Sydhavn Trial")
    })
  })
})
