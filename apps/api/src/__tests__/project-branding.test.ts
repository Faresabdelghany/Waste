// A project's branding (M22 of #293): read with the project, none until set,
// and replaced whole through `PUT /projects/:id/branding` under `edit` on
// `configure.portals` — never through the project's own patch — a colour
// white text cannot be read on at WCAG 2.1 AA refused, every change in the
// project's audit history.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AuditEvent } from "@waste/contracts/audit"
import { ProjectBranding, Project } from "@waste/contracts/organisation"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

const NONE: ProjectBranding = { brandColor: null, logoUrl: null, accessibilityStatementUrl: null }
const BRANDING = { brandColor: "#1F6F3F", logoUrl: "https://kk.dk/logo.svg", accessibilityStatementUrl: "https://was.digst.dk/kk-dk" }

describe("a project's branding", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  /** View and edit on the portals module alone: may brand the project, may not patch it. */
  let portals: Call
  let lars: Call
  let other: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "configure.portals", actions: ["view", "edit"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    portals = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const put = (call: Call, id: string, body: unknown) => call(`/projects/${id}/branding`, { method: "PUT", body })
  const read = async (id: string) => Project.parse(await (await olivia(`/projects/${id}`)).json())

  test("a project has none until set", async () => {
    assert.deepEqual((await read(a.projects.copenhagen.id)).branding, NONE)
  })

  test("is replaced whole by the portals module's editor, the colour kept lowercased, read back with the project, and taken away again", async () => {
    const response = await put(portals, a.projects.copenhagen.id, BRANDING)
    assert.equal(response.status, 200, await response.clone().text())
    const expected = { ...BRANDING, brandColor: "#1f6f3f" }
    assert.deepEqual(ProjectBranding.parse(await response.json()), expected)
    assert.deepEqual((await read(a.projects.copenhagen.id)).branding, expected)
    assert.equal((await put(portals, a.projects.copenhagen.id, NONE)).status, 200)
    assert.deepEqual((await read(a.projects.copenhagen.id)).branding, NONE)
  })

  test("is in the project's audit history", async () => {
    await put(portals, a.projects.copenhagen.id, { ...NONE, logoUrl: "https://kk.dk/new-logo.svg" })
    const history = Page(AuditEvent).parse(await (await olivia(`/audit-events?table=project&rowId=${a.projects.copenhagen.id}`)).json())
    assert.ok(history.items.some((event) => event.changed.logo_url?.[1] === "https://kk.dk/new-logo.svg"))
  })

  test("refuses a colour white text cannot be read on at AA, saying the ratio, and a colour or an address of the wrong shape, naming the field", async () => {
    const light = await put(olivia, a.projects.copenhagen.id, { ...BRANDING, brandColor: "#ffd700" })
    assert.equal(light.status, 400)
    const problem = await readProblem(light)
    assert.deepEqual(problem.errors?.map((error) => error.path), ["brandColor"])
    assert.match(problem.errors?.[0]?.message ?? "", /WCAG 2\.1 AA needs 4\.5 to 1/)
    for (const [body, path] of [
      [{ ...BRANDING, brandColor: "green" }, "brandColor"],
      [{ ...BRANDING, logoUrl: "http://kk.dk/logo.svg" }, "logoUrl"],
      [{ ...BRANDING, accessibilityStatementUrl: "javascript:alert(1)" }, "accessibilityStatementUrl"],
      [{ brandColor: null }, "logoUrl"],
    ] as const) {
      const response = await put(olivia, a.projects.copenhagen.id, body)
      assert.equal(response.status, 400, path)
      assert.ok((await readProblem(response)).errors?.some((error) => error.path === path), path)
    }
  })

  test("is the portals module's to write: refused to a role without it, and never through the project's patch", async () => {
    assert.equal((await put(lars, a.projects.copenhagen.id, BRANDING)).status, 403)
    assert.equal((await olivia(`/projects/${a.projects.copenhagen.id}`, { method: "PATCH", body: { branding: BRANDING } })).status, 400)
    assert.equal((await olivia(`/projects/${a.projects.copenhagen.id}`, { method: "PATCH", body: { brandColor: "#1f6f3f" } })).status, 400)
  })

  test("a project of another company, or none, is not there", async () => {
    assert.equal((await put(other, a.projects.copenhagen.id, BRANDING)).status, 404)
    assert.equal((await put(olivia, testId(9999), BRANDING)).status, 404)
  })
})
