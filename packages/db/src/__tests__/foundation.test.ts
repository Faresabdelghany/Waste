import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { grantLogin } from "../bootstrap"
import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

/** The Unix milliseconds encoded in the first 48 bits of a UUID version 7. */
const timestampOf = (id: string): number => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)

/** The planner's view of a one-row query: the Output lines of `explain verbose`. */
const plannedOutput = async (admin: Database, query: string): Promise<string> => {
  const rows = await admin.sql.unsafe<{ "QUERY PLAN": string }[]>(`explain (verbose, costs off) ${query}`)
  return rows.map((row) => row["QUERY PLAN"]).join("\n")
}

describe("the foundation migration", { skip: database.skip }, () => {
  let admin: Database

  before(async () => {
    await migrateDatabase(database.adminUrl)
    admin = createDb(database.adminUrl, { max: 2 })
  })
  after(() => admin.close())

  test("wms.uuidv7() mints lowercase version-7 ids that order by time", async () => {
    const started = Date.now()
    const rows = await admin.sql<{ id: string }[]>`select wms.uuidv7()::text as id from generate_series(1, 1000)`
    const finished = Date.now()
    assert.equal(rows.length, 1000)
    for (const { id } of rows) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      const at = timestampOf(id)
      assert.ok(at >= started - 5_000 && at <= finished + 5_000, `${id} carries a current timestamp`)
    }
    for (let index = 1; index < rows.length; index += 1) {
      assert.ok(timestampOf(rows[index].id) >= timestampOf(rows[index - 1].id), "timestamps never go backwards")
    }
    assert.equal(new Set(rows.map((row) => row.id)).size, 1000, "all distinct")
  })

  test("wms.current_company_id() is null until the transaction sets it", async () => {
    const [unset] = await admin.sql<{ id: string | null }[]>`select wms.current_company_id() as id`
    assert.equal(unset.id, null)
    const company = "018f7c2e-0000-7000-8000-000000000001"
    const inside = await admin.sql.begin(async (tx) => {
      await tx`select set_config('wms.company_id', ${company}, true)`
      const [row] = await tx<{ id: string | null }[]>`select wms.current_company_id() as id`
      return row.id
    })
    assert.equal(inside, company)
    const [afterwards] = await admin.sql<{ id: string | null }[]>`select wms.current_company_id() as id`
    assert.equal(afterwards.id, null, "a transaction-local setting does not leak")
    const blank = await admin.sql.begin(async (tx) => {
      await tx`select set_config('wms.company_id', '', true)`
      const [row] = await tx<{ id: string | null }[]>`select wms.current_company_id() as id`
      return row.id
    })
    assert.equal(blank, null, "an empty setting counts as not set")
  })

  test("the SQL functions inline: the fence predicate and the id default cost an expression per row, not a call", async () => {
    // A SQL function with a SET clause is never inlined; these carry none and
    // bind their names at creation instead (BEGIN ATOMIC), so the planner
    // expands them. The expanded body is what shows in the plan.
    const fence = await plannedOutput(admin, "select wms.current_company_id()")
    assert.match(fence, /NULLIF\(current_setting\('wms\.company_id'::text, true\)/)
    assert.doesNotMatch(fence, /current_company_id\(\)/)
    const id = await plannedOutput(admin, "select wms.uuidv7()")
    assert.match(id, /gen_random_uuid\(\)/)
    assert.doesNotMatch(id, /uuidv7\(\)/)
  })

  test("the Data API roles cannot reach wms; wms_api can, without bypassing RLS", async () => {
    const [privileges] = await admin.sql<Record<string, boolean>[]>`
      select
        has_schema_privilege('anon', 'wms', 'USAGE') as anon,
        has_schema_privilege('authenticated', 'wms', 'USAGE') as authenticated,
        has_schema_privilege('service_role', 'wms', 'USAGE') as service_role,
        has_schema_privilege(${API_ROLE}, 'wms', 'USAGE') as wms_api,
        has_schema_privilege(${API_ROLE}, 'extensions', 'USAGE') as wms_api_extensions,
        (select rolbypassrls from pg_roles where rolname = ${API_ROLE}) as wms_api_bypasses`
    assert.deepEqual(privileges, {
      anon: false,
      authenticated: false,
      service_role: false,
      wms_api: true,
      wms_api_extensions: true,
      wms_api_bypasses: false,
    })
  })

  test("tables and sequences the owner creates in wms are granted to wms_api by default", async () => {
    const granted = await admin.sql.begin(async (tx) => {
      await tx`create table wms.specimen_default_privileges (id bigint generated always as identity, n bigint)`
      await tx`create sequence wms.specimen_default_sequence`
      const [row] = await tx<Record<string, boolean>[]>`
        select
          has_table_privilege(${API_ROLE}, 'wms.specimen_default_privileges', 'SELECT, INSERT, UPDATE, DELETE') as table_rw,
          has_table_privilege(${API_ROLE}, 'wms.specimen_default_privileges', 'TRUNCATE') as table_truncate,
          has_sequence_privilege(${API_ROLE}, 'wms.specimen_default_sequence', 'USAGE, SELECT') as sequence_use,
          has_sequence_privilege(${API_ROLE}, 'wms.specimen_default_sequence', 'UPDATE') as sequence_update`
      await tx`rollback`
      return row
    })
    assert.deepEqual(granted, { table_rw: true, table_truncate: false, sequence_use: true, sequence_update: false })
  })

  test("wms_api logs in through DATABASE_URL once bootstrapped, with wms on its search path", async () => {
    const password = new URL(database.appUrl).password
    await grantLogin(database.adminUrl, { role: API_ROLE, password: decodeURIComponent(password) })
    const app = createDb(database.appUrl, { max: 1 })
    try {
      const [row] = await app.sql<{ user: string; path: string }[]>`select current_user as user, current_setting('search_path') as path`
      assert.equal(row.user, API_ROLE)
      assert.equal(row.path, "wms, extensions")
    } finally {
      await app.close()
    }
  })
})
