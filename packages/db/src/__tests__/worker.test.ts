// Migration 0011 against Postgres (Issue #97 part B), on a fresh database of
// this file's own: the worker role as the catalog shows it, what it may and
// may not do in wms — read every table across companies, write none — and
// pg-boss's schema installed at the pinned version with both application
// roles able to run it and neither able to create in it. The worker's own
// boot against that schema is `apps/worker`'s test; this file proves the
// database the worker is given.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE, WORKER_ROLE } from "../roles"
import { company } from "../schema/organisation"
import { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION } from "../sql/pgboss"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBackIn } from "./specimen"

const database = databaseUnderTest()

/** Two companies of this file's own, a nibble telling them apart. */
const companyId = (n: "a" | "b") => `018f7c34-${n}000-7000-8000-000000000001`

describe("migration 0011, the worker role and pg-boss's schema", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_worker_test")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  test("created wms_worker BYPASSRLS and NOLOGIN, no superuser, no replication, granted to the owner, with USAGE on wms and extensions and the API role's search path", async () => {
    const [attributes] = await owner.sql<{ bypassrls: boolean; login: boolean; superuser: boolean; replication: boolean; owner_member: boolean; config: string[] | null }[]>`
      select r.rolbypassrls as bypassrls, r.rolcanlogin as login, r.rolsuper as superuser, r.rolreplication as replication,
        pg_has_role(current_user, ${WORKER_ROLE}, 'MEMBER') as owner_member,
        (select s.setconfig from pg_db_role_setting s where s.setrole = r.oid and s.setdatabase = 0) as config
      from pg_roles r where r.rolname = ${WORKER_ROLE}`
    assert.deepEqual(attributes, { bypassrls: true, login: false, superuser: false, replication: false, owner_member: true, config: ["search_path=wms, extensions"] })
    const [schema] = await owner.sql<{ wms: boolean; extensions: boolean; create: boolean }[]>`
      select has_schema_privilege(${WORKER_ROLE}, 'wms', 'USAGE') as wms, has_schema_privilege(${WORKER_ROLE}, 'extensions', 'USAGE') as extensions, has_schema_privilege(${WORKER_ROLE}, 'wms', 'CREATE') as create`
    assert.deepEqual(schema, { wms: true, extensions: true, create: false })
  })

  test("may SELECT every wms table and write none, and a table created after the migration is readable too", async () => {
    const privileges = await owner.sql<{ table: string; select: boolean; write: boolean }[]>`
      select c.relname as table,
        has_table_privilege(${WORKER_ROLE}, c.oid, 'SELECT') as select,
        has_table_privilege(${WORKER_ROLE}, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') as write
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r'
      order by c.relname`
    assert.ok(privileges.length > 50, `${privileges.length} tables`)
    assert.deepEqual(privileges.filter((row) => !row.select), [], "every table readable")
    assert.deepEqual(privileges.filter((row) => row.write), [], "no write right on any table")
    await owner.sql.begin(async (tx) => {
      await tx`create table wms.worker_specimen_later (id int)`
      const [later] = await tx<{ select: boolean; write: boolean }[]>`
        select has_table_privilege(${WORKER_ROLE}, 'wms.worker_specimen_later', 'SELECT') as select, has_table_privilege(${WORKER_ROLE}, 'wms.worker_specimen_later', 'INSERT') as write`
      assert.deepEqual(later, { select: true, write: false })
      await tx`drop table wms.worker_specimen_later`
    })
  })

  test("as wms_worker, a read crosses companies — the fence bypassed by construction — and a write is refused (42501), where the same write as wms_api under withCompany lands", async () => {
    const row = (n: "a" | "b") => ({ id: companyId(n), companyId: companyId(n), name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `2000000${n === "a" ? 1 : 2}`, country: "DK", status: "active" })
    await rolledBackIn(
      (body) => owner.db.transaction(body),
      async (tx) => {
        await tx.insert(company).values([row("a"), row("b")])
        await tx.execute(sql`set local role ${sql.raw(WORKER_ROLE)}`)
        await tx.execute(sql`set local search_path = wms, extensions`)
        const seen = await tx.select({ id: company.id }).from(company).orderBy(company.id)
        assert.deepEqual(
          seen.map((r) => r.id),
          [companyId("a"), companyId("b")],
          "both companies, with no company set",
        )
        await assert.rejects(tx.transaction((savepoint) => savepoint.insert(company).values({ ...row("a"), id: "018f7c34-c000-7000-8000-000000000001", companyId: "018f7c34-c000-7000-8000-000000000001", registrationNumber: "20000003" })), refusedWith("42501", /permission denied for table company/))
        await assert.rejects(tx.transaction((savepoint) => savepoint.update(company).set({ name: "Renamed" })), refusedWith("42501", /permission denied for table company/))
        await tx.execute(sql`reset role`)
      },
    )
    await rolledBackIn(
      (body) => withCompany(owner.db, companyId("a"), body),
      async (tx) => {
        await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
        await tx.execute(sql`set local search_path = wms, extensions`)
        await tx.insert(company).values(row("a"))
        const seen = await tx.select({ id: company.id }).from(company)
        assert.deepEqual(seen.map((r) => r.id), [companyId("a")], "the API role sees its company alone")
        await tx.execute(sql`reset role`)
      },
    )
  })

  test("installed pg-boss's schema at the pinned version, with both application roles able to use, read, write and execute in it and neither able to create", async () => {
    const [version] = await owner.sql.unsafe<{ version: number }[]>(`select version from ${PGBOSS_SCHEMA}.version`)
    assert.equal(version.version, PGBOSS_SCHEMA_VERSION)
    const tables = await owner.sql<{ table: string }[]>`
      select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${PGBOSS_SCHEMA} and c.relkind in ('r', 'p') order by c.relname`
    // The plan's one DO block makes the queue_stats partitions for the day it runs and the next, so two dated names ride along.
    assert.deepEqual(
      tables.map((row) => row.table).filter((name) => !/^queue_stats_\d{8}$/.test(name)),
      ["bam", "job", "job_common", "job_dependency", "queue", "queue_stats", "schedule", "subscription", "version", "warning"],
    )
    assert.equal(tables.filter((row) => /^queue_stats_\d{8}$/.test(row.table)).length, 2, "today's and tomorrow's queue_stats partitions")
    for (const role of [API_ROLE, WORKER_ROLE]) {
      const [schema] = await owner.sql<{ usage: boolean; create: boolean }[]>`
        select has_schema_privilege(${role}, ${PGBOSS_SCHEMA}, 'USAGE') as usage, has_schema_privilege(${role}, ${PGBOSS_SCHEMA}, 'CREATE') as create`
      assert.deepEqual(schema, { usage: true, create: false }, role)
      const privileges = await owner.sql<{ table: string; ok: boolean }[]>`
        select c.relname as table, has_table_privilege(${role}, c.oid, 'SELECT, INSERT, UPDATE, DELETE') as ok
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${PGBOSS_SCHEMA} and c.relkind in ('r', 'p')`
      assert.deepEqual(privileges.filter((row) => !row.ok), [], `${role} on every table`)
      const functions = await owner.sql<{ name: string; ok: boolean }[]>`
        select p.proname as name, has_function_privilege(${role}, p.oid, 'EXECUTE') as ok
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = ${PGBOSS_SCHEMA}`
      assert.ok(functions.length >= 5, "pg-boss's helper functions")
      assert.deepEqual(functions.filter((row) => !row.ok), [], `${role} on every function`)
    }
  })

  test("as wms_worker, a queue can be created through pg-boss's own function and a job row written into it", async () => {
    await rolledBackIn(
      (body) => owner.db.transaction(body),
      async (tx) => {
        await tx.execute(sql`set local role ${sql.raw(WORKER_ROLE)}`)
        await tx.execute(sql`select ${sql.raw(PGBOSS_SCHEMA)}.create_queue('worker.specimen', '{"policy": "standard"}'::jsonb)`)
        await tx.execute(sql`insert into ${sql.raw(PGBOSS_SCHEMA)}.job (name, data) values ('worker.specimen', '{"n": 1}'::jsonb)`)
        const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.raw(PGBOSS_SCHEMA)}.job where name = 'worker.specimen'`)
        assert.equal(count, 1)
        await tx.execute(sql`reset role`)
      },
    )
  })
})
