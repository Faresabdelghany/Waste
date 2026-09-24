// The Organisation & Access tables against Postgres (Issue #70, slice 1), on a
// fresh database of this file's own so that "migration 0002 applies to a clean
// database" is proved and nothing depends on what the shared local database
// holds: the composite keys refuse another tenant's record, the checks and
// uniques hold, and the fence on the real tables shows the API role exactly
// its company's rows in each of the eight. Every test runs as the owner in a
// transaction that is rolled back, so nothing needs cleaning up.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { eq, sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { projectAccess, role, roleGrant, serviceProviderAccess, userAccount } from "../schema/access"
import { company, project, serviceProvider } from "../schema/organisation"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBack, rolledBackIn } from "./specimen"

const database = databaseUnderTest()

/** One company's fixture ids, a nibble telling the companies apart. */
const ids = (n: "a" | "b") => ({
  company: `018f7c2e-${n}000-7000-8000-000000000001`,
  project: `018f7c2e-${n}000-7000-8000-000000000002`,
  provider: `018f7c2e-${n}000-7000-8000-000000000003`,
  role: `018f7c2e-${n}000-7000-8000-000000000004`,
  administrator: `018f7c2e-${n}000-7000-8000-000000000005`,
  providerUser: `018f7c2e-${n}000-7000-8000-000000000006`,
  grant: `018f7c2e-${n}000-7000-8000-000000000007`,
  projectAccess: `018f7c2e-${n}000-7000-8000-000000000008`,
  providerAccess: `018f7c2e-${n}000-7000-8000-000000000009`,
  /** Free for a test's own row. */
  spare: `018f7c2e-${n}000-7000-8000-00000000000e`,
})
const a = ids("a")
const b = ids("b")
const authUser = "018f7c2e-0000-7000-8000-00000000aa01"

const tables: Record<string, PgTable> = { company, project, serviceProvider, role, userAccount, roleGrant, projectAccess, serviceProviderAccess }

/** A company with one row in each of the eight tables, inserted as the owner. */
async function seed(tx: Tx, n: "a" | "b"): Promise<void> {
  const own = ids(n)
  await tx.insert(company).values({ id: own.company, companyId: own.company, name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `1000000${n}`, country: "DK", status: "active" })
  await tx.insert(project).values({ id: own.project, companyId: own.company, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(serviceProvider).values({ id: own.provider, companyId: own.company, legalName: "NordRen ApS", registrationNumber: `2000000${n}`, country: "DK", contactName: "Lars Mikkelsen", contactEmail: `lars@${n}.example` })
  await tx.insert(role).values({ id: own.role, companyId: own.company, key: "company-administrator", name: "Company Administrator", scope: "Company", description: "Everything in the company", system: true })
  await tx.insert(userAccount).values([
    { id: own.administrator, companyId: own.company, email: `admin@${n}.example`, fullName: "Olivia Larsen", roleId: own.role, allProjects: true, primaryAdministrator: true },
    { id: own.providerUser, companyId: own.company, email: `foreman@${n}.example`, fullName: "Lars Mikkelsen", roleId: own.role, serviceProviderId: own.provider },
  ])
  await tx.insert(roleGrant).values({ id: own.grant, companyId: own.company, roleId: own.role, moduleKey: "configure.access", action: "view" })
  await tx.insert(projectAccess).values({ id: own.projectAccess, companyId: own.company, userAccountId: own.administrator, projectId: own.project })
  await tx.insert(serviceProviderAccess).values({ id: own.providerAccess, companyId: own.company, userAccountId: own.providerUser, serviceProviderId: own.provider })
}

describe("the Organisation & Access tables against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_organisation_access")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  /** The two companies seeded as the owner in a transaction that is rolled back. */
  const seeded = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBack(owner.db, async (tx) => {
      await seed(tx, "a")
      await seed(tx, "b")
      return fn(tx)
    })

  test("0002 created the eight tables in wms, each fenced (row-level security enabled and forced, one policy for the API role) and with its updated_at trigger", async () => {
    const rows = await owner.sql<{ table: string; enabled: boolean; forced: boolean; policies: string[]; triggers: string[] }[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select array_agg(p.policyname order by p.policyname) from pg_policies p where p.schemaname = 'wms' and p.tablename = c.relname) as policies,
        (select array_agg(t.tgname order by t.tgname) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r'
      order by c.relname`
    assert.deepEqual(
      rows.map(({ table, enabled, forced, policies, triggers }) => ({ table, enabled, forced, policies, triggers })),
      ["company", "project", "project_access", "role", "role_grant", "service_provider", "service_provider_access", "user_account"].map((table) => ({
        table,
        enabled: true,
        forced: true,
        policies: [`${table}_tenant_fence`],
        triggers: [`${table}_touch_updated_at`],
      })),
    )
  })

  test("a company is its own tenant: company_id must equal id (23514 company_self)", () =>
    rolledBack(owner.db, async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(company).values({ id: a.company, companyId: b.company, name: "Askew", legalName: "Askew A/S", registrationNumber: "1", country: "DK", status: "active" }),
        ),
        refusedWith("23514", /company_self/),
      )
      await seed(tx, "a")
      assert.deepEqual(await tx.select({ companyId: company.companyId }).from(company).where(eq(company.id, a.company)), [{ companyId: a.company }])
    }))

  test("a status is one of the listed values (23514 <table>_status_one_of)", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(company).values({ id: a.spare, companyId: a.spare, name: "x", legalName: "x", registrationNumber: "3", country: "DK", status: "closed" })),
        refusedWith("23514", /company_status_one_of/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(project).values({ id: a.spare, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "Active" })),
        refusedWith("23514", /project_status_one_of/),
      )
      await tx.insert(project).values({ id: a.spare, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "onboarding" })
    }))

  test("a row that names another company's role, project or provider is refused by the composite key (23503), whatever the API does", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(userAccount).values({ id: a.spare, companyId: a.company, email: "new@a.example", fullName: "New", roleId: b.role })),
        refusedWith("23503", /user_account_role_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(userAccount).values({ id: a.spare, companyId: a.company, email: "new@a.example", fullName: "New", roleId: a.role, serviceProviderId: b.provider })),
        refusedWith("23503", /user_account_service_provider_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(roleGrant).values({ id: a.spare, companyId: a.company, roleId: b.role, moduleKey: "configure.access", action: "edit" })),
        refusedWith("23503", /role_grant_role_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(projectAccess).values({ id: a.spare, companyId: a.company, userAccountId: a.administrator, projectId: b.project })),
        refusedWith("23503", /project_access_project_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(projectAccess).values({ id: a.spare, companyId: a.company, userAccountId: b.administrator, projectId: a.project })),
        refusedWith("23503", /project_access_user_account_id_fk/),
      )
      // The plain key: a company that does not exist.
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(project).values({ id: a.spare, companyId: a.spare, name: "Nowhere", kind: "Region", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })),
        refusedWith("23503", /project_company_id_fk/),
      )
      // The same rows within the tenant land.
      await tx.insert(userAccount).values({ id: a.spare, companyId: a.company, email: "new@a.example", fullName: "New", roleId: a.role, serviceProviderId: a.provider })
      await tx.insert(roleGrant).values({ id: b.spare, companyId: b.company, roleId: b.role, moduleKey: "configure.access", action: "edit" })
    }))

  test("a Service Provider Access can only name the provider its account belongs to: the three-column key (23503)", () =>
    seeded(async (tx) => {
      // The administrator belongs to no provider.
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(serviceProviderAccess).values({ id: a.spare, companyId: a.company, userAccountId: a.administrator, serviceProviderId: a.provider })),
        refusedWith("23503", /service_provider_access_user_account_id_service_provider_id_fk/),
      )
      // The provider user belongs to another provider than the one named.
      await tx.insert(serviceProvider).values({ id: a.spare, companyId: a.company, legalName: "CityHaul", registrationNumber: "4000000a", country: "DK", contactName: "x", contactEmail: "x@a.example" })
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(serviceProviderAccess).values({ id: b.spare, companyId: a.company, userAccountId: a.providerUser, serviceProviderId: a.spare })),
        refusedWith("23503", /service_provider_access_user_account_id_service_provider_id_fk/),
      )
      // And a second grant for the same pair is one grant too many.
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(serviceProviderAccess).values({ id: b.spare, companyId: a.company, userAccountId: a.providerUser, serviceProviderId: a.provider })),
        refusedWith("23505", /service_provider_access_user_account_id_service_provider_id_key/),
      )
    }))

  test("each company has at most one primary administrator (23505 user_account_primary_administrator_idx); other accounts are not counted", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(userAccount).values({ id: a.spare, companyId: a.company, email: "second@a.example", fullName: "Second", roleId: a.role, primaryAdministrator: true })),
        refusedWith("23505", /user_account_primary_administrator_idx/),
      )
      await tx.insert(userAccount).values({ id: a.spare, companyId: a.company, email: "second@a.example", fullName: "Second", roleId: a.role })
      const [{ primaries }] = await tx.execute<{ primaries: number }>(sql`select count(*)::int as primaries from ${userAccount} where ${userAccount.primaryAdministrator}`)
      assert.equal(primaries, 2, "one per company, two companies")
    }))

  test("an e-mail is lowercase (23514 user_account_email_lowercase) and unique within the company (23505 user_account_email_key), not across companies", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(userAccount).values({ id: a.spare, companyId: a.company, email: "Olivia.Larsen@wastehero.io", fullName: "Olivia", roleId: a.role })),
        refusedWith("23514", /user_account_email_lowercase/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(userAccount).values({ id: a.spare, companyId: a.company, email: "admin@a.example", fullName: "Again", roleId: a.role })),
        refusedWith("23505", /user_account_email_key/),
      )
      await tx.insert(userAccount).values({ id: b.spare, companyId: b.company, email: "admin@a.example", fullName: "Same address, other company", roleId: b.role })
    }))

  test("one login binds to one account across every company (23505 user_account_auth_user_id_key); invited accounts, bound to none, are many", () =>
    seeded(async (tx) => {
      await tx.update(userAccount).set({ authUserId: authUser }).where(eq(userAccount.id, a.administrator))
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.update(userAccount).set({ authUserId: authUser }).where(eq(userAccount.id, b.administrator))),
        refusedWith("23505", /user_account_auth_user_id_key/),
      )
      const [{ invited }] = await tx.execute<{ invited: number }>(sql`select count(*)::int as invited from ${userAccount} where ${userAccount.authUserId} is null`)
      assert.equal(invited, 3)
    }))

  test("the business keys: a registration once per country, a project name and a role name or key once per company, custom roles without a key as many as needed", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(company).values({ id: a.spare, companyId: a.spare, name: "Twin", legalName: "Twin", registrationNumber: "1000000a", country: "DK", status: "onboarding" })),
        refusedWith("23505", /company_country_registration_number_key/),
      )
      await tx.insert(company).values({ id: a.spare, companyId: a.spare, name: "Twin abroad", legalName: "Twin", registrationNumber: "1000000a", country: "SE", status: "onboarding" })
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(project).values({ id: b.spare, companyId: a.company, name: "Copenhagen Central", kind: "Region", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })),
        refusedWith("23505", /project_name_key/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(role).values({ id: b.spare, companyId: a.company, key: "company-administrator", name: "Another name", scope: "Company", description: "", system: true })),
        refusedWith("23505", /role_key_key/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(role).values({ id: b.spare, companyId: a.company, name: "Company Administrator", scope: "Company", description: "", system: false })),
        refusedWith("23505", /role_name_key/),
      )
      await tx.insert(role).values([
        { companyId: a.company, name: "Custom one", scope: "Assigned projects", description: "", system: false },
        { companyId: a.company, name: "Custom two", scope: "Assigned projects", description: "", system: false },
      ])
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(roleGrant).values({ companyId: a.company, roleId: a.role, moduleKey: "configure.access", action: "view" })),
        refusedWith("23505", /role_grant_role_id_module_key_action_key/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(projectAccess).values({ companyId: a.company, userAccountId: a.administrator, projectId: a.project })),
        refusedWith("23505", /project_access_user_account_id_project_id_key/),
      )
    }))

  /** Row counts per table as the transaction currently sees them. */
  const counts = async (tx: Tx): Promise<Record<string, number>> => {
    const seen: Record<string, number> = {}
    for (const [name, table] of Object.entries(tables)) {
      const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${table}`)
      seen[name] = count
    }
    return seen
  }
  const one = Object.fromEntries(Object.keys(tables).map((name) => [name, 1]))
  const none = Object.fromEntries(Object.keys(tables).map((name) => [name, 0]))

  /** Both companies seeded as the owner inside `withCompany`, then the transaction becomes the API role. */
  const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBackIn(
      (body) => withCompany(owner.db, companyId, body),
      async (tx) => {
        await seed(tx, "a")
        await seed(tx, "b")
        // Role settings apply at login, not at SET ROLE: the API role's search path is set by hand.
        await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
        await tx.execute(sql`set local search_path = wms, extensions`)
        return fn(tx)
      },
    )

  test("under withCompany as the API role, each of the eight tables shows the company's rows and nothing of another company's", async () => {
    // user_account has two rows per company; the rest one.
    const expected = { ...one, userAccount: 2 }
    const seenByA = await asCompany(a.company, async (tx) => ({
      counts: await counts(tx),
      company: await tx.select({ id: company.id }).from(company),
      users: (await tx.select({ email: userAccount.email }).from(userAccount).orderBy(userAccount.email)).map((row) => row.email),
    }))
    assert.deepEqual(seenByA, { counts: expected, company: [{ id: a.company }], users: ["admin@a.example", "foreman@a.example"] })
    const seenByB = await asCompany(b.company, async (tx) => ({ counts: await counts(tx), company: await tx.select({ id: company.id }).from(company) }))
    assert.deepEqual(seenByB, { counts: expected, company: [{ id: b.company }] })
  })

  test("the API role with no company set sees nothing in any of them, and cannot write another company's row (42501)", () =>
    rolledBack(owner.db, async (tx) => {
      await seed(tx, "a")
      await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
      await tx.execute(sql`set local search_path = wms, extensions`)
      assert.deepEqual(await counts(tx), none)
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(project).values({ companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })),
        refusedWith("42501", /new row violates row-level security policy for table "project"/),
      )
    }))

  test("as the API role under its company, a write for another company is refused (42501) and its own lands", () =>
    asCompany(a.company, async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(project).values({ companyId: b.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })),
        refusedWith("42501", /new row violates row-level security policy for table "project"/),
      )
      await tx.insert(project).values({ companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
      assert.deepEqual((await tx.select({ name: project.name }).from(project).orderBy(project.name)).map((row) => row.name), ["Copenhagen Central", "Harbor"])
    }))
})
