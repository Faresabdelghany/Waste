import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { eq, sql } from "drizzle-orm"
import { text } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { id, tenant, timestamps } from "../schema/columns"
import { wms } from "../schema/wms"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { databaseUnderTest } from "./database"
import { withSpecimen } from "./specimen"

const database = databaseUnderTest()

const specimen = wms.table("specimen_column_sets", { ...id, ...tenant, ...timestamps, note: text().notNull() })

const companyA = "018f7c2e-0000-7000-8000-00000000000a"

describe("the column sets against the database", { skip: database.skip }, () => {
  let admin: Database

  before(async () => {
    await migrateDatabase(database.adminUrl)
    admin = createDb(database.adminUrl, { max: 2 })
  })
  after(() => admin.close())

  /** The specimen with its updated_at trigger, as a migration would create it. */
  const inSpecimen = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withSpecimen(admin.db, { specimen }, async (tx) => {
      for (const statement of touchUpdatedAt(specimen)) await tx.execute(sql.raw(statement))
      return fn(tx)
    })

  test("id: minted by the database as a version-7 UUID when absent, kept as given when supplied", () =>
    inSpecimen(async (tx) => {
      const supplied = "018f7c2e-1234-7000-8000-000000000123"
      const rows = await tx
        .insert(specimen)
        .values([
          { companyId: companyA, note: "minted" },
          { id: supplied, companyId: companyA, note: "supplied" },
        ])
        .returning({ id: specimen.id, note: specimen.note })
      const minted = rows.find((row) => row.note === "minted")!
      assert.match(minted.id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      assert.equal(rows.find((row) => row.note === "supplied")!.id, supplied)
    }))

  test("timestamps: created_at and updated_at are the transaction's now() on insert, read as Dates", () =>
    inSpecimen(async (tx) => {
      const [{ now }] = await tx.execute<{ now: string }>(sql`select now()::text as now`)
      const [row] = await tx.insert(specimen).values({ companyId: companyA, note: "fresh" }).returning()
      assert.ok(row.createdAt instanceof Date)
      assert.ok(row.updatedAt instanceof Date)
      assert.equal(row.createdAt.getTime(), row.updatedAt.getTime())
      assert.equal(row.createdAt.getTime(), new Date(now).getTime())
    }))

  test("updated_at moves on update to now(), whatever the update said, and created_at does not", () =>
    inSpecimen(async (tx) => {
      // Explicit past stamps, since inside one transaction now() does not move.
      const past = new Date("2020-01-01T00:00:00Z")
      const [inserted] = await tx.insert(specimen).values({ companyId: companyA, note: "old", createdAt: past, updatedAt: past }).returning()
      assert.equal(inserted.updatedAt.getTime(), past.getTime(), "an insert is left to its values")
      const [touched] = await tx.update(specimen).set({ note: "renamed" }).where(eq(specimen.id, inserted.id)).returning()
      assert.equal(touched.createdAt.getTime(), past.getTime())
      assert.ok(touched.updatedAt.getTime() > past.getTime())
      const [{ now }] = await tx.execute<{ now: string }>(sql`select now()::text as now`)
      assert.equal(touched.updatedAt.getTime(), new Date(now).getTime())
      // A client cannot write its own updated_at on update: the trigger overrides it.
      const claimed = new Date("2019-06-01T00:00:00Z")
      const [overridden] = await tx.update(specimen).set({ updatedAt: claimed }).where(eq(specimen.id, inserted.id)).returning()
      assert.equal(overridden.updatedAt.getTime(), new Date(now).getTime())
    }))

  test("an update that changes nothing still moves updated_at", () =>
    inSpecimen(async (tx) => {
      const past = new Date("2020-01-01T00:00:00Z")
      const [inserted] = await tx.insert(specimen).values({ companyId: companyA, note: "same" }).returning()
      // Plant a past stamp with the trigger out of the way, since it would override it.
      await tx.execute(sql`alter table ${specimen} disable trigger specimen_column_sets_touch_updated_at`)
      await tx.update(specimen).set({ updatedAt: past }).where(eq(specimen.id, inserted.id))
      await tx.execute(sql`alter table ${specimen} enable trigger specimen_column_sets_touch_updated_at`)
      const [planted] = await tx.select({ updatedAt: specimen.updatedAt }).from(specimen).where(eq(specimen.id, inserted.id))
      assert.equal(planted.updatedAt.getTime(), past.getTime())
      const [unchanged] = await tx.update(specimen).set({ note: "same" }).where(eq(specimen.id, inserted.id)).returning()
      const [{ now }] = await tx.execute<{ now: string }>(sql`select now()::text as now`)
      assert.equal(unchanged.updatedAt.getTime(), new Date(now).getTime())
    }))
})
