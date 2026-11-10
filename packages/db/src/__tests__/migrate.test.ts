import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "../client"
import { MIGRATIONS_FOLDER, migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { databaseUnderTest, freshDatabase, withFreshDatabase, type FreshDatabase } from "./database"

const database = databaseUnderTest()

const journalEntries = (): { when: number; tag: string }[] =>
  JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")).entries
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

describe("migrateDatabase refuses what cannot work", () => {
  test("a transaction-pooler URL: session-level locks and the journal need one backend", async () => {
    await assert.rejects(
      migrateDatabase("postgresql://postgres.ref:pw@aws-0-eu-north-1.pooler.supabase.com:6543/postgres"),
      /6543 is the transaction pooler.*migrations need a session/s,
    )
  })
})

// A fresh database of this file's own, so "migrating a fresh database" means
// exactly that and nothing depends on what the shared local database already
// holds. It is migrated once, by two runs at once — the race is its first
// migration — and the tests read what that made; every other suite migrates
// its fresh database with a single run. One migration of every file, not
// four: four, one after another, outran the runner's budget for the file
// under a shared stack's load.
describe("migrateDatabase on a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database
  /** How the two runs at once ended, and how many rows the journal held after them. */
  let race: { outcomes: PromiseSettledResult<unknown>[]; rows: number }

  const journalRows = async (): Promise<number> => {
    const [{ count }] = await owner.sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`
    return Number(count)
  }

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_migrate_test")
    const outcomes = await Promise.allSettled([migrateDatabase(fresh.url), migrateDatabase(fresh.url)])
    // Where neither run migrated there is no journal to read: say why they failed, not that the journal is missing.
    const reasons = outcomes.flatMap((outcome) => (outcome.status === "rejected" ? [outcome.reason as unknown] : []))
    if (reasons.length === outcomes.length) throw new AggregateError(reasons, `both runs failed, so the database was never migrated:\n${reasons.map(String).join("\n")}`)
    owner = createDb(fresh.url, { max: 1 })
    race = { outcomes, rows: await journalRows() }
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  test("creates the wms schema, the journal, the extensions, the functions and the API role", async () => {
    const schemas = await owner.sql<{ nspname: string }[]>`
      select nspname from pg_namespace where nspname in ('wms', 'drizzle', 'extensions') order by nspname`
    assert.deepEqual(
      schemas.map((row) => row.nspname),
      ["drizzle", "extensions", "wms"],
    )
    const extensions = await owner.sql<{ extname: string; schema: string }[]>`
      select extname, extnamespace::regnamespace::text as schema
      from pg_extension where extname in ('postgis', 'btree_gist') order by extname`
    // postgres.js rows come back in a Result (an Array subclass): compare plain values.
    assert.deepEqual(
      extensions.map(({ extname, schema }) => ({ extname, schema })),
      [
        { extname: "btree_gist", schema: "extensions" },
        { extname: "postgis", schema: "extensions" },
      ],
    )
    const functions = await owner.sql<{ proname: string }[]>`
      select proname from pg_proc where pronamespace = 'wms'::regnamespace order by proname`
    assert.deepEqual(
      functions.map((row) => row.proname),
      ["audit_row", "current_company_id", "outbox_event_route_problem", "touch_updated_at", "uuidv7"],
    )
    const [role] = await owner.sql<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
      select rolbypassrls, rolsuper from pg_roles where rolname = ${API_ROLE}`
    assert.ok(role, `the ${API_ROLE} role exists`)
    assert.equal(role.rolbypassrls, false)
    assert.equal(role.rolsuper, false)
  })

  test("journals each file's sha256 and its `when`, so an edited applied migration is detectable", async () => {
    const rows = await owner.sql<{ hash: string; created_at: string }[]>`
      select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at`
    assert.deepEqual(
      rows.map(({ hash, created_at }) => ({ hash, when: Number(created_at) })),
      journalEntries().map(({ tag, when }) => ({
        hash: sha256(readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8")),
        when,
      })),
    )
  })

  test("migrating again applies nothing", async () => {
    const before = await journalRows()
    await migrateDatabase(fresh.url)
    const after = await journalRows()
    assert.equal(after, before)
    assert.equal(after, journalEntries().length)
  })

  test("run twice at once, both runs succeed and the journal holds each migration once", () => {
    assert.deepEqual(
      race.outcomes.map((outcome) => outcome.status),
      ["fulfilled", "fulfilled"],
      race.outcomes.map((outcome) => (outcome.status === "rejected" ? String(outcome.reason) : "fulfilled")).join("\n"),
    )
    assert.equal(race.rows, journalEntries().length)
  })

  test("refuses a database whose PostGIS lives outside the extensions schema, instead of silently leaving it there", () =>
    withFreshDatabase(database.adminUrl, "waste_migrate_postgis_elsewhere", async (freshUrl) => {
      const elsewhere = createDb(freshUrl, { max: 1 })
      try {
        // A bare `create extension postgis` in a SQL editor lands in public.
        await elsewhere.sql`create extension postgis`
      } finally {
        await elsewhere.close()
      }
      await assert.rejects(migrateDatabase(freshUrl), /postgis.*extensions/s)
    }))
})
