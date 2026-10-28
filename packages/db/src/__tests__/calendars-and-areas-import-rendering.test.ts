// The CSV import of a project's collection calendars and planning areas (O30
// of #290, row 1.18) as the migration writes it: the run's kinds grow by the
// two, both a project's, so the project's check stands. drizzle-kit's two
// statements, the kind's check dropped and added in its grown spelling, are
// the whole file under its header. The file is found by its name, not its
// number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { IMPORT_KINDS } from "@waste/domain/imports/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { importRun } from "../schema/imports"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_calendars_and_areas_import\.sql$/.test(name))
  assert.ok(file !== undefined, "the calendars' and areas' import migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

const KIND_CHECK = `${ref("import_run", "kind")} in (${list(...IMPORT_KINDS)})`

describe("the calendars' and areas' import migration", () => {
  test("is drizzle-kit's statements alone: the kind's check dropped and added with the two", async () => {
    const file = await migrationName()
    const own = file.slice(0, 4)
    const generated = (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
    const expected = ['ALTER TABLE "wms"."import_run" DROP CONSTRAINT "import_run_kind_one_of";', `ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_kind_one_of" CHECK (${KIND_CHECK});`].map(normalised)
    assert.deepEqual(generated, expected)
    const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
    assert.deepEqual(statementsOf(text), expected)
    assert.match(text, /^-- The CSV import of a project's collection calendars and its planning areas/)
  })

  test("the schema's kind check is the one the file adds, the calendars and the areas last", () => {
    assert.equal(checksOf(importRun).get("import_run_kind_one_of"), KIND_CHECK)
    assert.deepEqual(IMPORT_KINDS.slice(-2), ["collection-calendars", "planning-areas"])
  })
})
