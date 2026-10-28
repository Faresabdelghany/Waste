// A planning area per collection group (O30 of #290, row 2.17) as the
// migration writes it: `collection_group.rule_planning_area_id`, a project
// key into the planning area, its index, and the shape that keeps it to a
// rule group. drizzle-kit, diffing the snapshot before the migration against
// its own, writes exactly those statements, and the file is them under its
// header: no table is new, so nothing is hand-written, and every row present
// holds a null, the scheme's area. The file is found by its name, not its
// number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { collectionGroup } from "../schema/route-schemes"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

const SHAPE = `${ref("collection_group", "stop_source")} = 'rule' or ${ref("collection_group", "rule_planning_area_id")} is null`

const GREW = [
  'ALTER TABLE "wms"."collection_group" ADD COLUMN "rule_planning_area_id" uuid;',
  'ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_rule_planning_area_id_fk" FOREIGN KEY ("company_id","project_id","rule_planning_area_id") REFERENCES "wms"."planning_area"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
  'CREATE INDEX "collection_group_rule_planning_area_id_idx" ON "wms"."collection_group" USING btree ("company_id","rule_planning_area_id");',
  `ALTER TABLE "wms"."collection_group" ADD CONSTRAINT "collection_group_rule_area_shape" CHECK (${SHAPE});`,
]

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_group_planning_area\.sql$/.test(name))
  assert.ok(file !== undefined, "the group planning area's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("a planning area per collection group as the migration writes it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, adds the column, its key, its index and its shape", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual((await generateMigration(await snapshot(before), await snapshot(own))).map(normalised).sort(), GREW.map(normalised).sort())
  })

  test("the migration is exactly those statements under its header, and nothing hand-written", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), GREW.map(normalised))
    assert.match(text, /^-- A planning area per collection group \(O30 of #290, row 2\.17\)/)
  })

  test("the schema is what the statements make: an optional area, a rule group's alone", () => {
    assert.deepEqual({ type: collectionGroup.rulePlanningAreaId.getSQLType(), notNull: collectionGroup.rulePlanningAreaId.notNull }, { type: "uuid", notNull: false })
    assert.equal(checksOf(collectionGroup).get("collection_group_rule_area_shape"), SHAPE)
  })
})
