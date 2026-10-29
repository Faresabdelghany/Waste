// The disposal-site reconciliation (M17 of #293, row 28.4) as drizzle-kit
// writes it: the alert's rule check dropped and added again with the four new
// rules, last, since Postgres has no ALTER for a check; the outbound load as an
// alert's subject, a key into the load of the alert's own project with its
// index; and the subject check respelt to count it. Then the migration, which
// is exactly those statements under its header: no table is new, so nothing is
// hand-written, and no alert present names a load. The file is found by its
// name and its snapshots by its journal entry, since its number waits for its
// turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { ALERT_RULES } from "@waste/domain/resolution/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { normalised, statementsOf } from "../sql/hand-written"
import { ADDED_FOR_LOADS, ALERT_RULES_AS_OF_SENSORS, SUBJECT_SHAPE_WITH_LOADS } from "./alert-as-of"
import { list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_reconciliation_rules\.sql$/.test(name))
  assert.ok(file !== undefined, "the reconciliation rules' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (idx: number): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own, both found by the journal's index of its tag. */
async function generated(): Promise<string[]> {
  const tag = (await migrationName()).replace(/\.sql$/, "")
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] }
  const entry = journal.entries.find((each) => each.tag === tag)
  assert.ok(entry !== undefined, `${tag} in the journal`)
  return (await generateMigration(await snapshot(entry.idx - 1), await snapshot(entry.idx))).map(normalised)
}

describe("the reconciliation rules as drizzle-kit writes them", () => {
  test("the rules are the sensors' six and the four of the reconciliation, last", () => {
    assert.deepEqual([...ALERT_RULES], [...ALERT_RULES_AS_OF_SENSORS, "load-not-received", "load-weight-mismatch", "load-overweight", "route-not-tipped"])
  })

  test("the rule's check and the subject's respelt, and the outbound load an alert's subject of its own project", async () => {
    assert.deepEqual(
      [...(await generated())].sort(),
      [
        'ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_rule_one_of";',
        'ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_subject_shape";',
        'ALTER TABLE "wms"."alert" ADD COLUMN "outbound_load_id" uuid;',
        ...ADDED_FOR_LOADS,
        `ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK (${ref("alert", "rule")} in (${list(...ALERT_RULES)}));`,
        `ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_subject_shape" CHECK (${SUBJECT_SHAPE_WITH_LOADS});`,
      ]
        .map(normalised)
        .sort(),
    )
  })
})

describe("the reconciliation rules' migration", () => {
  test("is drizzle-kit's statements under its header, and nothing hand-written", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), await generated())
    assert.match(text, /^-- The disposal-site reconciliation \(M17 of #293, row 28\.4\)/)
  })
})
