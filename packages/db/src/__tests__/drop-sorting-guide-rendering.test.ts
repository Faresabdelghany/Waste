// The Sorting Guide removed (#293 M1, withdrawn): drizzle-kit's one statement,
// the items' table dropped with everything that was its alone — its fence,
// its triggers, the public door's grant and policy on it — then the grants
// of its module key deleted from every role, since no surface names the key
// any longer. The file is found by its name, and its snapshot by the
// journal's entry for it. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MODULE_KEYS } from "@waste/domain/access/modules"
import { getTableName, is } from "drizzle-orm"
import { PgTable } from "drizzle-orm/pg-core"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import * as schema from "../schema"
import { normalised, statementsOf } from "../sql/hand-written"
import { PUBLIC_DOOR_TABLES } from "../sql/public-door"

const TABLE = "sorting_guide_item"
const MODULE_KEY = "configure.sorting-guide"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_drop_sorting_guide\.sql$/.test(name))
  assert.ok(file !== undefined, "the Sorting Guide's removal")
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

const DROP = `DROP TABLE "wms"."${TABLE}" CASCADE;`

/** The tail: the module key's grants, the system roles' and a company's own, gone. */
const TAIL = [`DELETE FROM "wms"."role_grant" WHERE "module_key" = '${MODULE_KEY}';`]

describe("the Sorting Guide's removal as drizzle-kit writes it", () => {
  test("is the items' table dropped, and nothing else", async () => {
    assert.deepEqual(await generated(), [normalised(DROP)])
  })

  test("the schema holds no such table, the public door reads none of it, and no grant can name its module", () => {
    const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable)).map((table) => getTableName(table))
    assert.equal(tables.includes(TABLE), false)
    assert.equal(PUBLIC_DOOR_TABLES.some(({ table }) => getTableName(table) === TABLE), false)
    assert.equal((MODULE_KEYS as readonly string[]).includes(MODULE_KEY), false)
  })
})

describe("the Sorting Guide's removal as the migration writes it", () => {
  test("is drizzle-kit's statement, then the module key's grants deleted", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8"))
    assert.deepEqual(statements, [...(await generated()), ...TAIL.map(normalised)])
  })
})
