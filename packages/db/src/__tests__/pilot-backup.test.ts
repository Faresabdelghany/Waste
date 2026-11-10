// A Pilot backup's manifest and the proof a decrypted one is sound (Issue
// #152), and the libpq environment the backup and restore scripts run under.
// The whole backup → restore round trip is pilot-rehearsal.test.ts's.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"

import { backupMembers, checkRestoreTarget, dumpPlan, majorOf, restorePlan, verifyBackup, writeManifest, type BackupManifest } from "../pilot/backup"
import { createDb } from "../client"
import { migrateDatabase } from "../migrate"
import { libpqEnvironment, shellExports } from "../pilot/pg-env"
import { databaseUnderTest, sharedDatabase, withFreshDatabase } from "./database"

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
  test("drops the three schemas, restores every schema dump, then every data dump", () => {
    assert.deepEqual(restorePlan({ schemas: ["wms", "drizzle", "pgboss"] } as BackupManifest, "/r"), [
      "-c", "DROP SCHEMA IF EXISTS pgboss, drizzle, wms CASCADE",
      "-f", "/r/wms-schema.sql", "-f", "/r/drizzle-schema.sql", "-f", "/r/pgboss-schema.sql",
      "-f", "/r/wms-data.sql", "-f", "/r/drizzle-data.sql", "-f", "/r/pgboss-data.sql",
    ])
  })
})

describe("dumpPlan", () => {
  test("names every owned schema in order with its two files, pg-boss's the one a backup may leave out", () => {
    assert.deepEqual(dumpPlan(), [
      { schema: "wms", required: true, schemaFile: "wms-schema.sql", dataFile: "wms-data.sql" },
      { schema: "drizzle", required: true, schemaFile: "drizzle-schema.sql", dataFile: "drizzle-data.sql" },
      { schema: "pgboss", required: false, schemaFile: "pgboss-schema.sql", dataFile: "pgboss-data.sql" },
    ])
  })
})

describe("backupMembers", () => {
  test("names what pilot-restore.sh decrypt lets out of an archive: the flat directory pilot-backup.sh tars, with every owned schema's two dumps, the manifest and the fingerprint", () => {
    assert.deepEqual(backupMembers(), [
      "./",
      "./wms-schema.sql", "./drizzle-schema.sql", "./pgboss-schema.sql",
      "./wms-data.sql", "./drizzle-data.sql", "./pgboss-data.sql",
      "./manifest.json", "./fingerprint.txt",
    ])
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
// the fingerprint and a manifest over them, written against a real database:
// a copy each (`freshDatabase`'s template) of one the file migrates once.
const database = databaseUnderTest()

describe("a backup's manifest", { skip: database.skip }, () => {
  const migrated = sharedDatabase(database.adminUrl, "waste_backup_migrated", (url) => migrateDatabase(url))

  before(() => migrated.ready())
  after(() => migrated.drop())

  test("records the dumps, the journal and the fingerprint, and verifies until one byte changes", async () =>
    withFreshDatabase(database.adminUrl, "waste_backup_manifest", async (url) => {
      // A database from before migration 0011, which has no pg-boss schema to back up.
      const owner = createDb(url, { max: 1 })
      try {
        await owner.sql`drop schema pgboss cascade`
      } finally {
        await owner.close()
      }
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
        assert.deepEqual(manifest.schemas, ["wms", "drizzle"], "pgboss is left out where the database has none")
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
    }, { template: (await migrated.ready()).name }))

  test("refuses what cannot be a backup: a database without the domain, a dump the database's schemas want and do not have, an empty file, a wms schema with no table", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "waste-backup-"))
    const input = (url: string) => ({ url, run: { id: "1", attempt: "1" }, commit: COMMIT, clientVersion: "pg_dump (PostgreSQL) 17.11" })
    try {
      await withFreshDatabase(database.adminUrl, "waste_backup_empty", (url) =>
        assert.rejects(writeManifest(dir, input(url)), /the backup holds no wms schema/, "a database the migrations never ran on"),
      )
      await withFreshDatabase(database.adminUrl, "waste_backup_refused", async (url) => {
        writeFileSync(path.join(dir, "wms-schema.sql"), "CREATE SCHEMA wms;\n")
        writeFileSync(path.join(dir, "wms-data.sql"), "-- rows\n")
        await assert.rejects(writeManifest(dir, input(url)), /drizzle-schema\.sql is missing from the backup/)
        writeFileSync(path.join(dir, "drizzle-schema.sql"), "CREATE SCHEMA drizzle;\n")
        writeFileSync(path.join(dir, "drizzle-data.sql"), "-- rows\n")
        await assert.rejects(writeManifest(dir, input(url)), /pgboss-schema\.sql is missing from the backup/, "the database has pg-boss's schema, so its dump is owed")
        writeFileSync(path.join(dir, "pgboss-schema.sql"), "CREATE SCHEMA pgboss;\n")
        writeFileSync(path.join(dir, "pgboss-data.sql"), "")
        await assert.rejects(writeManifest(dir, input(url)), /pgboss-data\.sql is empty/)
        writeFileSync(path.join(dir, "pgboss-data.sql"), "-- rows\n")
        await assert.rejects(writeManifest(dir, input(url)), /wms-schema\.sql defines no table/)
      }, { template: (await migrated.ready()).name })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
