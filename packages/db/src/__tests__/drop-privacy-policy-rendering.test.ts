// Privacy, audit & retention removed (#487, #291 C19) as the migration writes
// it: drizzle-kit, diffing the snapshot before the migration against its own,
// drops the three checks and the three columns 0077 gave `project`
// (privacy-policy-rendering.test.ts pins those); below them, hand-written, the
// grants on the access module that left the vocabulary are deleted. The file
// is found by its name, not its number, which it takes at its turn;
// organisation-access-rendering.test.ts spells the project's CREATE TABLE as
// of today. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MODULE_KEYS } from "@waste/domain/access/modules"
import { getTableColumns } from "drizzle-orm"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { project } from "../schema/organisation"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf } from "./rendering"

const RETIRED_MODULE = "configure.privacy"

const DROPPED = [
  'ALTER TABLE "wms"."project" DROP CONSTRAINT "project_position_retention_range";',
  'ALTER TABLE "wms"."project" DROP CONSTRAINT "project_proof_retention_range";',
  'ALTER TABLE "wms"."project" DROP CONSTRAINT "project_gps_purpose_one_of";',
  'ALTER TABLE "wms"."project" DROP COLUMN "position_retention_days";',
  'ALTER TABLE "wms"."project" DROP COLUMN "proof_retention_days";',
  'ALTER TABLE "wms"."project" DROP COLUMN "gps_purpose";',
]
const GRANTS_DELETED = `DELETE FROM "wms"."role_grant" WHERE "module_key" = '${RETIRED_MODULE}';`

/** The migration's file name, by its name: it takes its number at its turn. */
async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_drop_privacy_policy\.sql$/.test(name))
  assert.ok(file !== undefined, "the privacy policy's removal")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

describe("the privacy policy's removal as the migration writes it", () => {
  test("drizzle-kit, diffing the snapshot before against the migration's own, drops the three checks and the three columns", async () => {
    const own = (await migrationName()).slice(0, 4)
    const before = String(Number(own) - 1).padStart(4, "0")
    assert.deepEqual(await generateMigration(await snapshot(before), await snapshot(own)), DROPPED)
  })

  test("the migration is drizzle-kit's statements, then the retired module's grants deleted, under its header", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    assert.deepEqual(statementsOf(text), [...DROPPED, GRANTS_DELETED].map(normalised))
    assert.match(text, /^-- Privacy, audit & retention removed \(#487, #291 C19\)/)
  })

  test("the schema is what the statements leave: no policy column or check on the project, and the module gone from the vocabulary", () => {
    const names = Object.keys(getTableColumns(project))
    for (const column of ["positionRetentionDays", "proofRetentionDays", "gpsPurpose"]) assert.ok(!names.includes(column), column)
    for (const check of ["project_position_retention_range", "project_proof_retention_range", "project_gps_purpose_one_of"]) assert.equal(checksOf(project).get(check), undefined, check)
    assert.ok(!(MODULE_KEYS as readonly string[]).includes(RETIRED_MODULE))
  })
})
