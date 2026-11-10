import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createDb, type Database } from "../client"
import { ABANDONED_AFTER_MS, databaseUnderTest, sweepAbandonedDatabases, testDatabaseName, withDatabaseName } from "./database"

const local = {
  DATABASE_ADMIN_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  DATABASE_URL: "postgresql://wms_api:wms_api@127.0.0.1:54322/postgres",
}

describe("databaseUnderTest", () => {
  test("skips, naming the missing variables and the commands, when a URL is missing and nothing requires one", () => {
    const result = databaseUnderTest({})
    assert.match(String(result.skip), /DATABASE_ADMIN_URL and DATABASE_URL are not set/)
    assert.match(String(result.skip), /pnpm db:start/)
    assert.match(String(result.skip), /pnpm db:migrate/)
    assert.match(String(databaseUnderTest({ DATABASE_ADMIN_URL: local.DATABASE_ADMIN_URL }).skip), /^DATABASE_URL is not set/)
  })

  test("fails instead of skipping when REQUIRE_DATABASE is set", () => {
    assert.throws(() => databaseUnderTest({ REQUIRE_DATABASE: "1" }), /DATABASE_ADMIN_URL and DATABASE_URL are not/)
    assert.throws(
      () => databaseUnderTest({ REQUIRE_DATABASE: "1", DATABASE_ADMIN_URL: local.DATABASE_ADMIN_URL }),
      /DATABASE_URL is not/,
    )
  })

  test("runs against loopback hosts, whatever their case", () => {
    assert.equal(databaseUnderTest(local).skip, false)
    assert.equal(
      databaseUnderTest({
        DATABASE_ADMIN_URL: "postgresql://postgres:postgres@LOCALHOST:54322/postgres",
        DATABASE_URL: "postgresql://wms_api:wms_api@[::1]:54322/postgres",
      }).skip,
      false,
    )
  })

  test("refuses a URL that is not the local stack, naming the variable", () => {
    assert.throws(
      () =>
        databaseUnderTest({
          ...local,
          DATABASE_ADMIN_URL: "postgresql://postgres.ref:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres",
        }),
      /DATABASE_ADMIN_URL points at aws-0-eu-north-1\.pooler\.supabase\.com.*local stack only/,
    )
    assert.throws(
      () => databaseUnderTest({ ...local, DATABASE_URL: "postgresql://wms_api.ref:pw@db.ref.supabase.co:5432/postgres" }),
      /DATABASE_URL points at db\.ref\.supabase\.co/,
    )
  })
})

describe("a test database's name", () => {
  test("says when it was made and fits Postgres's 63 bytes beside the longest prefix the suites use", () => {
    const made = Date.UTC(2026, 10, 10, 8, 0, 0)
    const name = testDatabaseName("waste_migrate_postgis_elsewhere", made)
    assert.match(name, /^waste_migrate_postgis_elsewhere_[0-9a-z]{8}_[0-9a-f]{6}$/)
    assert.ok(Buffer.byteLength(name) <= 63, name)
    assert.equal(Number.parseInt(name.split("_").at(-2) ?? "", 36), made)
  })
})

const stack = databaseUnderTest()

describe("sweeping the databases timed-out and killed runs left", { skip: stack.skip }, () => {
  test("drops a test database past the age with no session, and leaves a young one, one in use, and any name of another shape", async () => {
    const admin = createDb(stack.adminUrl, { max: 1 })
    const now = Date.now()
    const old = now - ABANDONED_AFTER_MS - 60_000
    const names = {
      abandoned: testDatabaseName("waste_sweep_test", old),
      young: testDatabaseName("waste_sweep_test", now),
      held: testDatabaseName("waste_sweep_test", old),
      other: `waste_sweep_test_${"0".repeat(32)}`,
    }
    const exists = async (name: string) => (await admin.sql`select 1 from pg_database where datname = ${name}`).length === 1
    let session: Database | undefined
    try {
      for (const name of Object.values(names)) await admin.sql.unsafe(`create database "${name}"`)
      session = createDb(withDatabaseName(stack.adminUrl, names.held), { max: 1 })
      await session.sql`select 1`
      const dropped = await sweepAbandonedDatabases(admin, now)
      // Another run's sweep may take the abandoned one first: what matters is that it is gone, and nothing else of these.
      assert.equal(await exists(names.abandoned), false, "the abandoned one is gone")
      for (const kept of [names.young, names.held, names.other]) {
        assert.equal(await exists(kept), true, kept)
        assert.equal(dropped.includes(kept), false, kept)
      }
    } finally {
      await session?.close()
      for (const name of Object.values(names)) await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
      await admin.close()
    }
  })
})
