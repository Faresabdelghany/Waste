// The CSV import of the catalogue and the fleet (O30 of #290, row 1.18) as
// the migration writes it: the run's kinds grow by the waste fractions, the
// container types, the vehicle types, the vehicles and the drivers, and a run
// of any of the company's kinds names no project. drizzle-kit's four statements, two checks dropped and added again
// in their grown spelling, are the whole file under its header: no table is
// new and no run present is of a new kind. The file is found by its name,
// not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { IMPORT_KINDS } from "@waste/domain/imports/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { importRun } from "../schema/imports"
import { normalised, statementsOf } from "../sql/hand-written"
import { projectShape } from "./imports-as-of"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_catalogue_and_fleet_import\.sql$/.test(name))
  assert.ok(file !== undefined, "the catalogue import's migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

const KIND_ONE_OF = `ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_kind_one_of" CHECK (${ref("import_run", "kind")} in (${list(...IMPORT_KINDS)}));`
const PROJECT_SHAPE = `ALTER TABLE "wms"."import_run" ADD CONSTRAINT "import_run_project_shape" CHECK (${projectShape("0068")});`

describe("the catalogue import's migration", () => {
  test("is drizzle-kit's statements alone: the two checks dropped and added in their grown spelling", async () => {
    const file = await migrationName()
    const own = file.slice(0, 4)
    const generated = (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
    const expected = ['ALTER TABLE "wms"."import_run" DROP CONSTRAINT "import_run_kind_one_of";', 'ALTER TABLE "wms"."import_run" DROP CONSTRAINT "import_run_project_shape";', KIND_ONE_OF, PROJECT_SHAPE].map(normalised)
    assert.deepEqual(generated, expected)
    const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
    assert.deepEqual(statementsOf(text), expected)
    assert.match(text, /^-- The CSV import of the catalogue and the fleet \(O30 of #290, row 1\.18\)/)
  })

  test("the schema's checks are the ones the file adds", () => {
    assert.equal(checksOf(importRun).get("import_run_project_shape"), projectShape("0068"))
    assert.equal(checksOf(importRun).get("import_run_kind_one_of"), `${ref("import_run", "kind")} in (${list(...IMPORT_KINDS)})`)
  })
})
