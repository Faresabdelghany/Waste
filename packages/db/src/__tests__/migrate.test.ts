import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { databaseUnderTest, withDatabaseName } from "./database"

const database = databaseUnderTest()

// A fresh database per run, so "migrating a fresh database" means exactly that
// and nothing depends on what the shared local database already holds.
describe("migrateDatabase on a fresh database", { skip: database.skip }, () => {
  const name = `waste_migrate_test_${randomUUID().replaceAll("-", "")}`
  let admin: Database
  let freshUrl: string

  before(async () => {
    admin = createDb(database.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    freshUrl = withDatabaseName(database.adminUrl, name)
  })
  after(async () => {
    await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.close()
  })

  test("creates the wms schema, the journal, the extensions, the functions and the API role", async () => {
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
      const [role] = await fresh.sql<{ rolcanlogin: boolean; rolbypassrls: boolean; rolsuper: boolean }[]>`
        select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname = 'wms_api'`
      assert.ok(role, "the wms_api role exists")
      assert.equal(role.rolbypassrls, false)
      assert.equal(role.rolsuper, false)
    } finally {
      await fresh.close()
    }
  })

  test("migrating again applies nothing", async () => {
    await migrateDatabase(freshUrl)
    const fresh = createDb(freshUrl, { max: 1 })
    try {
      const before = await fresh.sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`
      await migrateDatabase(freshUrl)
      const after = await fresh.sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`
      assert.equal(after[0].count, before[0].count)
      assert.equal(Number(after[0].count), 2, "two migrations: the schema and the foundation")
    } finally {
      await fresh.close()
    }
  })
})

describe("migrateDatabase run twice at once", { skip: database.skip }, () => {
  const name = `waste_migrate_race_${randomUUID().replaceAll("-", "")}`
  let admin: Database
  let freshUrl: string

  before(async () => {
    admin = createDb(database.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    freshUrl = withDatabaseName(database.adminUrl, name)
  })
  after(async () => {
    await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
    await admin.close()
  })

  test("both runs succeed and the journal holds each migration once", async () => {
    await Promise.all([migrateDatabase(freshUrl), migrateDatabase(freshUrl)])
    const fresh = createDb(freshUrl, { max: 1 })
    try {
      const rows = await fresh.sql<{ count: string }[]>`select count(*)::text as count from drizzle.__drizzle_migrations`
      assert.equal(Number(rows[0].count), 2)
    } finally {
      await fresh.close()
    }
  })
})
