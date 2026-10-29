// A payer refused alone by a run's batch (#329) as the migration writes it:
// the exclusion's reason check dropped and added again with
// `too-many-events`. drizzle-kit's two statements are the whole file under its
// header: no table is new and no exclusion present has the new reason. The
// file is found by its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { EXCLUSION_REASONS } from "@waste/domain/finance/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { billingRunExclusion } from "../schema/finance"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_too_many_events_exclusion\.sql$/.test(name))
  assert.ok(file !== undefined, "the batch's exclusion migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

const REASON_ONE_OF = `ALTER TABLE "wms"."billing_run_exclusion" ADD CONSTRAINT "billing_run_exclusion_reason_one_of" CHECK (${ref("billing_run_exclusion", "reason")} in (${list(...EXCLUSION_REASONS)}));`

describe("the batch's exclusion migration", () => {
  test("is drizzle-kit's statements alone: the reason check dropped and added with too-many-events", async () => {
    const file = await migrationName()
    const own = file.slice(0, 4)
    const generated = (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
    const expected = ['ALTER TABLE "wms"."billing_run_exclusion" DROP CONSTRAINT "billing_run_exclusion_reason_one_of";', REASON_ONE_OF].map(normalised)
    assert.deepEqual(generated, expected)
    const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
    assert.deepEqual(statementsOf(text), expected)
    assert.match(text, /^-- A run goes payer by payer in batches \(#329\)/)
  })

  test("the reasons grew by too-many-events, last, and the schema's check spells them", () => {
    assert.equal(EXCLUSION_REASONS.at(-1), "too-many-events")
    assert.equal(checksOf(billingRunExclusion).get("billing_run_exclusion_reason_one_of"), `${ref("billing_run_exclusion", "reason")} in (${list(...EXCLUSION_REASONS)})`)
  })
})
