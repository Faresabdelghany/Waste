// The journal check (Issue #152): what `migrateDatabase` asks before it
// writes anything, and what `pnpm db:check` asks on its own. The rules are
// held here over plain shapes — a folder of three migrations and the rows a
// database recorded — and then against Postgres, where the point is that a
// refused journal leaves the database exactly as it was.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

import { createDb } from "../client"
import { assertJournal, checkJournal, JournalError, readMigrationFolder, type AppliedMigration, type MigrationFolder } from "../journal-check"
import { checkDatabaseJournal, migrateDatabase } from "../migrate"
import { databaseUnderTest, withFreshDatabase } from "./database"

const A = "a".repeat(64)
const B = "b".repeat(64)
const C = "c".repeat(64)

const folder = (overrides: Partial<MigrationFolder> = {}): MigrationFolder => ({
  files: [
    { tag: "0000_wms", when: 1000, hash: A },
    { tag: "0001_foundation", when: 2000, hash: B },
    { tag: "0002_registry", when: 3000, hash: C },
  ],
  unlisted: [],
  ...overrides,
})

const row = (id: number, createdAt: string | null, hash: string): AppliedMigration => ({ id, createdAt, hash })
const allApplied = [row(1, "1000", A), row(2, "2000", B), row(3, "3000", C)]

describe("checkJournal", () => {
  test("a clean journal: every migration applied once, from the file it names", () => {
    assert.deepEqual(checkJournal(folder(), allApplied), {
      applied: ["0000_wms", "0001_foundation", "0002_registry"],
      pending: [],
      problems: [],
    })
  })

  test("pending valid migrations pass, a fresh database's whole journal among them", () => {
    assert.deepEqual(checkJournal(folder(), [row(1, "1000", A)]), {
      applied: ["0000_wms"],
      pending: ["0001_foundation", "0002_registry"],
      problems: [],
    })
    assert.deepEqual(checkJournal(folder(), []), {
      applied: [],
      pending: ["0000_wms", "0001_foundation", "0002_registry"],
      problems: [],
    })
  })

  test("a missing file: an applied migration whose file is gone, and a pending one the migrator could not read either", () => {
    const missing = folder({
      files: [
        { tag: "0000_wms", when: 1000, hash: A },
        { tag: "0001_foundation", when: 2000, hash: null },
        { tag: "0002_registry", when: 3000, hash: null },
      ],
    })
    assert.deepEqual(checkJournal(missing, [row(1, "1000", A), row(2, "2000", B)]).problems, [
      "0001_foundation is applied, but 0001_foundation.sql is not in the migrations folder",
      "0002_registry is in the journal, but 0002_registry.sql is not in the migrations folder, so the migrator cannot read the journal",
    ])
  })

  test("an extra applied row: a migration this checkout does not have, and one migration recorded twice", () => {
    assert.deepEqual(checkJournal(folder(), [...allApplied, row(4, "4000", "d".repeat(64))]).problems, [
      "Journal row 4 (4000) is later than 0002_registry, the last migration of this checkout: the database was migrated from a newer commit or another branch",
    ])
    assert.deepEqual(checkJournal(folder(), [row(1, "1000", A), row(2, "2000", B), row(5, "2000", B)]).problems, [
      "0001_foundation is recorded twice, by journal rows 2 and 5",
    ])
  })

  test("an unmappable timestamp: a row whose `when` names no migration, or that has none", () => {
    assert.deepEqual(checkJournal(folder(), [row(1, "1000", A), row(2, "1500", B)]).problems, [
      "Journal row 2 (1500) maps to no migration of the journal",
    ])
    assert.deepEqual(checkJournal(folder(), [row(1, "1000", A), row(2, null, B)]).problems, [
      "Journal row 2 has no timestamp, so it maps to no migration of the journal",
    ])
  })

  test("a duplicate timestamp: two journal entries sharing a `when`, which an applied row maps to both of", () => {
    const shared = folder({
      files: [
        { tag: "0000_wms", when: 1000, hash: A },
        { tag: "0001_foundation", when: 2000, hash: B },
        { tag: "0002_registry", when: 2000, hash: C },
      ],
    })
    assert.deepEqual(checkJournal(shared, [row(1, "1000", A), row(2, "2000", B)]).problems, [
      "0001_foundation and 0002_registry share the journal timestamp 2000",
      "Journal row 2 (2000) maps to more than one migration: 0001_foundation and 0002_registry",
    ])
  })

  test("a hash mismatch: a migration applied from a file that has since changed", () => {
    assert.deepEqual(checkJournal(folder(), [row(1, "1000", A), row(2, "2000", "e".repeat(64)), row(3, "3000", C)]).problems, [
      `0001_foundation was applied from another version of its file: the journal recorded sha256 ${"e".repeat(64)}, 0001_foundation.sql hashes to ${B}`,
    ])
  })

  test("a migration the migrator would skip for good: unapplied, with a later one applied", () => {
    assert.deepEqual(checkJournal(folder(), [row(1, "1000", A), row(3, "3000", C)]), {
      applied: ["0000_wms", "0002_registry"],
      pending: [],
      problems: [
        "0001_foundation is not applied, but a later migration is: the migrator applies only what is later than the newest row, so it would skip 0001_foundation for good",
      ],
    })
  })

  test("a folder that disagrees with its own journal: an unlisted file, and an entry not later than the one before it", () => {
    assert.deepEqual(checkJournal(folder({ unlisted: ["0003_resources"] }), allApplied).problems, [
      "0003_resources.sql is in the migrations folder but not in the journal, so the migrator never applies it",
    ])
    const backwards = folder({
      files: [
        { tag: "0000_wms", when: 1000, hash: A },
        { tag: "0001_foundation", when: 3000, hash: B },
        { tag: "0002_registry", when: 2000, hash: C },
      ],
    })
    assert.deepEqual(checkJournal(backwards, []).problems, [
      "0002_registry (2000) is not later than 0001_foundation (3000): a database that has applied 0001_foundation would skip it",
    ])
  })
})

describe("assertJournal", () => {
  test("passes a report without problems and throws every problem of one that has them", () => {
    assert.doesNotThrow(() => assertJournal(checkJournal(folder(), allApplied)))
    assert.throws(
      () => assertJournal(checkJournal(folder(), [row(1, "1000", A), row(2, "1500", B), row(3, "3000", "f".repeat(64))])),
      (error: unknown) => {
        assert.ok(error instanceof JournalError)
        assert.equal(error.problems.length, 3)
        assert.match(error.message, /^The migration journal disagrees with the migrations folder:\n- Journal row 2 \(1500\) maps to no migration of the journal\n- 0002_registry was applied from another version of its file/)
        return true
      },
    )
  })
})

describe("readMigrationFolder", () => {
  test("hashes each listed file as drizzle-orm's migrator does, and names what is missing or unlisted", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waste-journal-"))
    try {
      mkdirSync(path.join(dir, "meta"))
      writeFileSync(
        path.join(dir, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            { idx: 0, version: "7", when: 1000, tag: "0000_wms", breakpoints: true },
            { idx: 1, version: "7", when: 2000, tag: "0001_foundation", breakpoints: true },
          ],
        }),
      )
      writeFileSync(path.join(dir, "0000_wms.sql"), 'CREATE SCHEMA "wms";\n')
      writeFileSync(path.join(dir, "0005_stray.sql"), "select 1;\n")
      assert.deepEqual(readMigrationFolder(dir), {
        files: [
          // sha256 of `CREATE SCHEMA "wms";\n`, computed with `shasum -a 256` — the real 0000_wms.sql's, whose text it is.
          { tag: "0000_wms", when: 1000, hash: "e8a04545adfcb594cecd61f3f2dd66b87097ae9746f5b2a0b8a7b8274a065a0c" },
          { tag: "0001_foundation", when: 2000, hash: null },
        ],
        unlisted: ["0005_stray"],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const database = databaseUnderTest()

describe("the journal check on a database", { skip: database.skip }, () => {
  test("a fresh database has every migration pending, and checking it writes nothing", () =>
    withFreshDatabase(database.adminUrl, "waste_journal_fresh", async (url) => {
      const report = await checkDatabaseJournal(url)
      assert.deepEqual(report.problems, [])
      assert.deepEqual(report.applied, [])
      assert.equal(report.pending.at(0), "0000_wms")
      const fresh = createDb(url, { max: 1 })
      try {
        const [{ drizzle }] = await fresh.sql<{ drizzle: boolean }[]>`select to_regnamespace('drizzle') is not null as drizzle`
        assert.equal(drizzle, false, "the check created nothing, not even the journal's schema")
      } finally {
        await fresh.close()
      }
    }))

  test("a migrated database has every migration applied and none pending", () =>
    withFreshDatabase(database.adminUrl, "waste_journal_migrated", async (url) => {
      const { applied } = await migrateDatabase(url)
      assert.equal(applied.at(0), "0000_wms", "the first run applies the whole journal and says so")
      assert.deepEqual((await migrateDatabase(url)).applied, [], "the second applies nothing")
      const report = await checkDatabaseJournal(url)
      assert.deepEqual(report.problems, [])
      assert.deepEqual(report.pending, [])
      assert.equal(report.applied.at(0), "0000_wms")
    }))

  test("a journal that recorded another file is refused by migrateDatabase before it applies anything", () =>
    withFreshDatabase(database.adminUrl, "waste_journal_refused", async (url) => {
      // A journal a hand replay could have left: 0000 recorded with a hash no
      // file of this checkout has, and nothing else applied yet.
      const fresh = createDb(url, { max: 1 })
      try {
        await fresh.sql`create schema drizzle`
        await fresh.sql`create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`
        await fresh.sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${"0".repeat(64)}, 1789703334818)`
        await assert.rejects(migrateDatabase(url), (error: unknown) => {
          assert.ok(error instanceof JournalError)
          assert.match(error.message, /0000_wms was applied from another version of its file/)
          return true
        })
        const [state] = await fresh.sql<{ wms: boolean; rows: number }[]>`
          select to_regnamespace('wms') is not null as wms, (select count(*)::int from drizzle.__drizzle_migrations) as rows`
        assert.deepEqual({ ...state }, { wms: false, rows: 1 }, "no migration ran and no journal row was added")
        const report = await checkDatabaseJournal(url)
        assert.equal(report.problems.length, 1)
      } finally {
        await fresh.close()
      }
    }))
})
