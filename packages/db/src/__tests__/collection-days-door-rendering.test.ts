// The collection days' door (Issue #293, M2) as migration 0018 writes it:
// exactly the grants and policies src/sql/public-door.ts spells for
// `COLLECTION_DAYS_DOOR` — no table, no column, nothing else. What the role
// then reads, column by column, is public-door.test.ts's. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { normalised, statementsOf } from "../sql/hand-written"
import { collectionDaysDoorStatements, COLLECTION_DAYS_DOOR } from "../sql/public-door"

const MIGRATION = "0018_collection_days_door.sql"

describe("the collection days' door as migration 0018 writes it", () => {
  test("is exactly the door's grants and policies, in order", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, collectionDaysDoorStatements().map(normalised))
  })

  test("grants columns and adds policies, and nothing else: one grant per table, one policy per table it opens, the project's own policy left as 0017 wrote it", () => {
    const statements = collectionDaysDoorStatements()
    assert.ok(statements.every((statement) => statement.startsWith("GRANT SELECT (") || statement.startsWith("CREATE POLICY ")), "grants and policies only")
    assert.equal(statements.filter((statement) => statement.startsWith("GRANT")).length, COLLECTION_DAYS_DOOR.length)
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE POLICY")).length, COLLECTION_DAYS_DOOR.length - 1)
    assert.ok(!statements.some((statement) => statement.includes('ON "wms"."project" AS PERMISSIVE')), "the project keeps 0017's policy")
  })
})
