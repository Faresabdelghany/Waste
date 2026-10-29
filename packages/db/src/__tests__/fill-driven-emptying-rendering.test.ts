// The fill-driven emptying (O26 of #290) as the migration writes it: a
// pairing's `books_emptying`, false on every pairing there is. Then the file:
// drizzle-kit's one statement under its header, nothing hand-written. The
// file is found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { normalised, statementsOf } from "../sql/hand-written"

const ADDED = 'ALTER TABLE "wms"."sensor_pairing" ADD COLUMN "books_emptying" boolean DEFAULT false NOT NULL;'

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_fill_driven_emptying\.sql$/.test(name))
  assert.ok(file !== undefined, "the fill-driven emptying's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("the fill-driven emptying's migration", () => {
  test("is drizzle-kit's one statement, the column off on every pairing, under its header", async () => {
    const name = await migrationName()
    const own = name.slice(0, 4)
    const generated = (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
    assert.deepEqual(generated, [normalised(ADDED)])
    const text = await readFile(join(MIGRATIONS_FOLDER, name), "utf8")
    assert.deepEqual(statementsOf(text), generated)
    assert.match(text, /^-- The fill-driven emptying \(O26 of #290, row 9\.10\)/)
  })
})
