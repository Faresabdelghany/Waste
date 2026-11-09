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
// the company in every table but those whose declaration says `kept`
// (schema/policies.ts) — Organisation & Access: the company, its projects and
// service providers, its roles with their grants, its User Accounts with their
// Project and Service Provider Access; and the Holiday Lists, which a kept
// project names by key. Those are kept, and the seed writes each seeded one
// back to what it says (demo.ts: an
// edited name, a system role's scope, a grant a charter dropped, an access
// row it does not name — but never a system role's name or description,
// which are the tenant's once seeded, #291), so they return to the seed's
// word without being deleted, because:
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
// it. A table's document counters are not the seed's columns, so the reset
// puts each counter a table declares back to its column default — what a
// freshly seeded company holds — itself.
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

import { count } from "@waste/domain/text"
import { getTableName, sql } from "drizzle-orm"
import { getTableConfig, type PgColumn, type PgTable } from "drizzle-orm/pg-core"

import { createDb, type Tx } from "./client"
import { columnName } from "./names"
import { userAccount } from "./schema/access"
import { auditEvent } from "./schema/audit"
import { outboxEvent } from "./schema/execution"
import type { Counters } from "./schema/policies"
import { applyDemo, DEMO_IDS } from "./seed/demo"
import { DEMO_COMPANY_ID } from "./seed/ids"
import { PGBOSS_SCHEMA } from "./sql/pgboss"
import { COUNTERS, KEPT_TABLES, TABLES } from "./table-policies"

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

/**
 * Every table the reset sweeps, children first: all of the schema's but the
 * kept ones — and the audit log last, whatever its keys say. The sweep's own
 * deletes of audited tables append to the log as they run, so a log swept in
 * its keys' place, first, would keep a row for every row the reset removed:
 * a reset leaves the tenant with no history but the seed's writing it back
 * (#291, slice 9).
 */
export const SWEPT_TABLES: readonly PgTable[] = [
  ...sweepOrder(TABLES.filter((table) => !KEPT_TABLES.includes(table) && table !== auditEvent)),
  auditEvent,
]

/** What a freshly seeded company's counters hold, by key: the columns' own defaults, read off the schema. */
const defaultsOf = (counters: Counters): Record<string, number> => Object.fromEntries(Object.entries(counters).map(([key, column]) => [key, column.default as number]))

/** Every counter's default, by its field name (`nextRouteNumber`): what the reset puts back. */
export const COUNTER_DEFAULTS: Readonly<Record<string, number>> = Object.fromEntries(COUNTERS.flatMap(({ counters }) => Object.entries(defaultsOf(counters))))

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

async function sweep(tx: Tx, companyId: string): Promise<ResetReport["swept"]> {
  const swept: ResetReport["swept"] = []
  for (const table of SWEPT_TABLES) {
    const rows = (await tx.delete(table).where(sql`${companyColumnOf(table)} = ${companyId}`).returning({ one: sql<number>`1` })).length
    if (rows > 0) swept.push({ table: getTableName(table), rows })
  }
  return swept
}

async function resetCounters(tx: Tx, companyId: string): Promise<boolean> {
  let reset = false
  for (const { table, counters } of COUNTERS) {
    const moved = sql.join(
      Object.values(counters).map((column) => sql`${column} <> ${column.default as number}`),
      sql` or `,
    )
    const written = await tx
      .update(table)
      .set(defaultsOf(counters))
      .where(sql`${companyColumnOf(table)} = ${companyId} and (${moved})`)
      .returning({ one: sql<number>`1` })
    reset ||= written.length > 0
  }
  return reset
}

/** The rows of a table whose counters are not their defaults after the reset: none, or the reset is rolled back. */
async function countersOffDefault(tx: Tx, companyId: string): Promise<string[]> {
  const off: string[] = []
  for (const { table, counters } of COUNTERS) {
    const rows = await tx.select(counters).from(table).where(sql`${companyColumnOf(table)} = ${companyId}`)
    const defaults = defaultsOf(counters)
    for (const row of rows) if (!isDeepStrictEqual(row, defaults)) off.push(`${getTableName(table)} ${JSON.stringify(row)}, not ${JSON.stringify(defaults)}`)
  }
  return off
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

      const again = await applyDemo(tx)
      if (again !== 0) throw new Error(`the seed found ${again} rows still to change after the reset, so the reset was rolled back`)
      const off = await countersOffDefault(tx, companyId)
      if (off.length > 0) throw new Error(`the counters read ${off.join("; ")} after the reset, so the reset was rolled back`)

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

const listed = (items: readonly string[]): string => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)

/** What a reset says, line by line, for a run's summary: what it swept and kept, what the seed wrote back, and what became of the audit history, the outbox and pg-boss's jobs. */
export function spellReset(report: ResetReport, adminUrl: string): string[] {
  // The audit log is said apart from the state it is the history of (#291): a reset clears it.
  const state = report.swept.filter(({ table }) => table !== getTableName(auditEvent))
  const history = report.swept.find(({ table }) => table === getTableName(auditEvent))?.rows ?? 0
  const rows = state.reduce((total, { rows: swept }) => total + swept, 0)
  // A counter's series by its field: `nextScaleTicketNumber` is the scale-ticket counter.
  const series = Object.keys(COUNTER_DEFAULTS).map((field) =>
    field
      .replace(/^next|Number$/g, "")
      .replace(/(?<!^)([A-Z])/g, "-$1")
      .toLowerCase(),
  )
  const values = Object.values(COUNTER_DEFAULTS).map(String)
  return [
    `Reset the demo company ${report.companyId} on ${new URL(adminUrl).hostname} to its seed, in one transaction.`,
    `Swept ${count(rows, "row")} from ${count(state.length, "table")}, children first${state.map(({ table, rows: swept }) => `, ${table} ${swept}`).join("")}.`,
    `Kept Organisation & Access — the company, its projects, service providers, roles, grants, User Accounts and their access — so every Login stays bound; ` +
      `the seeded rows are back at the seed's word, and ${count(report.otherAccounts, "account")} the seed does not name ${report.otherAccounts === 1 ? "is" : "are"} as it was.`,
    `The seed wrote ${count(report.written, "row")}; the ${listed(series)} counters ${report.countersReset ? "were put back to" : "were already at"} ${listed(values)}, as a fresh seed leaves them.`,
    `Audit history: the company's ${count(history, "row")} went with the sweep; the trail begins again with the seed writing the tenant back.`,
    report.unsentEvents === 0 ? "Outbox: no unpublished event was swept." : `Outbox: ${count(report.unsentEvents, "unpublished event")} went with the sweep and will never be relayed.`,
    report.waitingJobs === 0
      ? "pg-boss: no waiting job names the company."
      : `pg-boss: ${count(report.waitingJobs, "waiting job")} still ${report.waitingJobs === 1 ? "names" : "name"} the company and ${report.waitingJobs === 1 ? "is" : "are"} left on ${report.waitingJobs === 1 ? "its queue" : "their queues"}: ` +
        "when a worker takes one it meets a tenant without the rows it names, and either finds nothing to do or fails, is retried and ends failed — an outbox consumer's copy on outbox.dead, which is not to be redriven.",
  ]
}
