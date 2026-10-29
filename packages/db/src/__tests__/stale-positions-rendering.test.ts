// The stale-position rule (O8 of #290) as drizzle-kit writes it: the alert's
// rule check dropped and added again with `position-stale`, last, since
// Postgres has no ALTER for a check. Then migration 0061, which is exactly
// those statements under its header: no table is new, so nothing is
// hand-written, and no alert present names the new rule. The file is found
// by its name, not its number, which it takes at its turn. Migration 0067
// (O20 of #290) grew the rules again, so the file is held to the list as 0061
// left it. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { ALERT_RULES } from "@waste/domain/resolution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { normalised, statementsOf } from "../sql/hand-written"
import { ALERT_RULES_AS_OF_0034, ALERT_RULES_AS_OF_0061 } from "./alert-as-of"
import { list, ref } from "./rendering"

const GREW = [
  'ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_rule_one_of";',
  `ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK (${ref("alert", "rule")} in (${list(...ALERT_RULES_AS_OF_0061)}));`,
]

async function migrationText(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_stale_positions\.sql$/.test(name))
  assert.ok(file !== undefined, "the stale positions' migration")
  return readFile(join(MIGRATIONS_FOLDER, file), "utf8")
}

describe("the stale-position rule as drizzle-kit writes it", () => {
  test("the rules are 0034's four and `position-stale`, last", () => {
    assert.deepEqual([...ALERT_RULES_AS_OF_0061], [...ALERT_RULES_AS_OF_0034, "position-stale"])
    assert.deepEqual([...ALERT_RULES], [...ALERT_RULES_AS_OF_0061, "maintenance-due"], "and 0067's, after them")
  })

  test("the migration is the rule's check respelt, under its header, and nothing hand-written", async () => {
    const text = await migrationText()
    assert.deepEqual(statementsOf(text), GREW.map(normalised))
    assert.match(text, /^-- The stale-position rule \(O8 of #290/)
  })
})
