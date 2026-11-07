// The schema and the migrations say the same thing: drizzle-kit, diffing the
// newest snapshot against the schema as it stands, has nothing to write. A
// table, a column, a key or a check changed in `src/schema/` without
// `pnpm db:generate` fails here, and so does a migration generated and then
// left behind by a later edit of the schema. With the journal check (a merged
// file is its hash) and the fingerprint (a database these files build is the
// committed one), this is what guards a merged migration (migrations/README.md).
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { generateDrizzleJson, generateMigration } from "drizzle-kit/api"

import { CASING } from "../casing"
import { MIGRATIONS_FOLDER } from "../migrate"
import * as schema from "../schema"

type Snapshot = Parameters<typeof generateMigration>[0]
type Journal = { entries: { idx: number; tag: string }[] }

describe("the schema against the migrations", () => {
  test("drizzle-kit, diffing the newest snapshot against the schema, writes nothing", async () => {
    const journal = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as Journal
    const newest = journal.entries.at(-1)
    assert.ok(newest !== undefined, "a journal with an entry")
    const snapshot = JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${String(newest.idx).padStart(4, "0")}_snapshot.json`), "utf8")) as Snapshot
    const statements = await generateMigration(snapshot, generateDrizzleJson(schema, snapshot.id, undefined, CASING))
    assert.deepEqual(statements, [], `the schema has moved past ${newest.tag}: run pnpm db:generate`)
  })
})
