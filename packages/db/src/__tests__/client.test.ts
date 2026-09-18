import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "../client"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

describe("createDb", { skip: database.skip }, () => {
  let connection: Database

  before(() => {
    connection = createDb(database.adminUrl)
  })
  after(() => connection.close())

  test("answers a query through Drizzle and through the raw client", async () => {
    const [row] = await connection.sql<{ answer: number }[]>`select 1 as answer`
    assert.equal(row.answer, 1)
    const result = await connection.db.execute<{ answer: number }>("select 2 as answer")
    assert.equal(result[0]?.answer, 2)
  })

  test("the raw face shares Drizzle's codecs: temporal values arrive as Postgres text, not Date", async () => {
    // Drizzle rewires the postgres.js instance it is given so that it can do
    // the mapping itself; the raw face is the same instance, so a test or a
    // script reading `now()` through it gets the server's text form and sends
    // dates as strings. Pinned here so the header's promise stays true.
    const [row] = await connection.sql<{ now: unknown; day: unknown }[]>`select now() as now, current_date as day`
    assert.equal(typeof row.now, "string")
    assert.equal(typeof row.day, "string")
    assert.match(String(row.day), /^\d{4}-\d{2}-\d{2}$/)
  })

  test("searchPath goes out as a startup parameter and outranks the role's setting", async () => {
    const pinned = createDb(database.adminUrl, { max: 1, searchPath: "wms, extensions" })
    try {
      const [row] = await pinned.sql<{ path: string; source: string }[]>`
        select current_setting('search_path') as path, (select source from pg_settings where name = 'search_path') as source`
      assert.deepEqual({ path: row.path, source: row.source }, { path: "wms, extensions", source: "client" })
    } finally {
      await pinned.close()
    }
  })

  test("close() is idempotent", async () => {
    const connection = createDb(database.adminUrl)
    await connection.sql`select 1`
    await connection.close()
    await connection.close()
  })
})
