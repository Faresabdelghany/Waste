// A project's privacy policy (#291 C19) as drizzle-kit writes it: the days
// positions and proofs are kept and the purpose positions are recorded for,
// three nullable columns on `project` — null is no policy of its own —
// with each kind's days held to its bounds and the purpose to the
// vocabulary. The migration is exactly those statements: no table is new, so
// nothing is written by hand. organisation-access-rendering.test.ts spells the
// project's CREATE TABLE as of today. The file is found by its name, not its
// number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { RETENTION_DAYS_BOUNDS } from "@waste/domain/privacy/retention"
import { GPS_PURPOSES } from "@waste/domain/privacy/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { statementsOf } from "../sql/hand-written"
import { ref } from "./rendering"

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_privacy_policy\.sql$/.test(name))
  assert.ok(file !== undefined, "the privacy policy's migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

const range = (label: string, column: string, bounds: { min: number; max: number }) =>
  `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_${label}" CHECK (${ref("project", column)} between ${bounds.min} and ${bounds.max});`

describe("a project's privacy policy as drizzle-kit writes it", () => {
  test("three nullable columns, each kind's days within its bounds and the purpose one of the vocabulary's: exactly the migration", async () => {
    assert.deepEqual(await migration(), [
      'ALTER TABLE "wms"."project" ADD COLUMN "position_retention_days" integer;',
      'ALTER TABLE "wms"."project" ADD COLUMN "proof_retention_days" integer;',
      'ALTER TABLE "wms"."project" ADD COLUMN "gps_purpose" text;',
      range("position_retention_range", "position_retention_days", RETENTION_DAYS_BOUNDS.positions),
      range("proof_retention_range", "proof_retention_days", RETENTION_DAYS_BOUNDS.proofs),
      `ALTER TABLE "wms"."project" ADD CONSTRAINT "project_gps_purpose_one_of" CHECK (${ref("project", "gps_purpose")} in (${GPS_PURPOSES.map((purpose) => `'${purpose}'`).join(", ")}));`,
    ])
  })
})
