// The work order charges' removal (M14 of #293) as the migration writes it:
// drizzle-kit's one statement, `work_order_product` dropped with what hangs
// off it — its fence, its triggers, its keys — and nothing hand-written, since
// nothing points at it, no door or publication names it and no vocabulary
// shrinks. The schema and the audit trail hold the table no more. The file is
// found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { AUDITED_TABLES } from "@waste/contracts/audit"
import { getTableName, is } from "drizzle-orm"
import { generateMigration } from "drizzle-kit/api"
import { PgTable } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import * as schema from "../schema"
import { AUDITED_TABLE_NAMES } from "../sql/audit-trail"
import { normalised, statementsOf } from "../sql/hand-written"

const DROPPED = "work_order_product"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_remove_work_order_charges\.sql$/.test(name))
  assert.ok(file !== undefined, "the work order charges' removal")
  return file
}

/** The journal's index of the migration: its snapshot's number, which a placeholder file number may differ from until its turn. */
async function journalIndex(file: string): Promise<number> {
  const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] }
  const entry = journal.entries.find((candidate) => `${candidate.tag}.sql` === file)
  assert.ok(entry !== undefined, `${file} is in the journal`)
  return entry.idx
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: number): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${String(n).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot

describe("the work order charges' removal", () => {
  test("is drizzle-kit's statement alone: the table dropped, cascading to its fence, its triggers and its keys", async () => {
    const file = await migrationName()
    const own = await journalIndex(file)
    const expected = [`DROP TABLE "wms"."${DROPPED}" CASCADE;`].map(normalised)
    assert.deepEqual((await generateMigration(await snapshot(own - 1), await snapshot(own))).map(normalised), expected)
    const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
    assert.deepEqual(statementsOf(text), expected)
    assert.match(text, /^-- Work order charges are removed \(M14 of #293\)/)
  })

  test("the schema, the audit trail and the contracts' audited tables hold the table no more", () => {
    const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable)).map((table) => getTableName(table))
    assert.ok(!tables.includes(DROPPED), "the schema")
    assert.ok(!AUDITED_TABLE_NAMES.has(DROPPED), "the audit trail")
    assert.ok(!(AUDITED_TABLES as readonly string[]).includes(DROPPED), "the contracts")
  })
})
