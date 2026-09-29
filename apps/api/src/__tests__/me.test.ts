import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { Me } from "@waste/contracts/me"
import { BLANK_PROBLEM_TYPE, NO_ACTIVE_ACCOUNT } from "@waste/contracts/problem"
import { createDb, type Database } from "@waste/db/client"
import { driver } from "@waste/db/schema/fleet"
import { company, project } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { and, eq, inArray } from "drizzle-orm"
import { Hono } from "hono"

import { createApp } from "../app"
import { authenticate, resolvePrincipal, type AuthEnv } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { errorHandler, problem } from "../problem"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Account, type Tenant } from "./tenant"
import { signingKeys, signToken, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

describe("the request path against the database", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  /** Tenant A's driver profiles: the viewer's, active, and Lars's, inactive; Olivia has none. */
  const drivers = { viewer: testId(), lars: testId() }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await withCompany(pool.db, a.companyId, (tx) =>
      tx.insert(driver).values([
        { id: drivers.viewer, companyId: a.companyId, projectId: a.projects.copenhagen.id, name: "Vera Viewer", employment: "employee", userAccountId: a.users.viewer.id, status: "active" },
        {
          id: drivers.lars,
          companyId: a.companyId,
          projectId: a.projects.copenhagen.id,
          name: "Lars Mikkelsen",
          employment: "service-provider",
          serviceProviderId: a.serviceProviders.nordren.id,
          userAccountId: a.users.lars.id,
          status: "inactive",
        },
      ]),
    )
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  /** A token for an account of a tenant, or for this login in another company. */
  const tokenFor = (account: Account, companyId: string) => {
    if (account.authUserId === null) throw new Error(`${account.email} has never signed in`)
    return signToken(keys, { sub: account.authUserId, companyId, email: account.email })
  }
  const get = async (path: string, token: string, hono: { request: (typeof app)["request"] } = app) =>
    hono.request(path, { headers: { authorization: `Bearer ${token}` } })

  const grants = (list: readonly { moduleKey: string; actions: readonly string[] }[]) =>
    list.map((grant) => ({ moduleKey: grant.moduleKey, actions: [...grant.actions] }))

  describe("GET /me", () => {
    test("answers Olivia's shape: administrator, every project of the company, no service provider", async () => {
      const response = await get("/me", await tokenFor(a.users.olivia, a.companyId))
      assert.equal(response.status, 200)
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
      const body = Me.parse(await response.json())
      assert.deepEqual(body, {
        user: {
          id: a.users.olivia.id,
          email: a.users.olivia.email,
          fullName: "Olivia Larsen",
          status: "active",
          allProjects: true,
          primaryAdministrator: true,
        },
        company: { id: a.companyId, name: a.name },
        role: {
          id: a.roles.administrator.id,
          key: "company-administrator",
          name: "Company Administrator",
          scope: "Company",
          system: true,
          grants: grants(a.roles.administrator.grants),
        },
        projects: [a.projects.cairo, a.projects.copenhagen, a.projects.harbor],
        serviceProvider: null,
        driver: null,
      })
      assert.equal(body.role.grants.length, 50, "the administrator's charter names every module")
    })

    test("answers Lars's shape: provider manager, his provider, no projects", async () => {
      const response = await get("/me", await tokenFor(a.users.lars, a.companyId))
      assert.equal(response.status, 200)
      const body = Me.parse(await response.json())
      assert.deepEqual(body, {
        user: {
          id: a.users.lars.id,
          email: a.users.lars.email,
          fullName: "Lars Mikkelsen",
          status: "active",
          allProjects: false,
          primaryAdministrator: false,
        },
        company: { id: a.companyId, name: a.name },
        role: {
          id: a.roles.providerManager.id,
          key: "service-provider-manager",
          name: "Service Provider Manager",
          scope: "Own service provider",
          system: true,
          grants: grants(a.roles.providerManager.grants),
        },
        projects: [],
        serviceProvider: a.serviceProviders.nordren,
        driver: null,
      })
    })

    test("answers a viewer's shape: a custom role with no key, one grant, and the one project of her Project Access", async () => {
      const response = await get("/me", await tokenFor(a.users.viewer, a.companyId))
      assert.equal(response.status, 200)
      const body = Me.parse(await response.json())
      assert.equal(body.role.key, null)
      assert.equal(body.role.system, false)
      assert.deepEqual(body.role.grants, [{ moduleKey: "configure.access", actions: ["view"] }])
      assert.deepEqual(body.projects, [a.projects.copenhagen])
      assert.equal(body.serviceProvider, null)
    })

    test("answers the other tenant's Olivia her own company: two tenants on one database never meet", async () => {
      const body = Me.parse(await (await get("/me", await tokenFor(b.users.olivia, b.companyId))).json())
      assert.equal(body.company.id, b.companyId)
      assert.equal(body.company.name, b.name)
      assert.equal(body.user.id, b.users.olivia.id)
      assert.deepEqual(
        body.projects.map((p) => p.id),
        [b.projects.cairo.id, b.projects.copenhagen.id, b.projects.harbor.id],
      )
    })
  })

  describe("GET /me names the active driver profile bound to the account", () => {
    const driverOf = async (account: Account) => Me.parse(await (await get("/me", await tokenFor(account, a.companyId))).json()).driver
    const setStatus = (id: string, status: string) =>
      withCompany(pool.db, a.companyId, (tx) => tx.update(driver).set({ status }).where(and(eq(driver.companyId, a.companyId), eq(driver.id, id))))

    test("by its id, for an account an active profile is bound to", async () => {
      assert.deepEqual(await driverOf(a.users.viewer), { id: drivers.viewer })
    })

    test("as null for an account no profile is bound to", async () => {
      assert.equal(await driverOf(a.users.olivia), null)
    })

    test("as null for a profile that is inactive or suspended, and by its id again once it is active", async () => {
      try {
        assert.equal(await driverOf(a.users.lars), null, "inactive")
        await setStatus(drivers.lars, "suspended")
        assert.equal(await driverOf(a.users.lars), null, "suspended")
        await setStatus(drivers.lars, "active")
        assert.deepEqual(await driverOf(a.users.lars), { id: drivers.lars }, "active: the status decides, not the binding")
      } finally {
        await setStatus(drivers.lars, "inactive")
      }
    })

    test("as null for the other tenant's accounts, whose company binds no profile", async () => {
      const body = Me.parse(await (await get("/me", await tokenFor(b.users.viewer, b.companyId))).json())
      assert.equal(body.driver, null)
    })
  })

  describe("GET /me refused with 403, of the account's own kind", () => {
    // The kind is what a client ends its session on (Issue #150), so each of
    // the principal's refusals must carry it, with the sentence that says which.
    const forbidden = async (token: string, why: string) => {
      const response = await get("/me", token)
      assert.equal(response.status, 403, why)
      assert.equal(response.headers.get("www-authenticate"), null, why)
      const body = await readProblem(response, NO_ACTIVE_ACCOUNT)
      assert.match(body.detail ?? "", /account/, why)
      return body
    }

    test("for a token that names no company: the hook found no account for the login", async () => {
      const body = await forbidden(await signToken(keys, { sub: randomUUID() }), "no company claim")
      assert.equal(body.detail, "The token names no company: this login has no account here")
    })

    test("for a login no account is bound to", async () => {
      const body = await forbidden(await signToken(keys, { sub: randomUUID(), companyId: a.companyId }), "unknown sub")
      assert.equal(body.detail, "No active account in this company is bound to this login")
    })

    // A `sub` of "" is a token that names no subject at all, and verify.ts
    // refuses that as a 401 before any of this; these are tokens that name one.
    test("for a `sub` that is not a UUID at all: the same refusal, never a 500 from the uuid column", async () => {
      for (const sub of ["not-a-uuid", "01a0d3a5", "'; drop table wms.user_account; --"]) {
        await forbidden(await signToken(keys, { sub, companyId: a.companyId }), JSON.stringify(sub))
      }
    })

    test("for a deactivated account", async () => {
      await forbidden(await tokenFor(a.users.deactivated, a.companyId), "deactivated")
    })

    test("for a claim naming a company the account is not in, and for a company that does not exist", async () => {
      await forbidden(await tokenFor(a.users.olivia, b.companyId), "Olivia of A in company B")
      await forbidden(await tokenFor(a.users.olivia, testId()), "a company nobody seeded")
    })

    test("an invited account has no login to sign a token for", () => {
      assert.equal(a.users.invited.authUserId, null)
    })
  })

  describe("resolvePrincipal binds the claim to the tenant itself, not through the fence", () => {
    const login = (account: Account) => {
      if (account.authUserId === null) throw new Error(`${account.email} has never signed in`)
      return account.authUserId
    }

    test("with the fence open to the account's company and the claim naming another, the account is not resolved", async () => {
      // Tenant A's rows are visible here; only the lookup's own predicate can refuse a claim for B.
      const principal = await withCompany(pool.db, a.companyId, (tx) => resolvePrincipal(tx, { userId: login(a.users.olivia), companyId: b.companyId }))
      assert.equal(principal, null)
      const own = await withCompany(pool.db, a.companyId, (tx) => resolvePrincipal(tx, { userId: login(a.users.olivia), companyId: a.companyId }))
      assert.equal(own?.company.id, a.companyId)
    })

    test("as the owner, who bypasses RLS and sees every tenant, the lookups still stay inside the claim's company", { skip: owner.skip }, async () => {
      const admin = createDb(owner.url, { max: 1 })
      try {
        await admin.db.transaction(async (tx) => {
          const visible = await tx.select({ id: company.id }).from(company).where(inArray(company.id, [a.companyId, b.companyId]))
          assert.equal(visible.length, 2, "both tenants must be visible, or this proves nothing about the predicate")

          assert.equal(await resolvePrincipal(tx, { userId: login(a.users.olivia), companyId: b.companyId }), null, "A's account under B's claim")
          assert.equal(await resolvePrincipal(tx, { userId: login(b.users.olivia), companyId: a.companyId }), null, "B's account under A's claim")

          const olivia = await resolvePrincipal(tx, { userId: login(a.users.olivia), companyId: a.companyId })
          assert.ok(olivia)
          assert.equal(olivia.companyId, a.companyId)
          assert.deepEqual(olivia.company, { id: a.companyId, name: a.name })
          assert.deepEqual(olivia.projects, [a.projects.cairo, a.projects.copenhagen, a.projects.harbor], "A's three projects and none of B's")
          assert.equal(olivia.grants.length, 50)
          assert.equal(olivia.driver, null)

          const lars = await resolvePrincipal(tx, { userId: login(a.users.lars), companyId: a.companyId })
          assert.deepEqual(lars?.serviceProvider, a.serviceProviders.nordren)
          assert.deepEqual(lars?.projects, [])
          assert.equal(lars?.driver, null, "his profile is inactive")

          const viewer = await resolvePrincipal(tx, { userId: login(a.users.viewer), companyId: a.companyId })
          assert.deepEqual(viewer?.projects, [a.projects.copenhagen], "her Project Access row and not B's viewer's")
          assert.deepEqual(viewer?.grants, [{ moduleKey: "configure.access", actions: ["view"] }])
          assert.deepEqual(viewer?.driver, { id: drivers.viewer }, "her profile, active")
          assert.equal((await resolvePrincipal(tx, { userId: login(b.users.viewer), companyId: b.companyId }))?.driver, null, "B's viewer drives under nothing of A's")
        })
      } finally {
        await admin.close()
      }
    })
  })

  describe("requireGrant and the request's transaction", () => {
    const guarded = () => {
      const guard = authenticate({ pool, verifier: keys.verifier })
      const hono = new Hono<AuthEnv>().onError(errorHandler(() => assert.fail("nothing here is a 500")))
      hono.get("/access/edit", guard, requireGrant("configure.access", "edit"), (c) => c.json({ user: c.get("principal").user.id }))
      hono.get("/access/view", guard, requireGrant("configure.access", "view"), (c) => c.json({ user: c.get("principal").user.id }))
      hono.get("/projects/count", guard, async (c) => {
        const rows = await c.get("tx").select({ id: project.id }).from(project)
        return c.json({ projects: rows.length })
      })
      hono.post("/projects/thrown", guard, async (c) => {
        await c.get("tx").insert(project).values(newProject(c.get("principal").companyId, "Thrown Away"))
        throw problem(409, { detail: "changed my mind" })
      })
      hono.post("/projects/returned", guard, async (c) => {
        await c.get("tx").insert(project).values(newProject(c.get("principal").companyId, "Returned Away"))
        return c.json({ type: "about:blank", title: "Bad Request", status: 400 }, 400)
      })
      hono.post("/projects/kept", guard, async (c) => {
        await c.get("tx").insert(project).values(newProject(c.get("principal").companyId, "Kept"))
        return c.json({ ok: true }, 201)
      })
      return hono
    }
    const newProject = (companyId: string, name: string): typeof project.$inferInsert => ({
      id: testId(),
      companyId,
      name,
      kind: "Contract",
      language: "da",
      currency: "DKK",
      timezone: "Europe/Copenhagen",
      status: "onboarding",
    })
    const projectNamed = (companyId: string, name: string) =>
      withCompany(pool.db, companyId, (tx) =>
        tx
          .select({ id: project.id })
          .from(project)
          .where(and(eq(project.companyId, companyId), eq(project.name, name))),
      )

    test("passes a caller whose role grants the action on the module, and refuses one whose role does not, naming both", async () => {
      const hono = guarded()
      const olivia = await tokenFor(a.users.olivia, a.companyId)
      const viewer = await tokenFor(a.users.viewer, a.companyId)
      assert.equal((await get("/access/edit", olivia, hono)).status, 200)
      assert.equal((await get("/access/view", viewer, hono)).status, 200)
      const refused = await get("/access/edit", viewer, hono)
      assert.equal(refused.status, 403)
      const body = await readProblem(refused)
      assert.match(body.detail ?? "", /configure\.access/)
      assert.match(body.detail ?? "", /edit/)
      // A permission refusal leaves the account alone, so a client keeps its session.
      assert.equal(body.type, BLANK_PROBLEM_TYPE, "about:blank, never the account's kind")
      assert.equal(body.title, "Forbidden")
    })

    test("hands the handler a transaction that sees the caller's company and nothing else", async () => {
      const hono = guarded()
      const response = await get("/projects/count", await tokenFor(a.users.olivia, a.companyId), hono)
      assert.deepEqual(await response.json(), { projects: 3 })
    })

    test("rolls the transaction back when the handler throws, and when it answers with an error without throwing", async () => {
      const hono = guarded()
      const token = await tokenFor(a.users.olivia, a.companyId)
      const thrown = await hono.request("/projects/thrown", { method: "POST", headers: { authorization: `Bearer ${token}` } })
      assert.equal(thrown.status, 409)
      assert.equal((await readProblem(thrown)).detail, "changed my mind")
      assert.deepEqual(await projectNamed(a.companyId, "Thrown Away"), [])
      const returned = await hono.request("/projects/returned", { method: "POST", headers: { authorization: `Bearer ${token}` } })
      assert.equal(returned.status, 400)
      assert.deepEqual(await projectNamed(a.companyId, "Returned Away"), [])
    })

    test("commits what a handler wrote when it answers well", async () => {
      const hono = guarded()
      const token = await tokenFor(a.users.olivia, a.companyId)
      const kept = await hono.request("/projects/kept", { method: "POST", headers: { authorization: `Bearer ${token}` } })
      assert.equal(kept.status, 201)
      assert.equal((await projectNamed(a.companyId, "Kept")).length, 1)
    })
  })
})
