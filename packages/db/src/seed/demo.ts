// The demo company, as `pnpm db:seed` writes it (Issue #70, slice 2): the
// tenant the prototype has always shown — Kystbyen Renovation, its three
// projects with their working weeks (Issue #97), the two service providers it
// works with, the eleven seeded roles with their grants, and the three
// accounts the Pilot signs in with (Issue #140): Fares Abdelghany, the primary
// administrator; Lars Mikkelsen, NordRen's Service Provider Manager; and Mads
// Jensen, on the Driver role, with Project Access to Copenhagen Central alone
// — and, since 2026-09-25, its Registry: the catalogue, the customers with
// their properties, groups and shared points, the agreements with their
// subscriptions, and the containers with their placements, derived from the
// web prototype's fixtures in registry.ts and written in the same transaction
// — and, since #156, the pilot's configuration on top of it: Resources' fleet
// and places (resources.ts), Planning's areas, calendars and two route
// schemes (planning.ts) and Finance's default price lists (finance.ts). The
// seed writes configuration and identity only, never an operational row — no
// route, run, session, ticket or invoice (#143) — so a tenant it resets is
// "configured, never run", and it never needs a running worker.
//
// Three properties make this a seed and not a fixture script:
//
//   Fixed ids. Every record's id is spelled below or derived by ids.ts, a UUID
//   version 7 by hand, so the local database and the hosted project hold the
//   same company: a token minted against the hosted project opens the same
//   rows locally, and a test may name a row without looking it up. A test
//   holds their shape. A role grant and a Project Access are the two kinds of
//   row with no fixed id; each is what it joins (applyDemo). A member of a set
//   the API replaces whole — a calendar's holidays, a group's picks — has one
//   until the first edit through the product rewrites the set under ids the
//   API mints; from then on it is its content (upsert.ts's `replaceSets`).
//
//   Idempotent. A record is written `on conflict (id) do update` (upsert.ts),
//   and the update is skipped when the stored row already says what this run
//   proposes; a grant or an access row, which is nothing but what it joins,
//   is written `on conflict do nothing` keyed by that. So a second run writes
//   nothing at all — not even an `updated_at` through the touch trigger. What
//   someone edited by hand is put back; what the seed does not own is left
//   alone (an account's `auth_user_id` and `deactivated_at` are the hook's
//   and the API's, never the seed's). Nothing is deleted but a grant a
//   charter dropped, an access row of a seeded account that the seed does
//   not name, and a seeded set that no longer says what the seed says, which
//   is replaced whole as the API would replace it. One edit is beyond putting
//   back: a seeded row of a period the product has versioned — ended, with a
//   successor in force after it (a boundary, a scheme, a price row, the
//   Registry's agreements alike) — since restoring its end would overlap the
//   successor, and the exclusion constraint stops the run (23P01) with
//   nothing written. #142's sweep has to remove such successors before it
//   seeds, and a `release` with `run_seed` over a tenant the office has
//   versioned needs the same first.
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
//   fares.abdelghany@kystbyen.example, lars.mikkelsen@nordren.example and
//   mads.jensen@kystbyen.example — the access token hook binds a first
//   sign-in by e-mail across the whole database, and of two open invitations
//   of one address it binds neither (migration 0005), so an account elsewhere
//   with one of these addresses would keep the seeded one from ever being
//   bound. A test account takes an address on a random `.example` domain.
//
//   The `01a0d2a4-a280-7…` id bucket — every id below is spelled by hand in
//   it. A test row minted from the clock lands far from it, but a hand-written
//   test id must not.
//
// The reverse holds too: the seed must not write over what a test owns, which
// `seed.test.ts` checks for the one company a test file commits rows under.
import { normaliseGrants } from "@waste/domain/access/grants"
import { SYSTEM_ROLES, type SystemRoleKey } from "@waste/domain/access/system-roles"
import { and, eq, inArray, sql } from "drizzle-orm"

import { createDb, type Tx } from "../client"
import { projectAccess, role, roleGrant, serviceProviderAccess, userAccount } from "../schema/access"
import { company, project, serviceProvider } from "../schema/organisation"
import { applyFinance, FINANCE_COUNTS, FINANCE_IDS, type FinanceCounts } from "./finance"
import { DEMO_COMPANY_ID, DEMO_PROJECT_IDS, DEMO_SERVICE_PROVIDER_IDS, DEMO_USER_IDS } from "./ids"
import { applyPlanning, PLANNING_COUNTS, PLANNING_IDS, type PlanningCounts } from "./planning"
import { applyRegistry, REGISTRY_COUNTS, REGISTRY_IDS, type RegistryCounts } from "./registry"
import { applyResources, RESOURCES_COUNTS, RESOURCES_IDS, type ResourcesCounts } from "./resources"
import { upsertOwned } from "./upsert"

/**
 * Every id the seed writes. UUID version 7 by hand (ids.ts has the scheme):
 * the first twelve hex digits are a millisecond (2026-09-24, when the seed was
 * written), the third group's `7` the version and its other digits the kind
 * of record, the fourth group's `8` the variant, and the rest an ordinal — a
 * random-looking constant is harder to recognise in a log than a counted one,
 * and these are demo data, not secrets. The Registry's ids under `registry`
 * are keyed by the prototype's own record ids (registry.ts).
 */
export const DEMO_IDS = {
  company: DEMO_COMPANY_ID,
  projects: DEMO_PROJECT_IDS,
  serviceProviders: DEMO_SERVICE_PROVIDER_IDS,
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
  users: DEMO_USER_IDS,
  serviceProviderAccess: {
    lars: "01a0d2a4-a280-7006-8000-000000000001",
  },
  registry: REGISTRY_IDS,
  resources: RESOURCES_IDS,
  planning: PLANNING_IDS,
  finance: FINANCE_IDS,
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

// Each project carries its working week (Issue #97): the days it rests on,
// spelled even where they are the column's default, so that what the seed
// proposes is the whole row and a changed default cannot move a demo project;
// and the name of the holiday list its holidays are looked up under, null for
// a project that rests on its weekend only.
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
    weekend: ["saturday", "sunday"],
    holidayList: "Danish public holidays",
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
    weekend: ["saturday", "sunday"],
    holidayList: null,
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
    weekend: ["friday", "saturday"],
    holidayList: "Egyptian public holidays",
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

// Each account is an Invitation (`invited`) until Supabase Auth's access token
// hook binds a Login to it on first sign-in: `auth_user_id` is null here and
// stays the hook's. No e-mail is ever sent on the Pilot (#129), so an address
// is only what the hook matches a Login on, and each sits on a reserved
// `.example` domain that names nobody's inbox; the Pilot's Logins carry the
// same three. Nobody else is seeded: a tester's account is made in Users &
// Roles on the Pilot at their real address, and so is a second driver's,
// never by widening this list. The prototype keeps its fixture address in
// lib/data/demo-accounts.ts until Issue 5.
const USERS: (typeof userAccount.$inferInsert)[] = [
  {
    id: DEMO_IDS.users.fares,
    companyId: COMPANY_ID,
    email: "fares.abdelghany@kystbyen.example",
    fullName: "Fares Abdelghany",
    roleId: DEMO_IDS.roles["company-administrator"],
    allProjects: true,
    primaryAdministrator: true,
  },
  {
    // Kept so the provider authorization model stays represented (#129).
    id: DEMO_IDS.users.lars,
    companyId: COMPANY_ID,
    email: "lars.mikkelsen@nordren.example",
    fullName: "Lars Mikkelsen",
    roleId: DEMO_IDS.roles["service-provider-manager"],
    serviceProviderId: DEMO_IDS.serviceProviders.nordren,
  },
  {
    // The driver persona whose Login the Driver App's testers share (#145);
    // the driver profile naming this account comes with #156 (decided in #143).
    id: DEMO_IDS.users.mads,
    companyId: COMPANY_ID,
    email: "mads.jensen@kystbyen.example",
    fullName: "Mads Jensen",
    roleId: DEMO_IDS.roles.driver,
  },
]

/**
 * The addresses the seeded accounts carry, in the seed's order: what the
 * local stack's Login tooling (`pnpm db:logins`, #151) creates a confirmed
 * Login for, read from here so the list is spelled once — the Pilot's Logins
 * carry the same three.
 */
export const DEMO_ACCOUNT_EMAILS: readonly string[] = USERS.map((user) => user.email)

// Mads works in Copenhagen Central alone. The row has no fixed id: like a
// grant, it is the pair it joins (applyDemo).
const PROJECT_ACCESS: (typeof projectAccess.$inferInsert)[] = [
  { companyId: COMPANY_ID, userAccountId: DEMO_IDS.users.mads, projectId: DEMO_IDS.projects.copenhagen },
]

// Lars's is first written under its fixed id; from then on it too is the
// pair it joins.
const PROVIDER_ACCESS: (typeof serviceProviderAccess.$inferInsert)[] = [
  {
    id: DEMO_IDS.serviceProviderAccess.lars,
    companyId: COMPANY_ID,
    userAccountId: DEMO_IDS.users.lars,
    serviceProviderId: DEMO_IDS.serviceProviders.nordren,
  },
]

/** What the seed says the company holds: Organisation & Access by name, then the Registry's fifteen tables and the configuration's twenty. */
export type DemoSeedCounts = {
  projects: number
  serviceProviders: number
  roles: number
  roleGrants: number
  users: number
  projectAccess: number
  serviceProviderAccess: number
} & RegistryCounts &
  ResourcesCounts &
  PlanningCounts &
  FinanceCounts

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
  projectAccess: PROJECT_ACCESS.length,
  serviceProviderAccess: PROVIDER_ACCESS.length,
  ...REGISTRY_COUNTS,
  ...RESOURCES_COUNTS,
  ...PLANNING_COUNTS,
  ...FINANCE_COUNTS,
}

const COMPANY_COLUMNS = [company.name, company.legalName, company.registrationNumber, company.country, company.status]
const PROJECT_COLUMNS = [project.name, project.kind, project.language, project.currency, project.timezone, project.status, project.weekend, project.holidayList]
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
export async function applyDemo(tx: Tx): Promise<number> {
  let changed = 0
  const written = (rows: { id: string }[]) => {
    changed += rows.length
  }

  changed += await upsertOwned(tx, company, [COMPANY], COMPANY_COLUMNS)
  changed += await upsertOwned(tx, project, PROJECTS, PROJECT_COLUMNS)
  changed += await upsertOwned(tx, serviceProvider, SERVICE_PROVIDERS, SERVICE_PROVIDER_COLUMNS)
  changed += await upsertOwned(tx, role, ROLES, ROLE_COLUMNS)

  // A seeded account's access is the seed's, as a seeded role's grants are.
  // An access row carries nothing but the pair it joins, so the pair is its
  // identity, not its id: the API replaces an account's access rows under new
  // ids whenever its access is edited, and a row keyed by its id would meet
  // its own pair under another id on the next run. Any access row of a seeded
  // account that the seed does not name goes first, before the accounts are
  // written back: an account the API moved to another provider cannot take
  // its seeded provider back while that provider's access row still names it.
  const accountIds = Object.values(DEMO_IDS.users)
  const namedProjects = PROJECT_ACCESS.map((row) => sql`(${row.userAccountId}::uuid, ${row.projectId}::uuid)`)
  const namedProviders = PROVIDER_ACCESS.map((row) => sql`(${row.userAccountId}::uuid, ${row.serviceProviderId}::uuid)`)
  written(
    await tx
      .delete(projectAccess)
      .where(
        and(
          eq(projectAccess.companyId, COMPANY_ID),
          inArray(projectAccess.userAccountId, accountIds),
          sql`(${projectAccess.userAccountId}, ${projectAccess.projectId}) not in (${sql.join(namedProjects, sql`, `)})`,
        ),
      )
      .returning({ id: projectAccess.id }),
  )
  written(
    await tx
      .delete(serviceProviderAccess)
      .where(
        and(
          eq(serviceProviderAccess.companyId, COMPANY_ID),
          inArray(serviceProviderAccess.userAccountId, accountIds),
          sql`(${serviceProviderAccess.userAccountId}, ${serviceProviderAccess.serviceProviderId}) not in (${sql.join(namedProviders, sql`, `)})`,
        ),
      )
      .returning({ id: serviceProviderAccess.id }),
  )
  changed += await upsertOwned(tx, userAccount, USERS, USER_COLUMNS)

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

  // The access rows the seed names, each written only where its pair is absent.
  written(
    await tx
      .insert(projectAccess)
      .values(PROJECT_ACCESS)
      .onConflictDoNothing({ target: [projectAccess.companyId, projectAccess.userAccountId, projectAccess.projectId] })
      .returning({ id: projectAccess.id }),
  )
  written(
    await tx
      .insert(serviceProviderAccess)
      .values(PROVIDER_ACCESS)
      .onConflictDoNothing({ target: [serviceProviderAccess.companyId, serviceProviderAccess.userAccountId, serviceProviderAccess.serviceProviderId] })
      .returning({ id: serviceProviderAccess.id }),
  )

  // The Registry next: its rows name the company and the projects above.
  changed += await applyRegistry(tx)
  // Then the configuration, which names the Registry's rows: Resources first,
  // since Planning's schemes and groups name its depot, fleet and vehicle
  // types, and Finance's rows the Registry's products and customers.
  changed += await applyResources(tx)
  changed += await applyPlanning(tx)
  changed += await applyFinance(tx)

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
