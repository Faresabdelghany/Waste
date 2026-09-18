// drizzle-orm's migrator applies a migration only when its journal `when`
// exceeds the newest `created_at` already recorded, and never compares hashes.
// Two branches that each ran `drizzle-kit generate` and merged out of clock
// order would leave a migration that fresh databases apply and migrated ones
// skip, silently. The journal itself has to stay monotonic, and every SQL
// file has to be in it; this test fails the merge, not the deploy.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"

type Journal = { version: string; dialect: string; entries: { idx: number; when: number; tag: string; breakpoints: boolean }[] }

const journal = (): Journal => JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"))
const sqlFiles = (): string[] =>
  readdirSync(MIGRATIONS_FOLDER)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => name.slice(0, -".sql".length))
    .sort()

describe("the migration journal", () => {
  test("numbers its entries 0..n-1 in order", () => {
    assert.deepEqual(
      journal().entries.map((entry) => entry.idx),
      journal().entries.map((_, index) => index),
    )
  })

  test("has strictly increasing `when` timestamps, so no migration can be skipped by an already-migrated database", () => {
    const whens = journal().entries.map((entry) => entry.when)
    for (let index = 1; index < whens.length; index += 1) {
      assert.ok(whens[index] > whens[index - 1], `${journal().entries[index].tag} (${whens[index]}) must be later than its predecessor (${whens[index - 1]})`)
    }
  })

  test("lists exactly the SQL files in the folder, in the same order", () => {
    assert.deepEqual(
      journal().entries.map((entry) => entry.tag),
      sqlFiles(),
    )
  })

  test("keeps statement breakpoints on, the way the hand-written migrations are laid out", () => {
    for (const entry of journal().entries) assert.equal(entry.breakpoints, true, entry.tag)
  })
})
