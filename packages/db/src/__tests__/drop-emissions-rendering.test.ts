// The emission factors removed (M10 and M13 of #293 withdrawn): the fuels'
// factors, a vehicle type's consumption by fuel and the waste fractions'
// factors, dropped whole. A DROP TABLE takes the table's fence, triggers,
// exclusion constraint, keys and indexes with it, and nothing else names the
// three tables, so the migration is exactly what drizzle-kit diffs between
// the snapshot before it and its own; the schema and the audit trail hold
// none of them any more, while a waste fraction keeps its treatment. The file
// is found by its name, and its snapshot by the journal's entry for it. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { getTableName, is } from "drizzle-orm"
import { generateMigration } from "drizzle-kit/api"
import { PgTable } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import * as schema from "../schema"
import { wasteFraction } from "../schema/catalogue"
import { AUDITED } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"

const DROPPED = ["fuel_emission_factor", "vehicle_type_consumption", "waste_fraction_emission_factor"]

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_drop_emissions\.sql$/.test(name))
  assert.ok(file !== undefined, "the emission factors' removal")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (idx: number): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own, by the journal's index for the file. */
async function generated(): Promise<string[]> {
  const tag = (await migrationName()).replace(/\.sql$/, "")
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] }
  const entry = journal.entries.find((row) => row.tag === tag)
  assert.ok(entry !== undefined, `the journal's entry for ${tag}`)
  return (await generateMigration(await snapshot(entry.idx - 1), await snapshot(entry.idx))).map(normalised)
}

const DROPS = DROPPED.map((table) => `DROP TABLE "wms"."${table}" CASCADE;`)

describe("the emission factors' removal", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, drops the three tables and nothing else", async () => {
    assert.deepEqual(await generated(), DROPS.map(normalised))
  })

  test("the migration is exactly that", async () => {
    assert.deepEqual(statementsOf(await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")), DROPS.map(normalised))
  })

  test("the schema and the audit trail hold none of the three, and a waste fraction keeps its treatment", () => {
    const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable)).map((table) => getTableName(table))
    for (const name of DROPPED) {
      assert.ok(!tables.includes(name), `${name} is in the schema`)
      assert.ok(!AUDITED.some((entry) => getTableName(entry.table) === name), `${name} is audited`)
    }
    assert.equal(wasteFraction.treatment.name, "treatment")
  })
})
