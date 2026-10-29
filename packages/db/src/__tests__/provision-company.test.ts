// A Company made outside the seed (C33 of #291): the rows it starts with —
// onboarding, the twelve system roles with every grant their charters name,
// the eight Decommission Reasons, its first project, and its primary
// administrator as an Invitation in every project — refused for a company the
// register knows or an address already invited elsewhere; and the seed, which
// spells the demo tenant's roles, grants and reasons through the same row
// builders, writes exactly the rows it wrote before and nothing on a run after
// another company is made beside it. Against a fresh database of its own.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { normaliseGrants } from "@waste/domain/access/grants"
import { SYSTEM_ROLES, type SystemRoleKey } from "@waste/domain/access/system-roles"
import { DEFAULT_DECOMMISSION_REASONS } from "@waste/domain/resources/decommission-reasons"
import { eq, sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { companyRegistered, defaultDecommissionReasonRows, invitationOpen, provisionCompany, systemGrantRows, systemRoleRows, type CompanyProvision } from "../commands/provision-company"
import { Refused } from "../commands/shared"
import { newId } from "../ids"
import { migrateDatabase } from "../migrate"
import { role, roleGrant, userAccount } from "../schema/access"
import { company, project } from "../schema/organisation"
import { decommissionReason } from "../schema/stock"
import { DEMO_IDS, seedDemo } from "../seed/demo"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

const COMPANY = "01a1d2a4-a280-7001-8000-0000000000aa"
const idOf = (key: SystemRoleKey) => `role-${key}`

describe("the rows a company starts with", () => {
  test("are the builders' exactly as the seed spelled them inline before: one role per charter, one grant per action, the eight reasons", () => {
    // The seed's spelling before C33, kept here to prove the builders write the same rows byte for byte.
    const roles = SYSTEM_ROLES.map((systemRole) => ({ id: idOf(systemRole.key), companyId: COMPANY, key: systemRole.key, name: systemRole.name, scope: systemRole.scope, description: systemRole.description, system: systemRole.system }))
    const grants = SYSTEM_ROLES.flatMap((systemRole) => normaliseGrants(systemRole.grants).flatMap((grant) => grant.actions.map((action) => ({ companyId: COMPANY, roleId: idOf(systemRole.key), moduleKey: grant.moduleKey, action }))))
    let n = 0
    const counted = () => `reason-${(n += 1)}`
    const reasons = DEFAULT_DECOMMISSION_REASONS.map(({ code, name }) => ({ id: counted(), companyId: COMPANY, code, name, status: "active" }))
    assert.deepEqual(systemRoleRows(COMPANY, idOf), roles)
    assert.deepEqual(systemGrantRows(COMPANY, idOf), grants)
    let m = 0
    assert.deepEqual(defaultDecommissionReasonRows(COMPANY, () => `reason-${(m += 1)}`), reasons)
    assert.equal(roles.length, 12)
    assert.equal(reasons.length, 8)
  })
})

describe("provisioning a company", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  const provision = (over: Partial<{ registrationNumber: string; email: string }> = {}): CompanyProvision => ({
    company: { name: "Fjordby Affald", legalName: "Fjordby Affald A/S", registrationNumber: over.registrationNumber ?? "87654321", country: "DK" },
    project: { name: "Fjordby Kommune", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen" },
    administrator: { email: over.email ?? "Ida.Holm@fjordby.example", fullName: "Ida Holm" },
  })

  /** Every row of the demo company's seeded tables, ordered, with the timestamps: equal only if nothing was written. */
  const demoSnapshot = async () =>
    JSON.stringify(
      await Promise.all(
        [company, project, role, roleGrant, userAccount, decommissionReason].map((table) =>
          owner.db
            .select()
            .from(table)
            .where(eq(table.companyId, DEMO_IDS.company))
            .orderBy(sql`id`),
        ),
      ),
    )

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_provision")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
    await seedDemo(fresh.url)
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  test("writes the company onboarding, its roles with every grant, its reasons, its first project and its primary administrator as an Invitation", async () => {
    const made = await provisionCompany(owner.db, provision(), newId)
    const [row] = await owner.db.select().from(company).where(eq(company.id, made.companyId))
    assert.deepEqual([row?.name, row?.status, row?.companyId], ["Fjordby Affald", "onboarding", made.companyId])
    const roles = await owner.db.select().from(role).where(eq(role.companyId, made.companyId))
    assert.deepEqual(roles.map((each) => each.key).sort(), SYSTEM_ROLES.map((each) => each.key).sort())
    const grants = await owner.db.select().from(roleGrant).where(eq(roleGrant.companyId, made.companyId))
    assert.equal(grants.length, systemGrantRows(made.companyId, (key) => made.roleIds[key]).length)
    const reasons = await owner.db.select().from(decommissionReason).where(eq(decommissionReason.companyId, made.companyId))
    assert.deepEqual(reasons.map((each) => each.code).sort(), DEFAULT_DECOMMISSION_REASONS.map((each) => each.code).sort())
    const [first] = await owner.db.select().from(project).where(eq(project.companyId, made.companyId))
    assert.deepEqual([first?.id, first?.name, first?.status, first?.timezone], [made.projectId, "Fjordby Kommune", "onboarding", "Europe/Copenhagen"])
    const [admin] = await owner.db.select().from(userAccount).where(eq(userAccount.id, made.administratorId))
    assert.deepEqual(
      [admin?.email, admin?.roleId, admin?.allProjects, admin?.primaryAdministrator, admin?.authUserId, admin?.companyId],
      ["ida.holm@fjordby.example", made.roleIds["company-administrator"], true, true, null, made.companyId],
      "an Invitation the access token hook binds on first sign-in by its address",
    )
  })

  test("refuses a company the register knows, and an address with an open invitation in any company, writing nothing", async () => {
    const companies = await owner.db.select({ id: company.id }).from(company)
    await assert.rejects(provisionCompany(owner.db, provision({ email: "someone.else@fjordby.example" }), newId), (error: unknown) => error instanceof Refused && error.status === 409 && error.message === companyRegistered("DK", "87654321"))
    await assert.rejects(provisionCompany(owner.db, provision({ registrationNumber: "11223344" }), newId), (error: unknown) => error instanceof Refused && error.status === 409 && error.message === invitationOpen("ida.holm@fjordby.example"))
    await assert.rejects(provisionCompany(owner.db, provision({ registrationNumber: "11223344", email: "mads.jensen@kystbyen.example" }), newId), (error: unknown) => error instanceof Refused, "the demo's driver is an Invitation too")
    assert.equal((await owner.db.select({ id: company.id }).from(company)).length, companies.length)
  })

  test("the seed writes nothing on a run after another company is made beside it, and the demo company's rows are what they were", async () => {
    const before = await demoSnapshot()
    const report = await seedDemo(fresh.url)
    assert.equal(report.changed, 0)
    assert.equal(await demoSnapshot(), before)
  })
})
