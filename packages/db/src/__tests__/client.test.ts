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

  test("close() is idempotent", async () => {
    const connection = createDb(database.adminUrl)
    await connection.sql`select 1`
    await connection.close()
    await connection.close()
  })
})
