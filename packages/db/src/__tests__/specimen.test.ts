import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"
import { integer } from "drizzle-orm/pg-core"

import { createDb, type Database } from "../client"
import { migrateDatabase } from "../migrate"
import { wms } from "../schema/wms"
import { databaseUnderTest } from "./database"
import { rolledBack, sqlstate, withSpecimen } from "./specimen"

const database = databaseUnderTest()

const helperTable = wms.table("specimen_helpers", { id: integer().primaryKey() })

describe("the specimen helpers", { skip: database.skip }, () => {
  let admin: Database

  before(async () => {
    await migrateDatabase(database.adminUrl)
    admin = createDb(database.adminUrl, { max: 2 })
  })
  after(() => admin.close())

  const exists = async (name: string): Promise<boolean> => {
    const [row] = await admin.sql<{ found: boolean }[]>`select to_regclass(${`wms.${name}`}) is not null as found`
    return row.found
  }

  test("withSpecimen creates the tables from drizzle-kit's statements, hands back fn's result, and rolls everything back", async () => {
    const seen = await withSpecimen(admin.db, { helperTable }, async (tx) => {
      await tx.insert(helperTable).values({ id: 1 })
      const [row] = await tx.execute<{ found: boolean }>(sql`select to_regclass('wms.specimen_helpers') is not null as found`)
      return row.found
    })
    assert.equal(seen, true)
    assert.equal(await exists("specimen_helpers"), false)
  })

  test("a failure fn swallowed still fails the run, as it would in a plain transaction", async () => {
    await assert.rejects(
      rolledBack(admin.db, async (tx) => {
        await tx.execute(sql`select 1 / 0`).catch(() => undefined)
        return "ok"
      }),
      (error: unknown) => sqlstate(error) === "22012",
    )
  })

  test("a refusal in its own savepoint leaves the transaction usable", async () => {
    const remaining = await withSpecimen(admin.db, { helperTable }, async (tx) => {
      await tx.insert(helperTable).values({ id: 1 })
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(helperTable).values({ id: 1 })),
        (error: unknown) => sqlstate(error) === "23505",
      )
      return (await tx.select().from(helperTable)).length
    })
    assert.equal(remaining, 1)
  })
})
