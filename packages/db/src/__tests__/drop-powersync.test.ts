// PowerSync's side removed (2026-11-06, the owner's decision on #574): the
// publication dropped, the role's rights in its own database revoked, and the
// role dropped unless another database of the cluster still holds a right of
// it or a lock on it, in which case the migration applies all the same, says
// so in a NOTICE, and the last database to let go drops it. On a fresh
// database migrated to the head: no publication, and nothing of the database
// depends on the role. The drop's tolerance is exercised on a role of the
// test's own, the migration's statement but for the name, so no other suite's
// migrations ever see it.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
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
      RAISE NOTICE '${role} kept: % (another database of the cluster still holds it, and the last to let go drops it)', SQLERRM;
  END;
  PERFORM set_config('lock_timeout', waits, true);
END
$$;`

const database = databaseUnderTest()

describe("PowerSync's removal against a database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database
  let other: Database
  const notices: string[] = []

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_drop_powersync")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 1, onnotice: (notice) => void notices.push(notice.message) })
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

    test("gives up without error while a database still grants the role a right, says so, and keeps the caller's lock_timeout", async () => {
      await owner.sql.unsafe(`grant usage on schema wms to ${role}`)
      notices.length = 0
      const kept = await owner.sql.begin(async (tx) => {
        await tx.unsafe("set local lock_timeout = '7s'")
        await tx.unsafe(dropRole(role))
        const [{ lock_timeout }] = await tx.unsafe<{ lock_timeout: string }[]>("show lock_timeout")
        return lock_timeout
      })
      assert.equal(kept, "7s")
      assert.equal(await exists(), true)
      assert.equal(notices.length, 1)
      assert.match(notices[0], new RegExp(`^${role} kept: role "${role}" cannot be dropped because some objects depend on it \\(another database`))
      await owner.sql.unsafe(`revoke all on schema wms from ${role}`)
    })

    test("waits only a moment on another transaction's lock on the role, then gives up, saying so", async () => {
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
      notices.length = 0
      const started = Date.now()
      await owner.sql.unsafe(dropRole(role))
      assert.ok(Date.now() - started < 5_000, "never waited out the other transaction")
      assert.equal(await exists(), true)
      assert.equal(notices.length, 1)
      assert.match(notices[0], new RegExp(`^${role} kept: canceling statement due to lock timeout`))
      release()
      await holder
    })

    test("drops the role once nothing holds it, and says nothing", async () => {
      notices.length = 0
      await owner.sql.unsafe(dropRole(role))
      assert.equal(await exists(), false)
      assert.deepEqual(notices, [])
    })
  })
})
