// A project's privacy policy (#291 C19): read with the project, null for
// each part until set, and replaced whole through
// `PUT /projects/:id/privacy-policy` under `edit` on `configure.privacy` —
// never through the project's own patch — within each kind's bounds, every
// change in the project's audit history.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AuditEvent } from "@waste/contracts/audit"
import { Page } from "@waste/contracts/pagination"
import { PrivacyPolicy, Project } from "@waste/contracts/organisation"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

const NO_POLICY: PrivacyPolicy = { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }
const POLICY: PrivacyPolicy = { positionRetentionDays: 14, proofRetentionDays: 365, gpsPurpose: "dispatch-and-proof" }

describe("a project's privacy policy", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  /** View and edit on the privacy module alone: may set the policy, may not patch the project. */
  let officer: Call
  /** A role without the privacy module. */
  let lars: Call
  let other: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "configure.privacy", actions: ["view", "edit"] },
      { moduleKey: "configure.organization", actions: ["view"] },
    ])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    officer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const put = (call: Call, id: string, body: unknown) => call(`/projects/${id}/privacy-policy`, { method: "PUT", body })
  const read = async (id: string) => Project.parse(await (await olivia(`/projects/${id}`)).json())

  test("a project has no policy of its own until one is set: each kind null, the deployment's setting standing", async () => {
    assert.deepEqual((await read(a.projects.copenhagen.id)).privacyPolicy, NO_POLICY)
  })

  test("is replaced whole by the privacy module's editor, answered and read back with the project, and nulled again", async () => {
    const response = await put(officer, a.projects.copenhagen.id, POLICY)
    assert.equal(response.status, 200, await response.clone().text())
    assert.deepEqual(PrivacyPolicy.parse(await response.json()), POLICY)
    assert.deepEqual((await read(a.projects.copenhagen.id)).privacyPolicy, POLICY)

    const cleared = await put(officer, a.projects.copenhagen.id, { ...POLICY, positionRetentionDays: null, gpsPurpose: null })
    assert.equal(cleared.status, 200)
    assert.deepEqual((await read(a.projects.copenhagen.id)).privacyPolicy, { ...POLICY, positionRetentionDays: null, gpsPurpose: null })
  })

  test("is in the project's audit history, column by column", async () => {
    await put(officer, a.projects.copenhagen.id, { ...NO_POLICY, proofRetentionDays: 90 })
    const history = Page(AuditEvent).parse(await (await olivia(`/audit-events?table=project&rowId=${a.projects.copenhagen.id}`)).json())
    const latest = history.items.find((event) => "proof_retention_days" in event.changed)
    assert.ok(latest !== undefined, "the change to the proofs' days is recorded")
    assert.deepEqual(latest.changed.proof_retention_days?.[1], 90)
  })

  test("refuses days outside a kind's bounds, a purpose outside the vocabulary, and a body missing a field, naming the field", async () => {
    for (const [body, path] of [
      [{ ...POLICY, positionRetentionDays: 31 }, "positionRetentionDays"],
      [{ ...POLICY, proofRetentionDays: 0 }, "proofRetentionDays"],
      [{ ...POLICY, gpsPurpose: "marketing" }, "gpsPurpose"],
      [{ positionRetentionDays: 7 }, "proofRetentionDays"],
    ] as const) {
      const response = await put(olivia, a.projects.copenhagen.id, body)
      assert.equal(response.status, 400, path)
      assert.ok((await readProblem(response)).errors?.some((error) => error.path === path), path)
    }
  })

  test("is the privacy module's to write: refused to a role without it, and never through the project's patch", async () => {
    assert.equal((await put(lars, a.projects.copenhagen.id, POLICY)).status, 403)
    const patched = await olivia(`/projects/${a.projects.copenhagen.id}`, { method: "PATCH", body: { privacyPolicy: POLICY } })
    assert.equal(patched.status, 400)
    assert.equal((await olivia(`/projects/${a.projects.copenhagen.id}`, { method: "PATCH", body: { proofRetentionDays: 30 } })).status, 400)
  })

  test("a project of another company, or none, is not there", async () => {
    assert.equal((await put(other, a.projects.copenhagen.id, POLICY)).status, 404)
    assert.equal((await put(olivia, testId(9999), POLICY)).status, 404)
  })
})
