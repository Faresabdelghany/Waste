// The demo company, as `pnpm db:seed` writes it (Issue #70, slice 2): the
// tenant the prototype has always shown — Kystbyen Renovation, its three
// projects, the two service providers it works with, the eleven seeded roles
// with their grants, and the two accounts the login picker offers.
//
// Three properties make this a seed and not a fixture script:
//
//   Fixed ids. Every record's id is spelled below, a UUID version 7 by hand,
//   so the local database and the hosted project hold the same company: a
//   token minted against the hosted project opens the same rows locally, and
//   a test may name a row without looking it up. A test holds their shape.
//
//   Idempotent. Every insert is `on conflict ... do update` keyed by the id,
//   and the update is skipped when the stored row already says what this run
//   proposes, so a second run writes nothing at all — not even an `updated_at`
//   through the touch trigger. What someone edited by hand is put back; what
//   the seed does not own is left alone (an account's `auth_user_id` and
//   `deactivated_at` are the hook's and the API's, never the seed's).
//
//   Any admin URL. Unlike bootstrap, which refuses a non-loopback host because
//   it sets a password, this runs the same statements anywhere: the hosted
//   project is meant to carry the same company. It connects as the owner
//   (`DATABASE_ADMIN_URL`), which carries BYPASSRLS locally and on Supabase,
//   so the tenant fence needs no company set.
//
// The role charters are not spelled here: they are
// @waste/domain/access/system-roles, the same data the web's permission matrix
// draws, written through `normaliseGrants` so the rows are what the API would
// compute for the same grant set.
//
// What this seed reserves on a database it shares with the test suites, and
// what a per-tenant test file must therefore not use:
//
//   DK / 12345678 — `unique (country, registration_number)` on `company` is
//   global, so no other company on the database may carry that pair. A test
//   company takes a registration number of its own.
//
//   olivia.larsen@kystbyen.example and lars.mikkelsen@nordren.dk — the access
//   token hook binds a first sign-in by e-mail across the whole database, so
//   an account elsewhere with one of these addresses would be bound by it and
//   then refused by `unique (auth_user_id)`. A test account takes an address
//   on a random `.example` domain.
//
//   The `01a0d2a4-a280-7…` id bucket — every id below is spelled by hand in
//   it. A test row minted from the clock lands far from it, but a hand-written
//   test id must not.
//
// The reverse holds too: the seed must not write over what a test owns, which
// `seed.test.ts` checks for the one company a test file commits rows under.
import { normaliseGrants } from "@waste/domain/access/grants"
import { SYSTEM_ROLES, type SystemRoleKey } from "@waste/domain/access/system-roles"
import { and, eq, inArray, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import { createDb, type Tx } from "../client"
import { columnName } from "../names"
import { role, roleGrant, serviceProviderAccess, userAccount } from "../schema/access"
import { company, project, serviceProvider } from "../schema/organisation"

/**
 * Every id the seed writes. UUID version 7 by hand: the first twelve hex
 * digits are a millisecond (2026-09-24, when the seed was written), the third
 * group's `7` the version, the fourth group's `8` the variant, and the rest
 * says which record it is — a random-looking constant is harder to recognise
 * in a log than a counted one, and these are demo data, not secrets.
 */
export const DEMO_IDS = {
  company: "01a0d2a4-a280-7001-8000-000000000001",
  projects: {
    copenhagen: "01a0d2a4-a280-7002-8000-000000000001",
    harbor: "01a0d2a4-a280-7002-8000-000000000002",
    cairo: "01a0d2a4-a280-7002-8000-000000000003",
  },
  serviceProviders: {
    nordren: "01a0d2a4-a280-7003-8000-000000000001",
    cityhaul: "01a0d2a4-a280-7003-8000-000000000002",
  },
  roles: {
    "company-administrator": "01a0d2a4-a280-7004-8000-000000000001",
    "operations-manager": "01a0d2a4-a280-7004-8000-000000000002",
    dispatcher: "01a0d2a4-a280-7004-8000-000000000003",
    "route-planner": "01a0d2a4-a280-7004-8000-000000000004",
    "fleet-manager": "01a0d2a4-a280-7004-8000-000000000005",
    "customer-service": "01a0d2a4-a280-7004-8000-000000000006",
    "finance-specialist": "01a0d2a4-a280-7004-8000-000000000007",
    "service-provider-manager": "01a0d2a4-a280-7004-8000-000000000008",
    "service-provider-foreman": "01a0d2a4-a280-7004-8000-000000000009",
    driver: "01a0d2a4-a280-7004-8000-00000000000a",
    "integration-writer": "01a0d2a4-a280-7004-8000-00000000000b",
  } satisfies Record<SystemRoleKey, string>,
  users: {
    olivia: "01a0d2a4-a280-7005-8000-000000000001",
    lars: "01a0d2a4-a280-7005-8000-000000000002",
  },
  serviceProviderAccess: {
    lars: "01a0d2a4-a280-7006-8000-000000000001",
  },
} as const

const COMPANY_ID = DEMO_IDS.company

const COMPANY: typeof company.$inferInsert = {
  id: COMPANY_ID,
  companyId: COMPANY_ID,
  name: "Kystbyen Renovation",
  legalName: "Kystbyen Renovation A/S",
  registrationNumber: "12345678",
  country: "DK",
  status: "active",
}

const PROJECTS: (typeof project.$inferInsert)[] = [
  {
    id: DEMO_IDS.projects.copenhagen,
    companyId: COMPANY_ID,
    name: "Copenhagen Central",
    kind: "Municipality",
    language: "da",
    currency: "DKK",
    timezone: "Europe/Copenhagen",
    status: "active",
  },
  {
    id: DEMO_IDS.projects.harbor,
    companyId: COMPANY_ID,
    name: "Harbor Commercial",
    kind: "Business unit",
    language: "da",
    currency: "DKK",
    timezone: "Europe/Copenhagen",
    status: "onboarding",
  },
  {
    // The Friday–Saturday weekend the working-week model is proven against.
    id: DEMO_IDS.projects.cairo,
    companyId: COMPANY_ID,
    name: "Cairo Operations",
    kind: "Municipality",
    language: "ar",
    currency: "EGP",
    timezone: "Africa/Cairo",
    status: "active",
  },
]

const SERVICE_PROVIDERS: (typeof serviceProvider.$inferInsert)[] = [
  {
    id: DEMO_IDS.serviceProviders.nordren,
    companyId: COMPANY_ID,
    legalName: "NordRen ApS",
    registrationNumber: "40291188",
    country: "DK",
    contactName: "Lars Mikkelsen",
    contactEmail: "lars.mikkelsen@nordren.dk",
  },
  {
    id: DEMO_IDS.serviceProviders.cityhaul,
    companyId: COMPANY_ID,
    legalName: "CityHaul A/S",
    registrationNumber: "39122004",
    country: "DK",
    contactName: "Mikkel Andersen",
    contactEmail: "mikkel.andersen@cityhaul.dk",
  },
]

const ROLES: (typeof role.$inferInsert)[] = SYSTEM_ROLES.map((systemRole) => ({
  id: DEMO_IDS.roles[systemRole.key],
  companyId: COMPANY_ID,
  key: systemRole.key,
  name: systemRole.name,
  scope: systemRole.scope,
  description: systemRole.description,
  system: systemRole.system,
}))

// One row per action a charter allows. `normaliseGrants` is the rule the API
// applies to a grant set it stores (@waste/domain/access/grants); the charters
// already satisfy it, so this changes nothing today and keeps the seed right
// if a charter is ever spelled loosely.
const GRANTS: (typeof roleGrant.$inferInsert)[] = SYSTEM_ROLES.flatMap((systemRole) =>
  normaliseGrants(systemRole.grants).flatMap((grant) =>
    grant.actions.map((action) => ({
      companyId: COMPANY_ID,
      roleId: DEMO_IDS.roles[systemRole.key],
      moduleKey: grant.moduleKey,
      action,
    })),
  ),
)

// Both accounts are `invited` until Supabase Auth's access token hook binds
// them on first sign-in: `auth_user_id` is null here and stays the hook's.
const USERS: (typeof userAccount.$inferInsert)[] = [
  {
    id: DEMO_IDS.users.olivia,
    companyId: COMPANY_ID,
    // The prototype spells this address two ways; the seed uses the one an
    // invitation can reach (lib/data/demo-accounts.ts), not `.example`.
    email: "olivia.larsen@kystbyen.example",
    fullName: "Olivia Larsen",
    roleId: DEMO_IDS.roles["company-administrator"],
    allProjects: true,
    primaryAdministrator: true,
  },
  {
    id: DEMO_IDS.users.lars,
    companyId: COMPANY_ID,
    email: "lars.mikkelsen@nordren.dk",
    fullName: "Lars Mikkelsen",
    roleId: DEMO_IDS.roles["service-provider-manager"],
    serviceProviderId: DEMO_IDS.serviceProviders.nordren,
  },
]

const PROVIDER_ACCESS: (typeof serviceProviderAccess.$inferInsert)[] = [
  {
    id: DEMO_IDS.serviceProviderAccess.lars,
    companyId: COMPANY_ID,
    userAccountId: DEMO_IDS.users.lars,
    serviceProviderId: DEMO_IDS.serviceProviders.nordren,
  },
]

/** What the seed says the company holds. */
export type DemoSeedCounts = {
  projects: number
  serviceProviders: number
  roles: number
  roleGrants: number
  users: number
  serviceProviderAccess: number
}

export type DemoSeedReport = {
  companyId: string
  /** Rows this run inserted, updated or deleted. Zero when the database already said all of this. */
  changed: number
  counts: DemoSeedCounts
}

const COUNTS: DemoSeedCounts = {
  projects: PROJECTS.length,
  serviceProviders: SERVICE_PROVIDERS.length,
  roles: ROLES.length,
  roleGrants: GRANTS.length,
  users: USERS.length,
  serviceProviderAccess: PROVIDER_ACCESS.length,
}

/** `excluded.<column>`: the value this run proposed for a row that is already there. */
const proposed = (column: PgColumn): SQL => sql`excluded.${sql.identifier(columnName(column))}`

/**
 * The stored column, qualified by its table: inside `DO UPDATE` both the row
 * found and `excluded` are in scope, so a bare column name is ambiguous
 * (42702).
 */
const stored = (column: PgColumn): SQL => sql`${column}`

/**
 * How Drizzle's `set` is keyed: by the column's property name, not its name in
 * the database. Every column of this schema is declared without a name of its
 * own (the casing makes it), so the property name is what the column carries;
 * a column declared otherwise is refused here rather than silently set wrong.
 */
function propertyOf(column: PgColumn): string {
  if (!column.keyAsName) {
    throw new Error(`the seed keys its updates by property name, and ${columnName(column)} was declared with a name of its own`)
  }
  return column.name
}

/** The columns the seed owns, set back to what this run proposed. */
function restore(columns: readonly PgColumn[]): Record<string, SQL> {
  return Object.fromEntries(columns.map((column) => [propertyOf(column), proposed(column)]))
}

/**
 * True when the stored row disagrees with the one this run proposed. As the
 * `WHERE` of `DO UPDATE` it makes an unchanged row no write at all, so the
 * touch trigger does not fire and `updated_at` still says when the value last
 * really changed.
 */
function changesSomething(columns: readonly PgColumn[]): SQL {
  return sql`(${sql.join(columns.map(stored), sql`, `)}) is distinct from (${sql.join(columns.map(proposed), sql`, `)})`
}

const COMPANY_COLUMNS = [company.name, company.legalName, company.registrationNumber, company.country, company.status]
const PROJECT_COLUMNS = [project.name, project.kind, project.language, project.currency, project.timezone, project.status]
const SERVICE_PROVIDER_COLUMNS = [
  serviceProvider.legalName,
  serviceProvider.registrationNumber,
  serviceProvider.country,
  serviceProvider.contactName,
  serviceProvider.contactEmail,
]
const ROLE_COLUMNS = [role.key, role.name, role.scope, role.description, role.system]
// Not `auth_user_id` and not `deactivated_at`: the hook binds the first when
// the person signs in and the API writes the second, and a seed run must not
// unbind an account or wake a deactivated one.
const USER_COLUMNS = [
  userAccount.email,
  userAccount.fullName,
  userAccount.roleId,
  userAccount.allProjects,
  userAccount.serviceProviderId,
  userAccount.primaryAdministrator,
]

/** Writes the demo company into an open transaction and answers how many rows it changed. */
async function applyDemo(tx: Tx): Promise<number> {
  let changed = 0
  const written = (rows: { id: string }[]) => {
    changed += rows.length
  }

  written(
    await tx
      .insert(company)
      .values(COMPANY)
      .onConflictDoUpdate({ target: company.id, set: restore(COMPANY_COLUMNS), setWhere: changesSomething(COMPANY_COLUMNS) })
      .returning({ id: company.id }),
  )
  written(
    await tx
      .insert(project)
      .values(PROJECTS)
      .onConflictDoUpdate({ target: project.id, set: restore(PROJECT_COLUMNS), setWhere: changesSomething(PROJECT_COLUMNS) })
      .returning({ id: project.id }),
  )
  written(
    await tx
      .insert(serviceProvider)
      .values(SERVICE_PROVIDERS)
      .onConflictDoUpdate({
        target: serviceProvider.id,
        set: restore(SERVICE_PROVIDER_COLUMNS),
        setWhere: changesSomething(SERVICE_PROVIDER_COLUMNS),
      })
      .returning({ id: serviceProvider.id }),
  )
  written(
    await tx
      .insert(role)
      .values(ROLES)
      .onConflictDoUpdate({ target: role.id, set: restore(ROLE_COLUMNS), setWhere: changesSomething(ROLE_COLUMNS) })
      .returning({ id: role.id }),
  )
  written(
    await tx
      .insert(userAccount)
      .values(USERS)
      .onConflictDoUpdate({ target: userAccount.id, set: restore(USER_COLUMNS), setWhere: changesSomething(USER_COLUMNS) })
      .returning({ id: userAccount.id }),
  )

  // A grant has no fixed id — there are hundreds — so its identity is what it
  // means: the role, the module and the action. The seeded roles' grant set is
  // replaced: anything the charters no longer name goes, the rest is left
  // exactly as it is. A custom role's grants are nobody's business here.
  const roleIds = Object.values(DEMO_IDS.roles)
  const wanted = GRANTS.map((grant) => sql`(${grant.roleId}::uuid, ${grant.moduleKey}, ${grant.action})`)
  written(
    await tx
      .delete(roleGrant)
      .where(
        and(
          eq(roleGrant.companyId, COMPANY_ID),
          inArray(roleGrant.roleId, roleIds),
          sql`(${roleGrant.roleId}, ${roleGrant.moduleKey}, ${roleGrant.action}) not in (${sql.join(wanted, sql`, `)})`,
        ),
      )
      .returning({ id: roleGrant.id }),
  )
  written(
    await tx
      .insert(roleGrant)
      .values(GRANTS)
      .onConflictDoNothing({ target: [roleGrant.companyId, roleGrant.roleId, roleGrant.moduleKey, roleGrant.action] })
      .returning({ id: roleGrant.id }),
  )

  // The access row carries nothing beyond the pair it joins, and the
  // composite key `(company_id, user_account_id, service_provider_id) →
  // user_account` pins that pair to the account's own provider: an edit that
  // moved it to another provider would be refused by the key, not silently
  // kept. So the row is there or it is written, and there is no third state
  // to reconcile.
  written(
    await tx.insert(serviceProviderAccess).values(PROVIDER_ACCESS).onConflictDoNothing({ target: serviceProviderAccess.id }).returning({
      id: serviceProviderAccess.id,
    }),
  )

  return changed
}

/**
 * Writes the demo company to the database the URL names, as its owner, in one
 * transaction. Idempotent: a run that finds everything as it should be reports
 * `changed: 0` and leaves the database untouched.
 */
export async function seedDemo(adminUrl: string): Promise<DemoSeedReport> {
  const { db, close } = createDb(adminUrl, { max: 1 })
  try {
    const changed = await db.transaction((tx) => applyDemo(tx))
    return { companyId: COMPANY_ID, changed, counts: COUNTS }
  } finally {
    await close()
  }
}
