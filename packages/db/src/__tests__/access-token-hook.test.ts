// The custom access token hook (Issue #70) against Postgres:
// public.custom_access_token_hook, called the way Supabase Auth calls it, as
// supabase_auth_admin with the event Auth sends. On the shared local database,
// not a fresh one: `auth.users` exists only where the Supabase image created
// it, and the test inserts the auth users its events name, as the owner, the
// way Auth would have. The rows it commits belong to two companies of its own
// (the second is there to invite an address the first has invited too, #76)
// and are removed in dependency order before and after.
//
// The owner cannot SET ROLE to supabase_auth_admin (its memberships are
// reserved to superusers), so the hook runs on a second pool connected as that
// role, which the local stack lets in with the one database password.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { eq, sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { role, userAccount } from "../schema/access"
import { company } from "../schema/organisation"
import { databaseUnderTest, withUser } from "./database"
import { refusedWith, rolledBack } from "./specimen"

const database = databaseUnderTest()

/** The role Supabase Auth connects as, and the hook's one caller. */
const AUTH_ADMIN = "supabase_auth_admin"
const HOOK = "public.custom_access_token_hook"

const companyId = "018f7c2e-c000-7000-8000-000000000001"
const roleId = "018f7c2e-c000-7000-8000-000000000002"
/** A second company, there to invite an address the first has invited too (#76). */
const otherCompanyId = "018f7c2e-c000-7000-8000-000000000003"
const otherRoleId = "018f7c2e-c000-7000-8000-000000000004"
// Addresses of this file's own: the hook binds by e-mail across the whole
// database, so an address the demo seed also invited
// (fares.abdelghany@kystbyen.example, src/seed/demo.ts) would be two open
// invitations, which the hook binds neither of.
const accounts = {
  invited: { id: "018f7c2e-c000-7000-8000-000000000011", email: "invited.colleague@hook-test.example" },
  deactivated: { id: "018f7c2e-c000-7000-8000-000000000012", email: "former.colleague@hook-test.example" },
  neverBound: { id: "018f7c2e-c000-7000-8000-000000000013", email: "left.before.signing.in@hook-test.example" },
  invitedTwice: { id: "018f7c2e-c000-7000-8000-000000000014", email: "invited.by.both@hook-test.example" },
  /** The other company's invitation of the same address. */
  invitedTwiceElsewhere: { id: "018f7c2e-c000-7000-8000-000000000015", email: "invited.by.both@hook-test.example" },
}
/** The auth users, one per person and one nobody invited into a company. */
const authUsers = {
  invited: "018f7c2e-c000-7000-8000-0000000000a1",
  deactivated: "018f7c2e-c000-7000-8000-0000000000a2",
  neverBound: "018f7c2e-c000-7000-8000-0000000000a3",
  unknown: "018f7c2e-c000-7000-8000-0000000000a4",
  invitedTwice: "018f7c2e-c000-7000-8000-0000000000a5",
}

type Event = { user_id: string; claims: Record<string, unknown>; authentication_method: string }

/** The event Auth sends: the user's id, the claims of the token about to be issued, and how the user authenticated. */
const event = (userId: string, email: string, appMetadata?: Record<string, unknown>): Event => ({
  user_id: userId,
  claims: {
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    email,
    ...(appMetadata === undefined ? {} : { app_metadata: appMetadata }),
    user_metadata: { email_verified: true },
    session_id: "018f7c2e-c000-7000-8000-0000000000e1",
    is_anonymous: false,
  },
  authentication_method: "password",
})

describe("the access token hook against the database", { skip: database.skip }, () => {
  let owner: Database
  let auth: Database

  /** What the hook makes of an event, called as Auth calls it. */
  const hook = async (input: Event): Promise<unknown> => {
    const [row] = await auth.sql.unsafe<{ result: string }[]>(`select ${HOOK}($1::jsonb)::text as result`, [JSON.stringify(input)])
    return JSON.parse(row.result)
  }

  const boundTo = async (accountId: string): Promise<string | null> => {
    const [row] = await owner.db.select({ authUserId: userAccount.authUserId }).from(userAccount).where(eq(userAccount.id, accountId))
    return row.authUserId
  }

  /** Removes what this file committed, children before parents. */
  const cleanUp = async (): Promise<void> => {
    await owner.sql.begin(async (tx) => {
      for (const table of ["service_provider_access", "project_access", "role_grant", "user_account", "role", "service_provider", "project", "company"]) {
        await tx.unsafe(`delete from wms.${table} where company_id in ($1, $2)`, [companyId, otherCompanyId])
      }
      await tx`delete from auth.users where id in ${tx(Object.values(authUsers))}`
    })
  }

  before(async () => {
    await migrateDatabase(database.adminUrl)
    owner = createDb(database.adminUrl, { max: 2 })
    auth = createDb(withUser(database.adminUrl, AUTH_ADMIN), { max: 1 })
    await cleanUp()
    // This file's own company, not the demo seed's: `unique (country,
    // registration_number)` is global, and `pnpm db:seed` owns DK 12345678 on
    // this shared database (src/seed/demo.ts).
    await owner.db.insert(company).values([
      { id: companyId, companyId, name: "Hook Test A/S", legalName: "Hook Test ApS", registrationNumber: "99000001", country: "DK", status: "active" },
      { id: otherCompanyId, companyId: otherCompanyId, name: "Other Hook Test A/S", legalName: "Other Hook Test ApS", registrationNumber: "99000002", country: "DK", status: "active" },
    ])
    await owner.db.insert(role).values([
      { id: roleId, companyId, key: "company-administrator", name: "Company Administrator", scope: "Company", description: "Everything in the company", system: true },
      { id: otherRoleId, companyId: otherCompanyId, key: "company-administrator", name: "Company Administrator", scope: "Company", description: "Everything in the company", system: true },
    ])
    await owner.db.insert(userAccount).values([
      { id: accounts.invited.id, companyId, email: accounts.invited.email, fullName: "Invited Colleague", roleId, allProjects: true, primaryAdministrator: true },
      { id: accounts.deactivated.id, companyId, email: accounts.deactivated.email, fullName: "Former Colleague", roleId, authUserId: authUsers.deactivated, deactivatedAt: new Date("2026-09-01T09:00:00Z") },
      { id: accounts.neverBound.id, companyId, email: accounts.neverBound.email, fullName: "Left Before Signing In", roleId, deactivatedAt: new Date("2026-09-02T09:00:00Z") },
      { id: accounts.invitedTwice.id, companyId, email: accounts.invitedTwice.email, fullName: "Invited By Both", roleId },
      { id: accounts.invitedTwiceElsewhere.id, companyId: otherCompanyId, email: accounts.invitedTwiceElsewhere.email, fullName: "Invited By Both", roleId: otherRoleId },
    ])
    // The auth users, as Auth's invitation would have created them: the columns a row needs and nothing Auth fills in later.
    for (const [name, id] of Object.entries(authUsers)) {
      const email = name === "unknown" ? "nobody.invited@example.com" : accounts[name as keyof typeof accounts].email
      await owner.sql`
        insert into auth.users (instance_id, id, aud, role, email, encrypted_password, created_at, updated_at)
        values ('00000000-0000-0000-0000-000000000000', ${id}, 'authenticated', 'authenticated', ${email}, '', now(), now())`
    }
  })
  after(async () => {
    await cleanUp()
    await auth?.close()
    await owner?.close()
  })

  test("the hook is security definer with an empty search path, owned by the migration's role; supabase_auth_admin may execute it and the Data API roles may not", async () => {
    const [row] = await owner.sql<Record<string, unknown>[]>`
      select p.prosecdef as definer, p.proconfig as config, p.proowner::regrole::text as owner, l.lanname as language,
        has_function_privilege(${AUTH_ADMIN}, ${`${HOOK}(jsonb)`}, 'execute') as auth_admin,
        has_function_privilege('anon', ${`${HOOK}(jsonb)`}, 'execute') as anon,
        has_function_privilege('authenticated', ${`${HOOK}(jsonb)`}, 'execute') as authenticated,
        has_function_privilege('service_role', ${`${HOOK}(jsonb)`}, 'execute') as service_role
      from pg_proc p join pg_language l on l.oid = p.prolang
      where p.oid = ${`${HOOK}(jsonb)`}::regprocedure`
    // An empty search path is stored as `search_path=""`. service_role is the
    // Data API's own caller and holds the service key: 0003 revokes what the
    // owner's default privileges in `public` granted it.
    assert.deepEqual(row, { definer: true, config: ['search_path=""'], owner: new URL(database.adminUrl).username, language: "plpgsql", auth_admin: true, anon: false, authenticated: false, service_role: false })
    const [session] = await auth.sql<{ user: string; path: string }[]>`select current_user as user, current_setting('search_path') as path`
    assert.deepEqual(session, { user: AUTH_ADMIN, path: "auth" }, "the caller's own search path does not reach wms: the hook qualifies every name")
  })

  test("first sign-in binds the invited account by its e-mail, case-insensitively, and adds app_metadata.company_id, every other claim untouched", async () => {
    assert.equal(await boundTo(accounts.invited.id), null)
    const input = event(authUsers.invited, "Invited.Colleague@Hook-Test.Example", { provider: "email", providers: ["email"] })
    const result = await hook(input)
    assert.deepEqual(result, {
      ...input,
      claims: { ...input.claims, app_metadata: { provider: "email", providers: ["email"], company_id: companyId } },
    })
    assert.equal(await boundTo(accounts.invited.id), authUsers.invited)
  })

  // Runs after the test above and depends on it: node:test runs a file's tests
  // in order, and the account resolves by id here only because that test bound
  // it. Both are one story — the first sign-in and every token after it — told
  // in two tests so a failure names which half broke.
  test("a later token resolves by id, whatever the e-mail claim says, and creates app_metadata when the claims carry none", async () => {
    const input = event(authUsers.invited, "another.address@example.com")
    assert.deepEqual(await hook(input), { ...input, claims: { ...input.claims, app_metadata: { company_id: companyId } } })
    // The refresh Auth runs the hook on carries a different method and no fewer claims.
    const refresh = { ...event(authUsers.invited, accounts.invited.email, { provider: "email" }), authentication_method: "token_refresh" }
    assert.deepEqual(await hook(refresh), { ...refresh, claims: { ...refresh.claims, app_metadata: { provider: "email", company_id: companyId } } })
  })

  test("a deactivated account is refused with the error object Auth reads as a 403", async () => {
    assert.deepEqual(await hook(event(authUsers.deactivated, accounts.deactivated.email)), {
      error: { http_code: 403, message: "This account is deactivated" },
    })
  })

  test("an account deactivated before it was ever bound is not bound: the event comes back unchanged and the API will answer 403", async () => {
    const input = event(authUsers.neverBound, accounts.neverBound.email)
    assert.deepEqual(await hook(input), input)
    assert.equal(await boundTo(accounts.neverBound.id), null)
  })

  test("a user no company invited: the event comes back unchanged", async () => {
    const input = event(authUsers.unknown, "nobody.invited@example.com", { provider: "email" })
    assert.deepEqual(await hook(input), input)
  })

  // `unique (auth_user_id)` is one company per login, so binding both would
  // violate it and Auth would refuse the token on SQLSTATE 23505 with nothing
  // to tell the person. Binding neither leaves the token without a company,
  // which the API answers with its 403 (#76). Which company such a login belongs
  // to is decided with multi-company accounts.
  test("two companies inviting one address: the first sign-in binds neither and the event comes back unchanged; once one invitation is withdrawn, the other is bound", async () => {
    const input = event(authUsers.invitedTwice, accounts.invitedTwice.email, { provider: "email" })
    assert.deepEqual(await hook(input), input)
    assert.equal(await boundTo(accounts.invitedTwice.id), null)
    assert.equal(await boundTo(accounts.invitedTwiceElsewhere.id), null)
    // The other company deactivates its invitation: the address names one open account again.
    await owner.db.update(userAccount).set({ deactivatedAt: new Date("2026-09-03T09:00:00Z") }).where(eq(userAccount.id, accounts.invitedTwiceElsewhere.id))
    assert.deepEqual(await hook(input), { ...input, claims: { ...input.claims, app_metadata: { provider: "email", company_id: companyId } } })
    assert.equal(await boundTo(accounts.invitedTwice.id), authUsers.invitedTwice)
    assert.equal(await boundTo(accounts.invitedTwiceElsewhere.id), null)
  })

  test("the first-sign-in lookup by e-mail has a plain index over the address across the whole database (#75)", async () => {
    // The proof is the definition: a btree whose first key column is `email`,
    // which `unique (company_id, email)` does not lead with, so the hook's
    // equality on the address alone is an index condition and not a scan of
    // every company's rows. It is deliberately NOT an EXPLAIN: a plan is a
    // cost comparison between this index and `user_account_auth_user_id_key`
    // (whose `is null` also matches every unbound row), and on the shared
    // local database the API suites' tenant churn leaves the e-mail index
    // three times the pages of the unique one — btree pages are never given
    // back — so the planner picked the other index at 12.17 against 16.27
    // where a reindexed copy costs 8.14 (issue #91). A plan measures bloat;
    // the catalogue measures the index.
    const [index] = await owner.sql<{ definition: string }[]>`
      select indexdef as definition from pg_indexes where schemaname = 'wms' and tablename = 'user_account' and indexname = 'user_account_email_idx'`
    assert.equal(index?.definition, "CREATE INDEX user_account_email_idx ON wms.user_account USING btree (email)")
  })

  test("anon, authenticated and service_role cannot execute it (42501)", () =>
    rolledBack(owner.db, async (tx) => {
      for (const caller of ["anon", "authenticated", "service_role"]) {
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint.execute(sql`set local role ${sql.raw(caller)}`)
            await savepoint.execute(sql`select ${sql.raw(HOOK)}('{}'::jsonb)`)
          }),
          refusedWith("42501", /permission denied for function custom_access_token_hook/),
        )
      }
    }))
})
