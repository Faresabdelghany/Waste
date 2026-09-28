// A Pilot backup's manifest and the proof a decrypted one is sound (Issue
// #152), and the libpq environment the backup and restore scripts run under.
// The whole backup → restore round trip is pilot-rehearsal.test.ts's.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, test } from "node:test"

import { checkRestoreTarget, majorOf, restorePlan, verifyBackup, writeManifest, type BackupManifest } from "../pilot/backup"
import { migrateDatabase } from "../migrate"
import { libpqEnvironment, shellExports } from "../pilot/pg-env"
import { databaseUnderTest, withFreshDatabase } from "./database"

const COMMIT = "5f1501d6a2b3c4d5e6f708192a3b4c5d6e7f8091"

describe("libpqEnvironment", () => {
  test("spells a URL as libpq's variables, percent-decoded, the pooler's sslmode passed on", () => {
    assert.deepEqual(libpqEnvironment("postgresql://postgres.abcdefghijklmnopqrst:p%40ss%27w%3Ard@aws-0-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=require"), {
      PGHOST: "aws-0-eu-north-1.pooler.supabase.com",
      PGPORT: "5432",
      PGDATABASE: "postgres",
      PGUSER: "postgres.abcdefghijklmnopqrst",
      PGPASSWORD: "p@ss'w:rd",
      PGAPPNAME: "waste-pilot-database",
      PGSSLMODE: "require",
    })
    assert.throws(() => libpqEnvironment("postgresql://u:p@h:5432/postgres?options=-csearch_path%3Dx"), /a setting the scripts do not pass on: options/)
  })

  test("quotes every value for the shell, so a password with a quote in it survives evaluation whole", () => {
    const exported = shellExports({ PGPASSWORD: "it's $HOME `x`", PGUSER: "postgres" })
    const echoed = execFileSync("bash", ["-c", `${exported}\nprintf '%s|%s' "$PGPASSWORD" "$PGUSER"`], { encoding: "utf8" })
    assert.equal(echoed, "it's $HOME `x`|postgres")
  })
})

describe("restorePlan", () => {
  const manifest = (overrides: Partial<BackupManifest> = {}) => ({ schemas: ["wms", "drizzle", "pgboss"], publication: { name: "powersync", tables: ["wms.company", "wms.route"] }, ...overrides }) as BackupManifest

  test("drops the three schemas, restores every schema dump, adds the published tables back, then every data dump", () => {
    assert.deepEqual(restorePlan(manifest(), "/r"), [
      "-c", "DROP SCHEMA IF EXISTS pgboss, drizzle, wms CASCADE",
      "-f", "/r/wms-schema.sql", "-f", "/r/drizzle-schema.sql", "-f", "/r/pgboss-schema.sql",
      "-c", 'ALTER PUBLICATION powersync ADD TABLE ONLY "wms"."company", ONLY "wms"."route"',
      "-f", "/r/wms-data.sql", "-f", "/r/drizzle-data.sql", "-f", "/r/pgboss-data.sql",
    ])
  })

  test("leaves the publication alone where the backup names no table, and refuses a table name it would have to quote", () => {
    assert.ok(!restorePlan(manifest({ schemas: ["wms", "drizzle"], publication: null }), "/r").some((argument) => argument.startsWith("ALTER PUBLICATION")))
    assert.throws(() => restorePlan(manifest({ publication: { name: "powersync", tables: ['wms.company"; drop table wms.route; --'] } }), "/r"), /is not a table this workflow restores/)
  })
})

describe("majorOf", () => {
  test("reads the major of a client or a server version", () => {
    assert.equal(majorOf("pg_dump (PostgreSQL) 17.11"), 17)
    assert.equal(majorOf("psql (PostgreSQL) 17.6 (Homebrew)"), 17)
    assert.equal(majorOf("17.6"), 17)
    assert.throws(() => majorOf("pg_dump (EnterpriseDB)"), /names no PostgreSQL version/)
  })
})

// A decrypted backup's directory as the backup script leaves it: the dumps,
// the fingerprint and a manifest over them, written against a real database.
const database = databaseUnderTest()

describe("a backup's manifest", { skip: database.skip }, () => {
  test("records the dumps, the journal and the fingerprint, and verifies until one byte changes", () =>
    withFreshDatabase(database.adminUrl, "waste_backup_manifest", async (url) => {
      await migrateDatabase(url)
      const dir = mkdtempSync(path.join(tmpdir(), "waste-backup-"))
      try {
        writeFileSync(path.join(dir, "wms-schema.sql"), "CREATE SCHEMA wms;\nCREATE TABLE wms.company (id uuid);\n")
        writeFileSync(path.join(dir, "wms-data.sql"), "-- no rows\n")
        writeFileSync(path.join(dir, "drizzle-schema.sql"), "CREATE SCHEMA drizzle;\n")
        writeFileSync(path.join(dir, "drizzle-data.sql"), "-- rows\n")
        const manifest = await writeManifest(dir, {
          url,
          run: { id: "18000000001", attempt: "2" },
          commit: COMMIT,
          clientVersion: "pg_dump (PostgreSQL) 17.11",
          now: () => new Date("2026-09-29T08:00:00Z"),
        })
        assert.deepEqual(manifest.schemas, ["wms", "drizzle"], "pgboss is left out where its dumps are")
        assert.equal(manifest.client.major, 17)
        assert.equal(manifest.server.major, 17)
        assert.match(manifest.identity, /^local\/waste_backup_manifest_/)
        assert.equal(manifest.journal.applied, manifest.journal.rows.length)
        assert.deepEqual(
          manifest.files.map((file) => file.name),
          ["wms-schema.sql", "drizzle-schema.sql", "wms-data.sql", "drizzle-data.sql"],
        )
        assert.deepEqual(verifyBackup(dir), manifest)
        assert.doesNotThrow(() => checkRestoreTarget(manifest, { identity: manifest.identity, commit: COMMIT, run: { id: "18000000001", attempt: "2" } }))
        assert.throws(() => checkRestoreTarget(manifest, { identity: "supabase:abcdefghijklmnopqrst/postgres" }), /the backup is of local\/waste_backup_manifest_\w+; this database is supabase:/)
        assert.throws(() => checkRestoreTarget(manifest, { identity: manifest.identity, commit: "0".repeat(40) }), /the backup names commit 5f1501d/)

        writeFileSync(path.join(dir, "drizzle-data.sql"), "-- rowz\n")
        assert.throws(() => verifyBackup(dir), /drizzle-data\.sql does not match its manifest/)
        writeFileSync(path.join(dir, "drizzle-data.sql"), "-- rows\n")
        writeFileSync(path.join(dir, "stray.sql"), "select 1;\n")
        assert.throws(() => verifyBackup(dir), /files its manifest does not name: stray\.sql/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }))

  test("refuses dumps that cannot be a backup: a schema missing, an empty file, a wms schema with no table", () =>
    withFreshDatabase(database.adminUrl, "waste_backup_refused", async (url) => {
      const dir = mkdtempSync(path.join(tmpdir(), "waste-backup-"))
      const input = { url, run: { id: "1", attempt: "1" }, commit: COMMIT, clientVersion: "pg_dump (PostgreSQL) 17.11" }
      try {
        writeFileSync(path.join(dir, "wms-schema.sql"), "CREATE SCHEMA wms;\n")
        writeFileSync(path.join(dir, "wms-data.sql"), "-- rows\n")
        await assert.rejects(writeManifest(dir, input), /the backup holds no drizzle schema/)
        writeFileSync(path.join(dir, "drizzle-schema.sql"), "CREATE SCHEMA drizzle;\n")
        writeFileSync(path.join(dir, "drizzle-data.sql"), "")
        await assert.rejects(writeManifest(dir, input), /drizzle-data\.sql is empty/)
        writeFileSync(path.join(dir, "drizzle-data.sql"), "-- rows\n")
        await assert.rejects(writeManifest(dir, input), /wms-schema\.sql defines no table/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }))
})
