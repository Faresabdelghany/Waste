import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { User } from "@waste/contracts/access"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"
import { projectAccess, serviceProviderAccess, userAccount } from "@waste/db/schema/access"
import { company } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { encodeCursor } from "../pagination"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const UserPage = Page(User)

/** An address no other test or tenant holds; the seed's two are spoken for. */
const address = () => `invitee.${randomBytes(4).toString("hex")}@invite.example`

describe("the user endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /**
   * Three companies. Tenant A is the one under test and is written to;
   * tenant C is the second company, for the rules that need a write from
   * somewhere else; tenant B is never written to by any test in this file,
   * so its five seeded users are a page whose size holds however the tests are
   * ordered.
   */
  let a: Tenant
  let b: Tenant
  let c: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let viewer: Call
  let lars: Call
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
    lars = callingAs(app, keys, a.users.lars, a.companyId)
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
    const response = await call(`/users${query}`)
    assert.equal(response.status, 200, query)
    return UserPage.parse(await response.json())
  }
  const one = async (call: Call, id: string) => {
    const response = await call(`/users/${id}`)
    assert.equal(response.status, 200)
    return User.parse(await response.json())
  }
  const invite = async (call: Call, values: Record<string, unknown>) => {
    const response = await call("/users", { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return User.parse(await response.json())
  }
  const patch = async (call: Call, id: string, body: Record<string, unknown>) => {
    const response = await call(`/users/${id}`, { method: "PATCH", body })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return User.parse(await response.json())
  }

  /** The access rows beside the account, read as the API role would. */
  const accessRows = (userAccountId: string, companyId = a.companyId) =>
    withCompany(pool.db, companyId, async (tx) => ({
      projects: (
        await tx
          .select({ projectId: projectAccess.projectId })
          .from(projectAccess)
          .where(and(eq(projectAccess.companyId, companyId), eq(projectAccess.userAccountId, userAccountId)))
      )
        .map((row) => row.projectId)
        .sort(),
      providers: (
        await tx
          .select({ serviceProviderId: serviceProviderAccess.serviceProviderId })
          .from(serviceProviderAccess)
          .where(and(eq(serviceProviderAccess.companyId, companyId), eq(serviceProviderAccess.userAccountId, userAccountId)))
      ).map((row) => row.serviceProviderId),
    }))

  /** What the access token hook does on a first sign-in: bind the login to the account. */
  const bindLogin = (userAccountId: string) =>
    withCompany(pool.db, a.companyId, (tx) =>
      tx
        .update(userAccount)
        .set({ authUserId: randomUUID() })
        .where(and(eq(userAccount.companyId, a.companyId), eq(userAccount.id, userAccountId))),
    )

  describe("GET /users", () => {
    test("answers the company's accounts in id order, each with its derived status and its access", async () => {
      const { items, nextCursor } = await page(other, "?limit=200")
      assert.equal(items.length, 5)
      assert.equal(nextCursor, null, "five of five: there is no next page")
      const ids = items.map((user) => user.id)
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")

      const byEmail = new Map(items.map((user) => [user.email, user]))
      const seeded = byEmail.get(b.users.olivia.email)
      assert.deepEqual(seeded, {
        id: b.users.olivia.id,
        email: b.users.olivia.email,
        fullName: "Olivia Larsen",
        status: "active",
        roleId: b.roles.administrator.id,
        allProjects: true,
        projectIds: [],
        serviceProviderId: null,
        primaryAdministrator: true,
        deactivatedAt: null,
        createdAt: seeded?.createdAt ?? "",
        updatedAt: seeded?.updatedAt ?? "",
      })
      assert.equal(byEmail.get(b.users.invited.email)?.status, "invited", "no login bound yet")
      assert.equal(byEmail.get(b.users.deactivated.email)?.status, "deactivated")
      assert.notEqual(byEmail.get(b.users.deactivated.email)?.deactivatedAt, null)
      assert.deepEqual(byEmail.get(b.users.viewer.email)?.projectIds, [b.projects.copenhagen.id], "its one Project Access row")
      assert.equal(byEmail.get(b.users.lars.email)?.serviceProviderId, b.serviceProviders.nordren.id)
      assert.deepEqual(byEmail.get(b.users.lars.email)?.projectIds, [], "a provider user takes no Project Access")
      assert.deepEqual(items[0], await one(other, ids[0]), "a row in the list is the row on its own")
    })

    test("holds nothing of another company's", async () => {
      const mine = (await page(olivia, "?limit=200")).items.map((user) => user.id)
      const theirs = (await page(other, "?limit=200")).items.map((user) => user.id)
      assert.ok(mine.includes(a.users.olivia.id))
      for (const id of theirs) assert.ok(!mine.includes(id), `${id} belongs to the other company`)
    })

    test("walks the pages with the cursor and says when there is no next one", async () => {
      const all = (await page(other, "?limit=200")).items
      const first = await page(other, "?limit=2")
      assert.deepEqual(first.items, all.slice(0, 2))
      assert.ok(first.nextCursor !== null)
      const second = await page(other, `?limit=2&cursor=${first.nextCursor}`)
      assert.deepEqual(second.items, all.slice(2, 4))
      assert.ok(second.nextCursor !== null)
      const third = await page(other, `?limit=2&cursor=${second.nextCursor}`)
      assert.deepEqual(third.items, all.slice(4))
      assert.equal(third.nextCursor, null)

      const past = await page(other, `?limit=2&cursor=${encodeCursor(all[all.length - 1].id)}`)
      assert.deepEqual(past.items, [])
      assert.equal(past.nextCursor, null)
    })

    test("refuses a cursor it did not write and a page size outside 1..200", async () => {
      const cursor = await other(`/users?cursor=${encodeURIComponent("nonsense")}`)
      assert.equal(cursor.status, 400)
      assert.deepEqual((await readProblem(cursor)).errors?.map((error) => error.path), ["cursor"])
      const limit = await other("/users?limit=201")
      assert.equal(limit.status, 400)
      assert.deepEqual((await readProblem(limit)).errors?.map((error) => error.path), ["limit"])
    })

    test("lets a role with configure.access view list, refuses one without the module, and refuses no token at all", async () => {
      assert.equal((await viewer("/users")).status, 200, "the custom viewer may look")
      const refused = await lars("/users")
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /view on configure\.access/)
      assert.equal((await app.request("/users")).status, 401)
    })
  })

  describe("POST /users", () => {
    test("invites a company user into the projects it names, with no login bound", async () => {
      const email = address()
      const created = await invite(olivia, {
        email,
        fullName: "Project Colleague",
        roleId: a.roles.viewer.id,
        projectIds: [a.projects.harbor.id, a.projects.cairo.id],
      })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.status, "invited")
      assert.equal(created.allProjects, false)
      assert.equal(created.serviceProviderId, null)
      assert.equal(created.primaryAdministrator, false)
      assert.equal(created.deactivatedAt, null)
      assert.equal(created.createdAt, created.updatedAt)
      assert.deepEqual([...created.projectIds].sort(), [a.projects.harbor.id, a.projects.cairo.id].sort())
      assert.deepEqual(await accessRows(created.id), {
        projects: [a.projects.harbor.id, a.projects.cairo.id].sort(),
        providers: [],
      })
      assert.deepEqual(await one(olivia, created.id), created, "and it is there on the next read")
    })

    test("invites a company user into every project", async () => {
      const created = await invite(olivia, { email: address(), fullName: "Everywhere", roleId: a.roles.administrator.id, allProjects: true })
      assert.equal(created.allProjects, true)
      assert.deepEqual(created.projectIds, [], "all_projects is the account's own column, not five rows")
      assert.deepEqual(await accessRows(created.id), { projects: [], providers: [] })
    })

    test("invites a provider user: its provider, one Service Provider Access, and no Project Access", async () => {
      const created = await invite(olivia, {
        email: address(),
        fullName: "Provider Colleague",
        roleId: a.roles.providerManager.id,
        serviceProviderId: a.serviceProviders.cityhaul.id,
      })
      assert.equal(created.serviceProviderId, a.serviceProviders.cityhaul.id)
      assert.equal(created.allProjects, false)
      assert.deepEqual(created.projectIds, [])
      assert.deepEqual(await accessRows(created.id), { projects: [], providers: [a.serviceProviders.cityhaul.id] })
    })

    test("lowercases the address before the database sees it: the check there is the backstop", async () => {
      const email = address()
      const created = await invite(olivia, { email: email.toUpperCase(), fullName: "Shouty", roleId: a.roles.viewer.id, allProjects: true })
      assert.equal(created.email, email)
    })

    test("writes one row for a project named twice", async () => {
      const created = await invite(olivia, {
        email: address(),
        fullName: "Repeater",
        roleId: a.roles.viewer.id,
        projectIds: [a.projects.copenhagen.id, a.projects.copenhagen.id],
      })
      assert.deepEqual(created.projectIds, [a.projects.copenhagen.id])
      assert.deepEqual((await accessRows(created.id)).projects, [a.projects.copenhagen.id])
    })

    test("refuses a body that names no way of reaching anything, two of them, or three", async () => {
      const body = { email: address(), fullName: "Nowhere", roleId: a.roles.viewer.id }
      for (const access of [
        {},
        { allProjects: true, projectIds: [a.projects.cairo.id] },
        { projectIds: [a.projects.cairo.id], serviceProviderId: a.serviceProviders.nordren.id },
        { allProjects: true, projectIds: [a.projects.cairo.id], serviceProviderId: a.serviceProviders.nordren.id },
      ]) {
        const response = await olivia("/users", { method: "POST", body: { ...body, ...access } })
        assert.equal(response.status, 400, JSON.stringify(access))
        const problem = await readProblem(response)
        assert.equal(problem.detail, "The request body is invalid")
        assert.deepEqual(problem.errors?.map((error) => error.path), [""], JSON.stringify(access))
        assert.match(problem.errors?.[0].message ?? "", /exactly one/)
      }
    })

    test("refuses `allProjects: false`, naming it: absent is how a caller says no", async () => {
      const response = await olivia("/users", {
        method: "POST",
        body: { email: address(), fullName: "False", roleId: a.roles.viewer.id, allProjects: false },
      })
      assert.equal(response.status, 400)
      assert.deepEqual((await readProblem(response)).errors?.map((error) => error.path), ["allProjects"])
    })

    test("refuses a role, a project or a provider that is not this company's, naming the field, and writes nothing", async () => {
      const before_ = (await page(olivia, "?limit=200")).items.length
      const cases: [Record<string, unknown>, string][] = [
        [{ roleId: b.roles.administrator.id, allProjects: true }, "roleId"],
        [{ roleId: a.roles.viewer.id, projectIds: [a.projects.cairo.id, b.projects.harbor.id] }, "projectIds.1"],
        [{ roleId: a.roles.viewer.id, projectIds: [testId()] }, "projectIds.0"],
        // The path counts in the body's own list, repeats and all.
        [{ roleId: a.roles.viewer.id, projectIds: [a.projects.cairo.id, a.projects.cairo.id, testId()] }, "projectIds.2"],
        [{ roleId: a.roles.providerManager.id, serviceProviderId: b.serviceProviders.nordren.id }, "serviceProviderId"],
      ]
      for (const [values, path] of cases) {
        const response = await olivia("/users", { method: "POST", body: { email: address(), fullName: "Unknown reference", ...values } })
        assert.equal(response.status, 400, path)
        const problem = await readProblem(response)
        assert.deepEqual(problem.errors?.map((error) => error.path), [path], JSON.stringify(values))
      }
      assert.equal((await page(olivia, "?limit=200")).items.length, before_)
    })

    test("refuses an address the company already uses, whatever its case, and writes nothing", async () => {
      const before_ = (await page(olivia, "?limit=200")).items.length
      const response = await olivia("/users", {
        method: "POST",
        body: { email: a.users.lars.email.toUpperCase(), fullName: "Twice", roleId: a.roles.viewer.id, allProjects: true },
      })
      assert.equal(response.status, 409)
      const problem = await readProblem(response)
      assert.equal(problem.title, "Conflict")
      assert.match(problem.detail ?? "", new RegExp(a.users.lars.email))
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await page(olivia, "?limit=200")).items.length, before_)
    })

    test("lets another company use the same address: it is unique inside a company", async () => {
      const email = address()
      await invite(olivia, { email, fullName: "Shared address", roleId: a.roles.viewer.id, allProjects: true })
      assert.equal((await invite(third, { email, fullName: "Shared address", roleId: c.roles.viewer.id, allProjects: true })).email, email)
    })

    test("refuses a role that may view but not create", async () => {
      const body = { email: address(), fullName: "Not mine to invite", roleId: a.roles.viewer.id, allProjects: true }
      const refused = await viewer("/users", { method: "POST", body })
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /create on configure\.access/)
      assert.equal((await lars("/users", { method: "POST", body })).status, 403)
    })
  })

  describe("GET /users/:id", () => {
    test("answers one account of the caller's company", async () => {
      const found = await one(olivia, a.users.viewer.id)
      assert.equal(found.email, a.users.viewer.email)
      assert.deepEqual(found.projectIds, [a.projects.copenhagen.id])
    })

    test("answers 404 for another company's account, an id nobody minted, and 400 for a path that is not an id", async () => {
      const response = await olivia(`/users/${b.users.olivia.id}`)
      assert.equal(response.status, 404)
      assert.match((await readProblem(response)).detail ?? "", /user/i)
      assert.equal((await one(other, b.users.olivia.id)).email, b.users.olivia.email, "and it is still there for its own company")
      assert.equal((await olivia(`/users/${testId()}`)).status, 404)
      const malformed = await olivia("/users/not-a-uuid")
      assert.equal(malformed.status, 400)
      assert.deepEqual((await readProblem(malformed)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /users/:id", () => {
    test("changes the name and the role, and leaves the access alone", async () => {
      const created = await invite(olivia, {
        email: address(),
        fullName: "Before",
        roleId: a.roles.viewer.id,
        projectIds: [a.projects.copenhagen.id],
      })
      const patched = await patch(olivia, created.id, { fullName: "After", roleId: a.roles.administrator.id })
      assert.equal(patched.fullName, "After")
      assert.equal(patched.roleId, a.roles.administrator.id)
      assert.deepEqual(patched.projectIds, [a.projects.copenhagen.id], "an untouched access is an unchanged access")
      assert.ok(patched.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), patched)
    })

    test("swaps a company user for a provider user and back, rewriting the rows each way", async () => {
      const created = await invite(olivia, {
        email: address(),
        fullName: "Swapper",
        roleId: a.roles.viewer.id,
        projectIds: [a.projects.copenhagen.id, a.projects.harbor.id],
      })

      const provider = await patch(olivia, created.id, { serviceProviderId: a.serviceProviders.nordren.id })
      assert.equal(provider.serviceProviderId, a.serviceProviders.nordren.id)
      assert.equal(provider.allProjects, false)
      assert.deepEqual(provider.projectIds, [])
      assert.deepEqual(await accessRows(created.id), { projects: [], providers: [a.serviceProviders.nordren.id] })

      const back = await patch(olivia, created.id, { projectIds: [a.projects.cairo.id] })
      assert.equal(back.serviceProviderId, null, "the account no longer belongs to a provider")
      assert.deepEqual(back.projectIds, [a.projects.cairo.id])
      assert.deepEqual(await accessRows(created.id), { projects: [a.projects.cairo.id], providers: [] })

      const everywhere = await patch(olivia, created.id, { allProjects: true })
      assert.equal(everywhere.allProjects, true)
      assert.deepEqual(everywhere.projectIds, [])
      assert.deepEqual(await accessRows(created.id), { projects: [], providers: [] })
    })

    test("swaps one provider for another, moving the access row with the account", async () => {
      const created = await invite(olivia, {
        email: address(),
        fullName: "Moves provider",
        roleId: a.roles.providerManager.id,
        serviceProviderId: a.serviceProviders.nordren.id,
      })
      const moved = await patch(olivia, created.id, { serviceProviderId: a.serviceProviders.cityhaul.id })
      assert.equal(moved.serviceProviderId, a.serviceProviders.cityhaul.id)
      assert.deepEqual(await accessRows(created.id), { projects: [], providers: [a.serviceProviders.cityhaul.id] })
    })

    test("refuses to re-role or to narrow the primary administrator, and leaves the account as it was", async () => {
      const cases: [Record<string, unknown>, RegExp][] = [
        [{ roleId: a.roles.viewer.id }, /role/i],
        [{ projectIds: [a.projects.copenhagen.id] }, /project/i],
        [{ serviceProviderId: a.serviceProviders.nordren.id }, /provider/i],
      ]
      for (const [body, sentence] of cases) {
        const response = await olivia(`/users/${a.users.olivia.id}`, { method: "PATCH", body })
        assert.equal(response.status, 409, JSON.stringify(body))
        const problem = await readProblem(response)
        assert.match(problem.detail ?? "", /primary administrator/i, JSON.stringify(body))
        assert.match(problem.detail ?? "", sentence)
      }
      const unchanged = await one(olivia, a.users.olivia.id)
      assert.equal(unchanged.roleId, a.roles.administrator.id)
      assert.equal(unchanged.allProjects, true)
      assert.deepEqual(unchanged.projectIds, [])
      assert.deepEqual(await accessRows(a.users.olivia.id), { projects: [], providers: [] })
    })

    test("lets the primary administrator be renamed, and lets a patch restate the access it already has", async () => {
      const renamed = await patch(olivia, a.users.olivia.id, { fullName: "Olivia L. Larsen", allProjects: true })
      assert.equal(renamed.fullName, "Olivia L. Larsen")
      assert.equal(renamed.allProjects, true)
      assert.equal(renamed.primaryAdministrator, true)
      await patch(olivia, a.users.olivia.id, { fullName: "Olivia Larsen" })
    })

    test("refuses a role, a project or a provider that is not this company's, an empty patch, and two ways of reaching something", async () => {
      const created = await invite(olivia, { email: address(), fullName: "Patch me", roleId: a.roles.viewer.id, allProjects: true })
      const unknown = await olivia(`/users/${created.id}`, { method: "PATCH", body: { roleId: b.roles.viewer.id } })
      assert.equal(unknown.status, 400)
      assert.deepEqual((await readProblem(unknown)).errors?.map((error) => error.path), ["roleId"])

      const empty = await olivia(`/users/${created.id}`, { method: "PATCH", body: {} })
      assert.equal(empty.status, 400)
      assert.deepEqual((await readProblem(empty)).errors?.map((error) => error.path), [""])

      const both = await olivia(`/users/${created.id}`, {
        method: "PATCH",
        body: { projectIds: [a.projects.cairo.id], serviceProviderId: a.serviceProviders.nordren.id },
      })
      assert.equal(both.status, 400)
      assert.match((await readProblem(both)).errors?.[0].message ?? "", /at most one/)

      const derived = await olivia(`/users/${created.id}`, { method: "PATCH", body: { status: "active" } })
      assert.equal(derived.status, 400)
      assert.ok((await readProblem(derived)).errors?.some((error) => /status/.test(error.message)))

      // The access half is checked before a row is touched, so an unknown
      // member of it is named by its place and the old access still stands.
      const unknownProject = await olivia(`/users/${created.id}`, {
        method: "PATCH",
        body: { projectIds: [a.projects.cairo.id, testId()] },
      })
      assert.equal(unknownProject.status, 400)
      assert.deepEqual((await readProblem(unknownProject)).errors?.map((error) => error.path), ["projectIds.1"])

      const foreignProvider = await olivia(`/users/${created.id}`, {
        method: "PATCH",
        body: { serviceProviderId: b.serviceProviders.nordren.id },
      })
      assert.equal(foreignProvider.status, 400)
      assert.deepEqual((await readProblem(foreignProvider)).errors?.map((error) => error.path), ["serviceProviderId"])

      assert.deepEqual(await one(olivia, created.id), created, "six refusals and nothing changed")
      assert.deepEqual(await accessRows(created.id), { projects: [], providers: [] }, "the account still reaches every project")
    })

    test("answers 404 for another company's account and leaves it alone, and 403 for a role that may only view", async () => {
      const missing = await olivia(`/users/${b.users.viewer.id}`, { method: "PATCH", body: { fullName: "Mine now" } })
      assert.equal(missing.status, 404)
      await readProblem(missing)
      assert.equal((await one(other, b.users.viewer.id)).fullName, "Vera Viewer")

      const refused = await viewer(`/users/${a.users.viewer.id}`, { method: "PATCH", body: { fullName: "Not mine" } })
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /edit on configure\.access/)
    })
  })

  describe("POST /users/:id/deactivate and /reactivate", () => {
    const switchOff = (call: Call, id: string) => call(`/users/${id}/deactivate`, { method: "POST" })
    const switchOn = (call: Call, id: string) => call(`/users/${id}/reactivate`, { method: "POST" })

    test("walks an account through invited, active, deactivated and active again", async () => {
      const created = await invite(olivia, { email: address(), fullName: "Lifecycle", roleId: a.roles.viewer.id, allProjects: true })
      assert.equal(created.status, "invited")

      await bindLogin(created.id)
      assert.equal((await one(olivia, created.id)).status, "active", "the hook bound a login on first sign-in")

      const off = await switchOff(olivia, created.id)
      assert.equal(off.status, 200)
      const deactivated = User.parse(await off.json())
      assert.equal(deactivated.status, "deactivated")
      assert.notEqual(deactivated.deactivatedAt, null)
      assert.deepEqual(await one(olivia, created.id), deactivated)

      const on = await switchOn(olivia, created.id)
      assert.equal(on.status, 200)
      const reactivated = User.parse(await on.json())
      assert.equal(reactivated.status, "active")
      assert.equal(reactivated.deactivatedAt, null)
      assert.equal(reactivated.roleId, created.roleId, "deactivating touched neither the role nor the access")
      assert.equal(reactivated.allProjects, true)
    })

    test("keeps a deactivated account out of the invited ones, whether or not a login was ever bound", async () => {
      const created = await invite(olivia, { email: address(), fullName: "Never signed in", roleId: a.roles.viewer.id, allProjects: true })
      const off = User.parse(await (await switchOff(olivia, created.id)).json())
      assert.equal(off.status, "deactivated", "deactivated wins over invited")
      const on = User.parse(await (await switchOn(olivia, created.id)).json())
      assert.equal(on.status, "invited", "and reactivating gives back the invitation")
    })

    test("answers the account as it stands when it is already in that state: both are idempotent", async () => {
      const created = await invite(olivia, { email: address(), fullName: "Twice off", roleId: a.roles.viewer.id, allProjects: true })
      const first = User.parse(await (await switchOff(olivia, created.id)).json())
      const again = await switchOff(olivia, created.id)
      assert.equal(again.status, 200)
      assert.deepEqual(User.parse(await again.json()), first, "the instant it was switched off does not move")

      const on = User.parse(await (await switchOn(olivia, created.id)).json())
      const onAgain = await switchOn(olivia, created.id)
      assert.equal(onAgain.status, 200)
      assert.deepEqual(User.parse(await onAgain.json()), on)
    })

    test("refuses to deactivate the primary administrator, who stays active", async () => {
      const response = await switchOff(olivia, a.users.olivia.id)
      assert.equal(response.status, 409)
      const problem = await readProblem(response)
      assert.match(problem.detail ?? "", /primary administrator/i)
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      assert.equal((await one(olivia, a.users.olivia.id)).status, "active")
    })

    test("answers 404 for another company's account, 403 for a role that may only view, and 401 without a token", async () => {
      assert.equal((await switchOff(olivia, b.users.viewer.id)).status, 404)
      assert.equal((await one(other, b.users.viewer.id)).status, "active", "and it is still active for its own company")
      assert.equal((await switchOff(olivia, testId())).status, 404)

      const refused = await switchOff(viewer, a.users.invited.id)
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /edit on configure\.access/)
      assert.equal((await app.request(`/users/${a.users.invited.id}/deactivate`, { method: "POST" })).status, 401)
      assert.equal((await one(olivia, a.users.invited.id)).status, "invited")
    })
  })

  describe("POST /users/:id/make-primary-administrator", () => {
    const transfer = (call: Call, id: string) => call(`/users/${id}/make-primary-administrator`, { method: "POST" })

    /** The accounts of the company that carry the flag, read as the API role would; the index allows one. */
    const holders = (companyId = a.companyId) =>
      withCompany(pool.db, companyId, async (tx) =>
        (
          await tx
            .select({ id: userAccount.id })
            .from(userAccount)
            .where(and(eq(userAccount.companyId, companyId), eq(userAccount.primaryAdministrator, true)))
        ).map((row) => row.id),
      )

    /** An active company account that reaches every project: what the flag may move to. */
    const successor = async (fullName: string) => {
      const created = await invite(olivia, { email: address(), fullName, roleId: a.roles.administrator.id, allProjects: true })
      await bindLogin(created.id)
      return created
    }

    test("moves the flag to an active company account and takes it off the one that held it", async () => {
      const next = await successor("Successor")
      const response = await transfer(olivia, next.id)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      const moved = User.parse(await response.json())
      assert.equal(moved.id, next.id)
      assert.equal(moved.primaryAdministrator, true)
      assert.ok(moved.updatedAt > next.updatedAt, "the write moved the stamp")
      assert.deepEqual(await one(olivia, next.id), moved, "and it is so on the next read")
      assert.equal((await one(olivia, a.users.olivia.id)).primaryAdministrator, false, "the flag left the account that held it")
      assert.deepEqual(await holders(), [next.id], "exactly one account carries it")

      // Back again, so the rest of the file finds the tenant as it was seeded.
      const back = await transfer(olivia, a.users.olivia.id)
      assert.equal(back.status, 200)
      assert.equal(User.parse(await back.json()).primaryAdministrator, true)
      assert.equal((await one(olivia, next.id)).primaryAdministrator, false)
      assert.deepEqual(await holders(), [a.users.olivia.id])
    })

    test("answers the account as it stands when it already is the primary administrator: the command is idempotent", async () => {
      const before_ = await one(olivia, a.users.olivia.id)
      const again = await transfer(olivia, a.users.olivia.id)
      assert.equal(again.status, 200)
      assert.deepEqual(User.parse(await again.json()), before_, "nothing moved, the stamp included")
    })

    test("frees the account that held it: a former primary administrator can be deactivated", async () => {
      const next = await successor("Departing")
      assert.equal((await transfer(olivia, next.id)).status, 200)
      const refused = await olivia(`/users/${next.id}/deactivate`, { method: "POST" })
      assert.equal(refused.status, 409, "the flag protects whoever carries it now")
      assert.equal((await transfer(olivia, a.users.olivia.id)).status, 200)
      const off = await olivia(`/users/${next.id}/deactivate`, { method: "POST" })
      assert.equal(off.status, 200)
      assert.equal(User.parse(await off.json()).status, "deactivated")
    })

    test("serialises two transfers at once, so the index that allows one never fires and one account holds the flag", async () => {
      const [x, y] = await Promise.all([successor("First at once"), successor("Second at once")])
      const responses = await Promise.all([transfer(olivia, x.id), transfer(olivia, y.id)])
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200],
        JSON.stringify(await Promise.all(responses.map((response) => response.clone().json()))),
      )
      const left = await holders()
      assert.equal(left.length, 1, "one account carries the flag")
      assert.ok([x.id, y.id].includes(left[0]), "and it is one of the two")
      assert.equal((await transfer(olivia, a.users.olivia.id)).status, 200)
      assert.deepEqual(await holders(), [a.users.olivia.id])
    })

    /**
     * A transfer held still in the middle: the two locks the route takes, the
     * flag moved, the transaction kept open while `request` is sent in — so a
     * second request meets a transfer it cannot yet see, which is what two
     * requests a moment apart look like from inside. The transfer commits a
     * moment after the request has been sent, and the request's answer is
     * what it made of that.
     */
    const duringTransferTo = async (id: string, request: () => Promise<Response>): Promise<Response> => {
      let written!: () => void
      let release!: () => void
      const hasWritten = new Promise<void>((resolve) => (written = resolve))
      const held = new Promise<void>((resolve) => (release = resolve))
      const inFlight = withCompany(pool.db, a.companyId, async (tx) => {
        await tx.select({ id: company.id }).from(company).where(and(eq(company.companyId, a.companyId), eq(company.id, a.companyId))).for("update")
        await tx.select({ id: userAccount.id }).from(userAccount).where(and(eq(userAccount.companyId, a.companyId), eq(userAccount.id, id))).for("update")
        await tx
          .update(userAccount)
          .set({ primaryAdministrator: false })
          .where(and(eq(userAccount.companyId, a.companyId), eq(userAccount.primaryAdministrator, true)))
        await tx.update(userAccount).set({ primaryAdministrator: true }).where(and(eq(userAccount.companyId, a.companyId), eq(userAccount.id, id)))
        written()
        await held
      })
      await hasWritten
      const pending = request()
      await new Promise((resolve) => setTimeout(resolve, 100))
      release()
      await inFlight
      return await pending
    }

    test("makes a deactivation or a narrowing of the account a transfer is moving the flag to wait for the transfer, and then refuses it", async () => {
      const next = await successor("Contended")

      const off = await duringTransferTo(next.id, () => olivia(`/users/${next.id}/deactivate`, { method: "POST" }))
      assert.equal(off.status, 409, "read before the transfer's lock, the account was nobody special; read after it, it is the primary administrator")
      assert.match((await readProblem(off)).detail ?? "", /primary administrator/i)
      assert.equal((await one(olivia, next.id)).status, "active")
      assert.equal((await transfer(olivia, a.users.olivia.id)).status, 200)

      const narrowed = await duringTransferTo(next.id, () => olivia(`/users/${next.id}`, { method: "PATCH", body: { projectIds: [a.projects.cairo.id] } }))
      assert.equal(narrowed.status, 409)
      assert.match((await readProblem(narrowed)).detail ?? "", /every project/i)
      const still = await one(olivia, next.id)
      assert.equal(still.allProjects, true, "the primary administrator still reaches every project")
      assert.equal(still.primaryAdministrator, true)
      assert.equal((await transfer(olivia, a.users.olivia.id)).status, 200)
      assert.deepEqual(await holders(), [a.users.olivia.id])
    })

    test("refuses a deactivated account, an invited one nobody has signed in as, a service provider's, and one reaching some projects only, each with its own sentence, and moves nothing", async () => {
      const cases: [string, RegExp][] = [
        [a.users.deactivated.id, /deactivated/i],
        [a.users.invited.id, /signed in/i],
        [a.users.lars.id, /service provider/i],
        [a.users.viewer.id, /every project/i],
      ]
      for (const [id, sentence] of cases) {
        const response = await transfer(olivia, id)
        assert.equal(response.status, 409, id)
        const problem = await readProblem(response)
        assert.match(problem.detail ?? "", /primary administrator/i, id)
        assert.match(problem.detail ?? "", sentence, id)
        assert.doesNotMatch(problem.detail ?? "", /_idx|_key/)
        assert.equal((await one(olivia, id)).primaryAdministrator, false, id)
      }
      assert.deepEqual(await holders(), [a.users.olivia.id])
    })

    test("answers 404 for another company's account and leaves it alone, 403 for a role that may only view, and 401 without a token", async () => {
      assert.equal((await transfer(olivia, b.users.olivia.id)).status, 404)
      assert.equal((await transfer(olivia, b.users.viewer.id)).status, 404)
      assert.deepEqual(await holders(b.companyId), [b.users.olivia.id], "the other company's flag did not move")
      assert.equal((await transfer(olivia, testId())).status, 404)

      const refused = await transfer(viewer, a.users.viewer.id)
      assert.equal(refused.status, 403)
      assert.match((await readProblem(refused)).detail ?? "", /edit on configure\.access/)
      assert.equal((await app.request(`/users/${a.users.viewer.id}/make-primary-administrator`, { method: "POST" })).status, 401)
      assert.deepEqual(await holders(), [a.users.olivia.id])
    })
  })
})
