// A public placement (M12 of #293) as the migration writes it: the
// placement's subscription made nullable, the Shared Collection Point a public
// placement stands at, its reference and index, and the CHECK that a
// placement names exactly one of the two. drizzle-kit's statements are the
// whole file under its header: every placement stored names a subscription,
// so the CHECK holds on them as written. The file is found by its name, not
// its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { containerServicePlacement } from "../schema/containers"
import { normalised, statementsOf } from "../sql/hand-written"
import { checksOf, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_public_placements\.sql$/.test(name))
  assert.ok(file !== undefined, "the public placements' migration")
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

const SERVED = `(${ref("container_service_placement", "subscription_id")} is not null)::int + (${ref("container_service_placement", "shared_collection_point_id")} is not null)::int = 1`

const STATEMENTS = [
  'ALTER TABLE "wms"."container_service_placement" ALTER COLUMN "subscription_id" DROP NOT NULL;',
  'ALTER TABLE "wms"."container_service_placement" ADD COLUMN "shared_collection_point_id" uuid;',
  'ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_shared_collection_point_id_fk" FOREIGN KEY ("company_id","project_id","shared_collection_point_id") REFERENCES "wms"."shared_collection_point"("company_id","project_id","id") ON DELETE no action ON UPDATE no action;',
  'CREATE INDEX "container_service_placement_shared_collection_point_id_idx" ON "wms"."container_service_placement" USING btree ("company_id","shared_collection_point_id");',
  `ALTER TABLE "wms"."container_service_placement" ADD CONSTRAINT "container_service_placement_served_exactly_one" CHECK (${SERVED});`,
]

describe("the public placements' migration", () => {
  test("is drizzle-kit's statements alone: the subscription nullable, the point, its reference and index, and exactly one of the two", async () => {
    const file = await migrationName()
    const own = await journalIndex(file)
    const generated = (await generateMigration(await snapshot(own - 1), await snapshot(own))).map(normalised)
    assert.deepEqual(generated, STATEMENTS.map(normalised))
    const text = await readFile(join(MIGRATIONS_FOLDER, file), "utf8")
    assert.deepEqual(statementsOf(text), generated)
    assert.match(text, /^-- A public placement \(M12 of #293\)/)
  })

  test("the schema's check is the one the migration adds", () => {
    assert.equal(checksOf(containerServicePlacement).get("container_service_placement_served_exactly_one"), SERVED)
  })
})
