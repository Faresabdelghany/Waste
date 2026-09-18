import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"

import { createDb } from "../client"
import { MIGRATIONS_FOLDER, migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { databaseUnderTest, withFreshDatabase } from "./database"

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

// A fresh database per run, so "migrating a fresh database" means exactly that
// and nothing depends on what the shared local database already holds.
describe("migrateDatabase on a fresh database", { skip: database.skip }, () => {
  test("creates the wms schema, the journal, the extensions, the functions and the API role", () =>
    withFreshDatabase(database.adminUrl, "waste_migrate_test", async (freshUrl) => {
      await migrateDatabase(freshUrl)
      const fresh = createDb(freshUrl, { max: 1 })
      try {
        const schemas = await fresh.sql<{ nspname: string }[]>`
          select nspname from pg_namespace where nspname in ('wms', 'drizzle', 'extensions') order by nspname`
        assert.deepEqual(
          schemas.map((row) => row.nspname),
          ["drizzle", "extensions", "wms"],
        )
        const extensions = await fresh.sql<{ extname: string; schema: string }[]>`
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
        const functions = await fresh.sql<{ proname: string }[]>`
          select proname from pg_proc where pronamespace = 'wms'::regnamespace order by proname`
        assert.deepEqual(
          functions.map((row) => row.proname),
          ["current_company_id", "touch_updated_at", "uuidv7"],
        )
        const [role] = await fresh.sql<{ rolbypassrls: boolean; rolsuper: boolean }[]>`
          select rolbypassrls, rolsuper from pg_roles where rolname = ${API_ROLE}`
        assert.ok(role, `the ${API_ROLE} role exists`)
        assert.equal(role.rolbypassrls, false)
        assert.equal(role.rolsuper, false)
      } finally {
        await fresh.close()
      }
    }))

  test("journals each file's sha256 and its `when`, so an edited applied migration is detectable", () =>
    withFreshDatabase(database.adminUrl, "waste_migrate_hash", async (freshUrl) => {
      await migrateDatabase(freshUrl)
      const fresh = createDb(freshUrl, { max: 1 })
      try {
        const rows = await fresh.sql<{ hash: string; created_at: string }[]>`
          select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at`
        assert.deepEqual(
          rows.map(({ hash, created_at }) => ({ hash, when: Number(created_at) })),
          journalEntries().map(({ tag, when }) => ({
            hash: sha256(readFileSync(path.join(MIGRATIONS_FOLDER, `${tag}.sql`), "utf8")),
            when,
          })),
        )
      } finally {
        await fresh.close()
      }
    }))

  test("migrating again applies nothing", () =>
    withFreshDatabase(database.adminUrl, "waste_migrate_again", async (freshUrl) => {
      await migrateDatabase(freshUrl)
      const fresh = createDb(freshUrl, { max: 1 })
      try {
        const before = await fresh.sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`
        await migrateDatabase(freshUrl)
        const after = await fresh.sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`
        assert.equal(after[0].count, before[0].count)
        assert.equal(Number(after[0].count), journalEntries().length)
      } finally {
        await fresh.close()
      }
    }))

  test("run twice at once, both runs succeed and the journal holds each migration once", () =>
    withFreshDatabase(database.adminUrl, "waste_migrate_race", async (freshUrl) => {
      await Promise.all([migrateDatabase(freshUrl), migrateDatabase(freshUrl)])
      const fresh = createDb(freshUrl, { max: 1 })
      try {
        const rows = await fresh.sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`
        assert.equal(Number(rows[0].count), journalEntries().length)
      } finally {
        await fresh.close()
      }
    }))

  test("refuses a database whose PostGIS lives outside the extensions schema, instead of silently leaving it there", () =>
    withFreshDatabase(database.adminUrl, "waste_migrate_postgis_elsewhere", async (freshUrl) => {
      const fresh = createDb(freshUrl, { max: 1 })
      try {
        // A bare `create extension postgis` in a SQL editor lands in public.
        await fresh.sql`create extension postgis`
      } finally {
        await fresh.close()
      }
      await assert.rejects(migrateDatabase(freshUrl), /postgis.*extensions/s)
    }))
})
