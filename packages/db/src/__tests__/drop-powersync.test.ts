// PowerSync's side removed (2026-11-06, the owner's decision on #574): the
// migration is hand-written whole, drizzle-kit generating nothing for it —
// the publication dropped, the role's rights in its own database revoked,
// and the role dropped unless another database of the cluster still holds a
// right of it or a lock on it, in which case the file applies all the same
// and the last database to let go drops it. The file is found by its name.
// Then, on a fresh database migrated to the head: no publication, and
// nothing of the database depends on the role. The drop's tolerance is
// exercised on a role of the test's own, the same statement but for the
// name, so no other suite's migrations ever see it.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { createDb, type Database } from "../client"
import { migrateDatabase, MIGRATIONS_FOLDER } from "../migrate"
import { normalised, statementsOf } from "../sql/hand-written"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"

const ROLE = "wms_sync"

const dropRole = (role: string) => `DO $$
DECLARE
  waits text := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '100ms', true);
  BEGIN
    DROP ROLE IF EXISTS ${role};
  EXCEPTION
    WHEN dependent_objects_still_exist OR lock_not_available THEN
      NULL;
  END;
  PERFORM set_config('lock_timeout', waits, true);
END
$$;`

const STATEMENTS = ["DROP PUBLICATION IF EXISTS powersync;", `REVOKE ALL ON ALL TABLES IN SCHEMA wms FROM ${ROLE};`, `REVOKE ALL ON SCHEMA wms FROM ${ROLE};`, dropRole(ROLE)]

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_drop_powersync\.sql$/.test(name))
  assert.ok(file !== undefined, "PowerSync's removal")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("PowerSync's removal as the migration writes it", () => {
  test("drizzle-kit writes nothing for it: no table changes", async () => {
    const own = (await migrationName()).slice(0, 4)
    assert.deepEqual(await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own)), [])
  })

  test("is the publication dropped, the role's rights in the schema revoked, then the role dropped where nothing else holds it", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), STATEMENTS.map(normalised))
    assert.match(text, /^-- PowerSync's side removed/)
  })
})

const database = databaseUnderTest()

describe("PowerSync's removal against a database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database
  let other: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_drop_powersync")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 1 })
    other = createDb(fresh.url, { max: 1 })
  })
  after(async () => {
    await Promise.allSettled([owner?.close(), other?.close()])
    await fresh?.drop()
  })

  test("a database at the head publishes nothing for PowerSync and grants its role nothing", async () => {
    const [{ publications, dependencies }] = await owner.sql<{ publications: number; dependencies: number }[]>`
      select (select count(*)::int from pg_publication where pubname = 'powersync') as publications,
             (select count(*)::int from pg_shdepend d join pg_roles r on d.refclassid = 'pg_authid'::regclass and r.oid = d.refobjid
               where r.rolname = ${ROLE} and d.dbid = (select oid from pg_database where datname = current_database())) as dependencies`
    assert.deepEqual({ publications, dependencies }, { publications: 0, dependencies: 0 })
  })

  describe("the drop, on a role of this test's own", () => {
    const role = `wms_sync_${randomUUID().replaceAll("-", "").slice(0, 12)}`
    const exists = async () => (await owner.sql`select 1 from pg_roles where rolname = ${role}`).length === 1

    before(async () => {
      await owner.sql.unsafe(`create role ${role} nologin`)
    })
    after(async () => {
      await owner.sql.unsafe(`revoke all on schema wms from ${role}`).catch(() => undefined)
      await owner.sql.unsafe(`drop role if exists ${role}`)
    })

    test("gives up without error while a database still grants the role a right, and keeps the caller's lock_timeout", async () => {
      await owner.sql.unsafe(`grant usage on schema wms to ${role}`)
      const kept = await owner.sql.begin(async (tx) => {
        await tx.unsafe("set local lock_timeout = '7s'")
        await tx.unsafe(dropRole(role))
        const [{ lock_timeout }] = await tx.unsafe<{ lock_timeout: string }[]>("show lock_timeout")
        return lock_timeout
      })
      assert.equal(kept, "7s")
      assert.equal(await exists(), true)
      await owner.sql.unsafe(`revoke all on schema wms from ${role}`)
    })

    test("waits only a moment on another transaction's lock on the role, then gives up", async () => {
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let locked!: () => void
      const holding = new Promise<void>((resolve) => (locked = resolve))
      // A migration in flight: its grant holds a lock on the role until it ends, here in a rollback.
      const holder = other.sql
        .begin(async (tx) => {
          await tx.unsafe(`grant usage on schema wms to ${role}`)
          locked()
          await released
          throw new Error("rolled back")
        })
        .catch(() => undefined)
      await holding
      const started = Date.now()
      await owner.sql.unsafe(dropRole(role))
      assert.ok(Date.now() - started < 5_000, "never waited out the other transaction")
      assert.equal(await exists(), true)
      release()
      await holder
    })

    test("drops the role once nothing holds it", async () => {
      await owner.sql.unsafe(dropRole(role))
      assert.equal(await exists(), false)
    })
  })
})
