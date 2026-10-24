// The Drop-off Points' door (Issue #293, M3) as its migration writes it:
// after the four tables, their fences and triggers, exactly the grants and
// policies src/sql/public-door.ts spells for `DROP_OFF_DOOR`, and no other
// grant or policy for the public role. What the role then reads, column by
// column and row by row, is public-door.test.ts's. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { normalised, statementsOf } from "../sql/hand-written"
import { dropOffDoorStatements, DROP_OFF_DOOR } from "../sql/public-door"

const MIGRATION = "0027_drop_off_points.sql"

describe("the Drop-off Points' door as its migration writes it", () => {
  test("ends with the door's grants and policies, in order, and names the public role nowhere else", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    const door = dropOffDoorStatements().map(normalised)
    assert.deepEqual(statements.slice(-door.length), door)
    assert.deepEqual(
      statements.slice(0, -door.length).filter((statement) => statement.includes("wms_public")),
      [],
    )
  })

  test("grants columns and adds policies, one each per table it opens", () => {
    const statements = dropOffDoorStatements()
    assert.ok(statements.every((statement) => statement.startsWith("GRANT SELECT (") || statement.startsWith("CREATE POLICY ")), "grants and policies only")
    assert.equal(statements.filter((statement) => statement.startsWith("GRANT")).length, DROP_OFF_DOOR.length)
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE POLICY")).length, DROP_OFF_DOOR.length)
    assert.ok(!statements.some((statement) => /"code"|"notes"/.test(statement.split(" ON ")[0] ?? "")), "never a point's code or the office's notes")
  })
})
