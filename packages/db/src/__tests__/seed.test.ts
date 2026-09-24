// The demo seed (Issue #70, slice 2) against a fresh database of its own, so
// that "a clean database becomes the demo company" is what is proved and
// nothing depends on what the shared local database holds. The properties that
// matter: it writes what the spec lists, a second run writes nothing at all,
// and a row someone edited by hand goes back to what the seed says. The ids
// are fixed constants, so a hosted token opens the same company locally; their
// shape is checked without a database.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS } from "@waste/domain/access/system-roles"
import { eq, sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { projectAccess, role, roleGrant, serviceProviderAccess, userAccount } from "../schema/access"
import { company, project, serviceProvider } from "../schema/organisation"
import { DEMO_IDS, seedDemo } from "../seed/demo"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Every id the seed spells, wherever it sits in DEMO_IDS. */
function allIds(value: unknown): string[] {
  if (typeof value === "string") return [value]
  return Object.values(value as Record<string, unknown>).flatMap(allIds)
}

/** The grant rows the charters ask for: one per action of every system role. */
const expectedGrants = SYSTEM_ROLES.reduce((total, systemRole) => total + systemRole.grants.reduce((n, grant) => n + grant.actions.length, 0), 0)

describe("the demo seed's fixed ids", () => {
  test("every one is a UUID version 7 with the right variant, and no two are the same", () => {
    const ids = allIds(DEMO_IDS)
    for (const id of ids) assert.match(id, UUIDV7)
    assert.equal(new Set(ids).size, ids.length, "an id is used for two records")
  })

  test("the eleven roles have an id each, keyed by the domain's role keys", () => {
    assert.deepEqual(Object.keys(DEMO_IDS.roles), [...SYSTEM_ROLE_KEYS])
  })

  test("none of them is an id a database test owns on the shared local database", () => {
    // access-token-hook.test.ts commits rows under this company and cleans
    // them up; the seed must never write over its fixture.
    assert.ok(!allIds(DEMO_IDS).includes("018f7c2e-c000-7000-8000-000000000001"))
  })
})

describe("the demo seed against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_seed")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  /** Every seeded row, ordered, with the timestamps: two snapshots are equal only if nothing was written. */
  const snapshot = async () => {
    const rows = await Promise.all(
      [company, project, serviceProvider, role, userAccount, roleGrant, projectAccess, serviceProviderAccess].map((table) =>
        owner.db
          .select()
          .from(table)
          .orderBy(sql`id`),
      ),
    )
    return JSON.stringify(rows)
  }

  /** What the grant set is, as one string: the checksum the seed must reproduce exactly. */
  const grantChecksum = async () => {
    const [row] = await owner.sql<{ checksum: string; count: number }[]>`
      select md5(string_agg(r.key || ':' || g.module_key || ':' || g.action, ',' order by r.key, g.module_key, g.action)) as checksum,
             count(*)::int as count
      from wms.role_grant g join wms.role r on r.id = g.role_id and r.company_id = g.company_id
      where g.company_id = ${DEMO_IDS.company}`
    return row
  }

  test("a clean database becomes WasteHero Denmark: three projects, two service providers, eleven roles with their grants, two accounts", async () => {
    const report = await seedDemo(fresh.url)
    assert.equal(report.companyId, DEMO_IDS.company)
    assert.ok(report.changed > 0)
    assert.deepEqual(report.counts, {
      projects: 3,
      serviceProviders: 2,
      roles: 11,
      roleGrants: expectedGrants,
      users: 2,
      serviceProviderAccess: 1,
    })

    const [seeded] = await owner.db.select().from(company)
    assert.deepEqual(
      { ...seeded, createdAt: undefined, updatedAt: undefined },
      {
        id: DEMO_IDS.company,
        companyId: DEMO_IDS.company,
        name: "WasteHero Denmark",
        legalName: "WasteHero Denmark A/S",
        registrationNumber: "38144209",
        country: "DK",
        status: "active",
        createdAt: undefined,
        updatedAt: undefined,
      },
    )

    const projects = await owner.db.select().from(project).orderBy(project.name)
    assert.deepEqual(
      projects.map((row) => [row.id, row.name, row.kind, row.language, row.currency, row.timezone, row.status]),
      [
        [DEMO_IDS.projects.cairo, "Cairo Operations", "Municipality", "ar", "EGP", "Africa/Cairo", "active"],
        [DEMO_IDS.projects.copenhagen, "Copenhagen Central", "Municipality", "da", "DKK", "Europe/Copenhagen", "active"],
        [DEMO_IDS.projects.harbor, "Harbor Commercial", "Business unit", "da", "DKK", "Europe/Copenhagen", "onboarding"],
      ],
    )

    const providers = await owner.db.select().from(serviceProvider).orderBy(serviceProvider.legalName)
    assert.deepEqual(
      providers.map((row) => [row.id, row.legalName, row.registrationNumber, row.country, row.contactName, row.contactEmail]),
      [
        [DEMO_IDS.serviceProviders.cityhaul, "CityHaul A/S", "39122004", "DK", "Mikkel Andersen", "mikkel.andersen@cityhaul.dk"],
        [DEMO_IDS.serviceProviders.nordren, "NordRen ApS", "40291188", "DK", "Lars Mikkelsen", "lars.mikkelsen@nordren.dk"],
      ],
    )

    const roles = await owner.db.select().from(role).orderBy(role.name)
    assert.deepEqual(
      roles.map((row) => [row.key, row.name, row.scope, row.description, row.system]),
      SYSTEM_ROLES.map((systemRole) => [systemRole.key, systemRole.name, systemRole.scope, systemRole.description, true]).sort((a, b) =>
        (a[1] as string) < (b[1] as string) ? -1 : 1,
      ),
    )

    const grants = await grantChecksum()
    assert.equal(grants.count, expectedGrants)

    const accounts = await owner.db.select().from(userAccount).orderBy(userAccount.email)
    assert.deepEqual(
      accounts.map((row) => [row.id, row.email, row.fullName, row.allProjects, row.primaryAdministrator, row.serviceProviderId, row.authUserId, row.deactivatedAt]),
      [
        [DEMO_IDS.users.lars, "lars.mikkelsen@nordren.dk", "Lars Mikkelsen", false, false, DEMO_IDS.serviceProviders.nordren, null, null],
        [DEMO_IDS.users.olivia, "olivia.larsen@wastehero.io", "Olivia Larsen", true, true, null, null, null],
      ],
    )
  })

  test("Olivia works in every project and for no service provider; Lars works for NordRen and in no project", async () => {
    const [olivia] = await owner.db.select().from(userAccount).where(eq(userAccount.id, DEMO_IDS.users.olivia))
    const [lars] = await owner.db.select().from(userAccount).where(eq(userAccount.id, DEMO_IDS.users.lars))
    const roles = await owner.db.select().from(role)
    const key = (id: string) => roles.find((row) => row.id === id)?.key

    // Which projects an account reaches: all of the company's when
    // `all_projects`, otherwise exactly its project_access rows.
    const projects = await owner.db.select().from(project)
    const access = await owner.db.select().from(projectAccess)
    const reaches = (account: typeof olivia) =>
      account.allProjects ? projects.map((row) => row.id).sort() : access.filter((row) => row.userAccountId === account.id).map((row) => row.projectId).sort()

    assert.equal(key(olivia.roleId), "company-administrator")
    assert.deepEqual(reaches(olivia), Object.values(DEMO_IDS.projects).sort())
    assert.equal(olivia.serviceProviderId, null)
    assert.equal(olivia.primaryAdministrator, true)

    assert.equal(key(lars.roleId), "service-provider-manager")
    assert.deepEqual(reaches(lars), [])
    assert.equal(lars.serviceProviderId, DEMO_IDS.serviceProviders.nordren)
    const providerAccess = await owner.db.select().from(serviceProviderAccess)
    assert.deepEqual(
      providerAccess.map((row) => [row.userAccountId, row.serviceProviderId]),
      [[DEMO_IDS.users.lars, DEMO_IDS.serviceProviders.nordren]],
    )
  })

  test("a second run writes nothing: not a row, not an updated_at", async () => {
    const before = await snapshot()
    const checksum = await grantChecksum()
    const report = await seedDemo(fresh.url)
    assert.equal(report.changed, 0)
    assert.equal(await snapshot(), before)
    assert.deepEqual(await grantChecksum(), checksum)
  })

  test("what someone edited by hand goes back to what the seed says, and a grant the charter does not name is removed", async () => {
    const settled = await snapshot()
    await owner.db.update(company).set({ name: "WasteHero Sverige" }).where(eq(company.id, DEMO_IDS.company))
    await owner.db.delete(roleGrant).where(eq(roleGrant.roleId, DEMO_IDS.roles.driver))
    await owner.db.insert(roleGrant).values({
      companyId: DEMO_IDS.company,
      roleId: DEMO_IDS.roles.driver,
      moduleKey: "commercial.invoices",
      action: "delete",
    })
    await owner.db.delete(serviceProviderAccess).where(eq(serviceProviderAccess.id, DEMO_IDS.serviceProviderAccess.lars))

    const report = await seedDemo(fresh.url)
    assert.ok(report.changed > 0)
    const [restored] = await owner.db.select().from(company)
    assert.equal(restored.name, "WasteHero Denmark")
    const driverGrants = await owner.db.select().from(roleGrant).where(eq(roleGrant.roleId, DEMO_IDS.roles.driver))
    assert.deepEqual(
      driverGrants.map((row) => `${row.moduleKey}:${row.action}`).sort(),
      ["operate.driver-app:edit", "operate.driver-app:view", "route-studio.pickups:edit", "route-studio.pickups:view", "route-studio.routes:view"],
    )
    const providerAccess = await owner.db.select().from(serviceProviderAccess)
    assert.deepEqual(
      providerAccess.map((row) => [row.id, row.userAccountId, row.serviceProviderId]),
      [[DEMO_IDS.serviceProviderAccess.lars, DEMO_IDS.users.lars, DEMO_IDS.serviceProviders.nordren]],
    )
    // The grant rows were rewritten, so only the rows that were touched differ.
    assert.notEqual(await snapshot(), settled)
    assert.equal((await grantChecksum()).count, expectedGrants)
    assert.equal((await seedDemo(fresh.url)).changed, 0)
  })
})
