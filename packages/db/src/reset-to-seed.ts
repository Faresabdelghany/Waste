// Reset-to-seed (Issue #142): the demo company swept back to what the seed
// writes. The seed is idempotent but never deletes, so the schemes, routes,
// tickets, movements and invoices testers make on the Pilot pile up until
// something sweeps them; this is that sweep, followed by the seed's own writes
// — never a second spelling of the seed, so a reset lands on whatever the seed
// writes today, "configured, never run" since #143.
//
// One transaction, as the owner (`DATABASE_ADMIN_URL`, BYPASSRLS locally and
// on Supabase), which may delete from the ledgers `appendOnly` guards from
// `wms_api`: the sweep, `applyDemo` — the transaction body `seedDemo`
// runs, called inside this one so the sweep and the seed commit together —
// the counters, and the postconditions. A failure anywhere rolls all of it
// back, so the Pilot's write barrier (#133) is reopened onto the tenant as it
// was or as the seed says, never onto one half swept.
//
// What is swept and what is kept (the Logins question of #142): every row of
// the company in every table but Organisation & Access's eight — the company,
// its projects and service providers, its roles with their grants, its User
// Accounts with their Project and Service Provider Access. Those are kept,
// and the seed writes each seeded one back to what it says (demo.ts: an
// edited name, a grant a charter dropped, an access row it does not name), so
// they return to the seed's word without being deleted, because:
//
//   - a Login stays bound. The seed never writes `auth_user_id`: sweeping the
//     accounts would unbind every Login, the access token hook (migration
//     0005) would re-bind a seeded address only on its next token, and a
//     tester's account made in Users & Roles at their own address would be
//     gone, their Login bound to nothing until an administrator invited them
//     again;
//   - the write barrier already ends every session: the reset runs with
//     `wms_api` and `wms_worker` NOLOGIN, so what a tester mid-session meets
//     is the barrier's 503, and after it the accounts, roles and access they
//     had, on a tenant back at its seed;
//   - `deactivated_at` stays the API's and `auth_user_id` the hook's, as the
//     seed leaves them.
//
// Everything else is swept whole rather than healed row by row, since a
// tester's edit to a column the seed does not own would survive a heal: a
// swept row comes back from the seed with every column as a fresh seed writes
// it. The company's counters are not the seed's columns, so the reset puts
// `next_route_number`, `next_ticket_number` and `next_invoice_number` back to
// their column defaults — what a freshly seeded company holds — itself.
//
// The order is the schema's own: a table is swept before every table it
// references (`sweepOrder`, over the foreign keys the Drizzle schema
// declares), and a key of a table on itself (a ticket's parent, a credit
// note's invoice, a movement's correction) needs no order, since Postgres
// checks it at the end of the one DELETE. A table exported from the schema is
// swept the day it is, in the place its keys give it; reset-to-seed.test.ts
// holds every `wms` table the database has to kept or swept.
//
// Beside the tenant: its outbox rows go with it, and an unpublished one is
// news no relay will now send. Jobs already on pg-boss's queues are not the
// company's rows and are left where they are: a job naming a swept row — a
// `planning.generate-routes` for a run that is gone, an `outbox.<kind>` event
// whose ticket or pickup is gone — fails when a worker takes it, is retried
// under its queue's policy and then failed, and an outbox consumer's copy
// lands on `outbox.dead`, counted by `/readyz` and not to be redriven. The
// reset counts both for the operator to read.
import { isDeepStrictEqual } from "node:util"

import { getTableName, is, sql } from "drizzle-orm"
import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core"

import { createDb, type Tx } from "./client"
import { columnName } from "./names"
import * as schema from "./schema"
import { projectAccess, role, roleGrant, serviceProviderAccess, userAccount } from "./schema/access"
import { outboxEvent } from "./schema/execution"
import { company, project, serviceProvider } from "./schema/organisation"
import { applyDemo, DEMO_IDS } from "./seed/demo"
import { DEMO_COMPANY_ID } from "./seed/ids"
import { PGBOSS_SCHEMA } from "./sql/pgboss"

/** Organisation & Access's eight tables, which the reset keeps: what makes a person able to sign in and be who they are. */
export const KEPT_TABLES: readonly PgTable[] = [company, project, serviceProvider, role, roleGrant, userAccount, projectAccess, serviceProviderAccess]

/** The names of the tables a table's foreign keys point at, itself left out. */
function parentsOf(table: PgTable): Set<string> {
  const own = getTableName(table)
  return new Set(
    getTableConfig(table)
      .foreignKeys.map((key) => getTableName(key.reference().foreignTable))
      .filter((name) => name !== own),
  )
}

/**
 * The tables in an order one DELETE each may clear them in: every table before
 * each table of the set it references. Refuses a cycle by name, which no such
 * order could clear.
 */
export function sweepOrder(tables: readonly PgTable[]): PgTable[] {
  const order: PgTable[] = []
  const left = new Set(tables)
  while (left.size > 0) {
    const referenced = new Set([...left].flatMap((table) => [...parentsOf(table)]))
    const ready = [...left].filter((table) => !referenced.has(getTableName(table)))
    if (ready.length === 0) {
      throw new Error(`sweepOrder: the foreign keys between ${[...left].map(getTableName).join(", ")} form a cycle, so no order of one delete per table clears them`)
    }
    for (const table of ready) {
      order.push(table)
      left.delete(table)
    }
  }
  return order
}

/** Every table the reset sweeps, children first: all of the schema's but the kept eight. */
export const SWEPT_TABLES: readonly PgTable[] = sweepOrder(
  (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable) && !KEPT_TABLES.includes(value)),
)

/** The company's three counters. */
const COUNTERS = { nextRouteNumber: company.nextRouteNumber, nextTicketNumber: company.nextTicketNumber, nextInvoiceNumber: company.nextInvoiceNumber }
type Counters = Record<keyof typeof COUNTERS, number>

/** What a freshly seeded company's counters hold: the columns' own defaults, read off the schema. */
export const COUNTER_DEFAULTS = Object.fromEntries(Object.entries(COUNTERS).map(([key, column]) => [key, column.default as number])) as Counters

export type ResetReport = {
  companyId: string
  /** Rows deleted per table, in the order they were swept; a table the company had no row in is left out. */
  swept: { table: string; rows: number }[]
  /** Rows the seed wrote back: inserted, updated or deleted. */
  written: number
  /** Whether a counter had moved and was put back to its default. */
  countersReset: boolean
  /** Of the outbox rows swept, those no relay had sent: news that is now never published. */
  unsentEvents: number
  /** The company's User Accounts the seed does not name, kept as they were: the Pilot's testers. */
  otherAccounts: number
  /** Jobs waiting on pg-boss's queues (created or retrying) whose data names the company. */
  waitingJobs: number
}

/** Refuses any company but the demo company's: the reset sweeps one tenant, the one whose every row the seed writes back. */
function requireDemoCompany(companyId: string): void {
  if (companyId !== DEMO_COMPANY_ID) {
    throw new Error(`reset-to-seed resets the demo company (${DEMO_COMPANY_ID}) and no other; refused ${companyId}, and nothing was deleted`)
  }
}

function companyColumnOf(table: PgTable): PgColumn {
  const column = getTableConfig(table).columns.find((candidate) => columnName(candidate) === "company_id")
  if (column === undefined) throw new Error(`${getTableName(table)} has no company_id, so the reset cannot tell the demo company's rows from another's`)
  return column
}

/** Deletes every row of the company from the swept tables, children first, and answers the counts. */
async function sweep(tx: Tx, companyId: string): Promise<ResetReport["swept"]> {
  const swept: ResetReport["swept"] = []
  for (const table of SWEPT_TABLES) {
    const rows = (await tx.delete(table).where(sql`${companyColumnOf(table)} = ${companyId}`).returning({ one: sql<number>`1` })).length
    if (rows > 0) swept.push({ table: getTableName(table), rows })
  }
  return swept
}

/** Puts the counters back to their defaults where one moved; answers whether it did. */
async function resetCounters(tx: Tx, companyId: string): Promise<boolean> {
  const moved = sql.join(
    Object.entries(COUNTERS).map(([key, column]) => sql`${column} <> ${COUNTER_DEFAULTS[key as keyof Counters]}`),
    sql` or `,
  )
  const written = await tx.update(company).set(COUNTER_DEFAULTS).where(sql`${company.id} = ${companyId} and (${moved})`).returning({ id: company.id })
  return written.length > 0
}

/** The jobs waiting on pg-boss's queues whose data names the company: `created` and `retry` are the states before `active` in pg-boss's `job_state`. */
async function waitingJobsOf(tx: Tx, companyId: string): Promise<number> {
  const [waiting] = await tx.execute<{ jobs: number }>(
    sql`select count(*)::int as jobs from ${sql.identifier(PGBOSS_SCHEMA)}.job where state < 'active' and data->>'companyId' = ${companyId}`,
  )
  return waiting.jobs
}

/**
 * Sweeps the demo company and writes the seed back, as the owner the URL logs
 * in as, in one transaction that commits only when the postconditions hold:
 * the seed, applied again, finds nothing to change, and the counters are at
 * their defaults. Refuses any other company id before it connects.
 */
export async function resetToSeed(adminUrl: string, companyId: string = DEMO_COMPANY_ID): Promise<ResetReport> {
  requireDemoCompany(companyId)
  const { db, close } = createDb(adminUrl, { max: 1 })
  try {
    return await db.transaction(async (tx) => {
      const waitingJobs = await waitingJobsOf(tx, companyId)
      const [{ unsent }] = await tx
        .select({ unsent: sql<number>`count(*)::int` })
        .from(outboxEvent)
        .where(sql`${outboxEvent.companyId} = ${companyId} and ${outboxEvent.publishedAt} is null`)
      const swept = await sweep(tx, companyId)
      const countersReset = await resetCounters(tx, companyId)
      const written = await applyDemo(tx)

      // The postconditions: the seed, which has the last word, finds nothing left to change, and the counters are a fresh seed's.
      const again = await applyDemo(tx)
      if (again !== 0) throw new Error(`the seed found ${again} rows still to change after the reset, so the reset was rolled back`)
      const [counters] = await tx.select(COUNTERS).from(company).where(sql`${company.id} = ${companyId}`)
      if (!isDeepStrictEqual(counters, COUNTER_DEFAULTS)) {
        throw new Error(`the counters read ${JSON.stringify(counters)} after the reset, not ${JSON.stringify(COUNTER_DEFAULTS)}, so the reset was rolled back`)
      }

      const seededAccounts = sql.join(
        Object.values(DEMO_IDS.users).map((id) => sql`${id}::uuid`),
        sql`, `,
      )
      const [{ others }] = await tx
        .select({ others: sql<number>`count(*)::int` })
        .from(userAccount)
        .where(sql`${userAccount.companyId} = ${companyId} and ${userAccount.id} not in (${seededAccounts})`)
      return { companyId, swept, written, countersReset, unsentEvents: unsent, otherAccounts: others, waitingJobs }
    })
  } finally {
    await close()
  }
}
