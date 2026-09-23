import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"
import { text } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { id, tenant, timestamps } from "../schema/columns"
import { wms } from "../schema/wms"
import { tenantFence } from "../sql/tenant-fence"
import { COMPANY_SETTING, withCompany } from "../tenant"
import { databaseUnderTest } from "./database"
import { createSpecimen, refusedWith, rolledBack } from "./specimen"

const database = databaseUnderTest()

// A current-state row of a tenant.
const specimen = wms.table("specimen_fence", { ...id, ...tenant, ...timestamps, note: text().notNull() })

const companyA = "018f7c2e-0000-7000-8000-00000000000a"
const companyB = "018f7c2e-0000-7000-8000-00000000000b"
const seed = [
  { companyId: companyA, note: "a1" },
  { companyId: companyA, note: "a2" },
  { companyId: companyB, note: "b1" },
]

class Done<T> {
  constructor(readonly value: T) {}
}

describe("the tenant fence against the database", { skip: database.skip }, () => {
  let admin: Database

  before(async () => {
    await migrateDatabase(database.adminUrl)
    admin = createDb(database.adminUrl, { max: 2 })
  })
  after(() => admin.close())

  /** The fenced specimen table, seeded as the owner (who bypasses RLS); then the transaction becomes the API role. */
  const fenced = async (tx: Tx): Promise<void> => {
    await createSpecimen(tx, { specimen })
    for (const statement of tenantFence(specimen)) await tx.execute(sql.raw(statement))
    await tx.insert(specimen).values(seed)
    // Role settings apply at login, not at SET ROLE: the API role's search path is set by hand.
    await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
    await tx.execute(sql`set local search_path = wms, extensions`)
  }

  /** `withCompany` on the pool, the specimen created inside its transaction, everything rolled back. */
  const asCompany = async <T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> => {
    try {
      await withCompany(admin.db, companyId, async (tx) => {
        await fenced(tx)
        throw new Done(await fn(tx))
      })
    } catch (error) {
      if (error instanceof Done) return error.value as T
      throw error
    }
    throw new Error("the transaction returned instead of rolling back")
  }

  const notes = async (tx: Tx): Promise<string[]> => (await tx.select({ note: specimen.note }).from(specimen).orderBy(specimen.note)).map((row) => row.note)

  test("the statements enable and force row-level security and create the policy for the API role", () =>
    rolledBack(admin.db, async (tx) => {
      await createSpecimen(tx, { specimen })
      for (const statement of tenantFence(specimen)) await tx.execute(sql.raw(statement))
      const [table] = await tx.execute<{ enabled: boolean; forced: boolean }>(
        sql`select relrowsecurity as enabled, relforcerowsecurity as forced from pg_class where oid = 'wms.specimen_fence'::regclass`,
      )
      assert.deepEqual(table, { enabled: true, forced: true })
      const policies = await tx.execute<{ name: string; permissive: string; cmd: string; roles: string[]; qual: string; check: string }>(
        sql`select policyname as name, permissive, cmd, roles, qual, with_check as check from pg_policies where schemaname = 'wms' and tablename = 'specimen_fence'`,
      )
      assert.deepEqual([...policies], [
        {
          name: "specimen_fence_tenant_fence",
          permissive: "PERMISSIVE",
          cmd: "ALL",
          roles: [API_ROLE],
          qual: "(company_id = ( SELECT wms.current_company_id() AS current_company_id))",
          check: "(company_id = ( SELECT wms.current_company_id() AS current_company_id))",
        },
      ])
    }))

  test("as the API role under withCompany, the table shows the company's rows and no others", async () => {
    assert.deepEqual(await asCompany(companyA, notes), ["a1", "a2"])
    assert.deepEqual(await asCompany(companyB, notes), ["b1"])
  })

  test("with no company set, the API role sees nothing and can insert nothing (42501)", () =>
    rolledBack(admin.db, async (tx) => {
      await fenced(tx)
      assert.deepEqual(await notes(tx), [])
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values({ companyId: companyA, note: "a3" })),
        refusedWith("42501", /new row violates row-level security policy for table "specimen_fence"/),
      )
    }))

  test("an insert for another company is refused with 42501; one for the set company lands and is visible", () =>
    asCompany(companyA, async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(specimen).values({ companyId: companyB, note: "b2" })),
        refusedWith("42501", /new row violates row-level security policy for table "specimen_fence"/),
      )
      await tx.insert(specimen).values({ companyId: companyA, note: "a3" })
      assert.deepEqual(await notes(tx), ["a1", "a2", "a3"])
    }))

  test("an update or delete cannot reach another company's rows, and cannot move a row to another company", () =>
    asCompany(companyA, async (tx) => {
      const moved = await tx.update(specimen).set({ note: "seen" }).where(sql`${specimen.companyId} = ${companyB}`).returning()
      assert.deepEqual(moved, [], "another company's rows are not there to update")
      const deleted = await tx.delete(specimen).where(sql`${specimen.companyId} = ${companyB}`).returning()
      assert.deepEqual(deleted, [])
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.update(specimen).set({ companyId: companyB }).where(sql`${specimen.note} = 'a1'`)),
        refusedWith("42501", /new row violates row-level security policy for table "specimen_fence"/),
      )
      // The owner still sees every row: the fence is for the API role.
      await tx.execute(sql`reset role`)
      assert.deepEqual(await notes(tx), ["a1", "a2", "b1"])
    }))

  test("the company setting ends with its transaction: the same connection carries nothing over", async () => {
    const single = createDb(database.adminUrl, { max: 1 })
    try {
      const inside = await withCompany(single.db, companyA, async (tx) => {
        const [row] = await tx.execute<{ company: string | null }>(sql`select current_setting(${COMPANY_SETTING}, true) as company`)
        return row.company
      })
      assert.equal(inside, companyA)
      const [afterwards] = await single.sql<{ company: string | null }[]>`select nullif(current_setting(${COMPANY_SETTING}, true), '') as company`
      assert.equal(afterwards.company, null)
    } finally {
      await single.close()
    }
  })

  test("withCompany refuses what is not a UUID before opening a transaction, and takes either case", async () => {
    await assert.rejects(withCompany(admin.db, "copenhagen", () => Promise.resolve()), /withCompany: "copenhagen" is not a UUID/)
    await assert.rejects(withCompany(admin.db, "", () => Promise.resolve()), /withCompany: "" is not a UUID/)
    assert.deepEqual(await asCompany(companyA.toUpperCase(), notes), ["a1", "a2"], "Postgres compares uuids without regard to case")
  })
})
