// The Pilot's backup and restore end to end (Issue #152), on a fresh database
// of this file's own: migrated and seeded, backed up by pilot-backup.sh to a
// throwaway age key, its three schemas dropped, restored by pilot-restore.sh,
// and then proved — the journal and the fingerprint as they were, and the
// app roles able to do their work on it. CI also rehearses on the local stack
// itself before the suites run, so every suite is a smoke test of a restored
// database (scripts/pilot/rehearse.ts); this file is the rehearsal a machine
// can run on its own.
//
// It needs PostgreSQL client 17 and age on PATH: without them it skips,
// visibly, unless REQUIRE_DATABASE is on, where their absence is a failure,
// as it is in CI.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { isDatabaseRequired } from "@waste/tooling/database-under-test"
import { sql as drizzleSql } from "drizzle-orm"

import { createDb } from "../client"
import { migrateDatabase } from "../migrate"
import { rehearsalTools, rehearseRestore } from "../pilot/rehearsal"
import { seedDemo } from "../seed/demo"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, withDatabaseName } from "./database"

const database = databaseUnderTest()
const missing = database.skip === false ? rehearsalTools() : undefined
if (missing !== undefined && isDatabaseRequired(process.env)) {
  throw new Error(`REQUIRE_DATABASE is set, but the restore rehearsal cannot run: ${missing}`)
}
const skip = database.skip || (missing === undefined ? false : `${missing}: the restore rehearsal needs PostgreSQL client 17 and age`)

describe("the Pilot's backup and restore, rehearsed", { skip }, () => {
  test("restores a seeded database to the same journal and fingerprint, and the app roles work on it", async () => {
    const fresh = await freshDatabase(database.adminUrl, "waste_rehearsal")
    try {
      await migrateDatabase(fresh.url)
      const { companyId } = await seedDemo(fresh.url)
      const owner = createDb(fresh.url, { max: 1 })
      try {
        // A queue and a job, so pg-boss's data is in the backup too.
        await owner.sql`select pgboss.create_queue('rehearsal', '{"policy": "standard"}'::jsonb)`
        await owner.sql`insert into pgboss.job (name, data) values ('rehearsal', '{"n": 1}'::jsonb)`
      } finally {
        await owner.close()
      }

      const lines: string[] = []
      const rehearsal = await rehearseRestore(fresh.url, { log: (line) => lines.push(line) })
      assert.ok(rehearsal.journalRows > 0)
      assert.match(lines.join("\n"), /pilot-backup: pg_dump 17 against server 17/)
      assert.match(lines.join("\n"), /the fingerprint matches/)

      // The API role, fenced by its tenant, reads and writes the restored rows.
      const api = createDb(withDatabaseName(database.appUrl, fresh.name), { max: 1 })
      try {
        const projects = await withCompany(api.db, companyId, (tx) => tx.execute(drizzleSql`select count(*)::int as n from wms.project`))
        assert.equal(projects.at(0)?.n, 3)
        const renamed = await withCompany(api.db, companyId, (tx) =>
          tx.execute(drizzleSql`update wms.company set name = name returning updated_at > created_at as touched`),
        )
        assert.equal(renamed.at(0)?.touched, true, "the touch trigger came back with its table")
        const [job] = await api.sql<{ data: string }[]>`select data::text as data from pgboss.job where name = 'rehearsal'`
        assert.equal(job?.data, '{"n": 1}')
      } finally {
        await api.close()
      }
      const worker = createDb(fresh.url, { max: 1 })
      try {
        const [{ companies }] = await worker.sql.begin(async (tx) => {
          await tx`set local role wms_worker`
          return tx<{ companies: number }[]>`select count(*)::int as companies from wms.company`
        })
        assert.equal(companies, 1, "the worker role reads across the fence, as its grant says")
      } finally {
        await worker.close()
      }
    } finally {
      await fresh.drop()
    }
  })
})

const RESTORE = fileURLToPath(new URL("../../scripts/pilot-restore.sh", import.meta.url))

describe("pilot-restore.sh decrypt", { skip }, () => {
  test("refuses an archive whose members are not a backup's, before it writes a file", () => {
    const work = mkdtempSync(path.join(tmpdir(), "waste-decrypt-"))
    try {
      const run = (command: string, args: string[], cwd = work) => {
        const result = spawnSync(command, args, { cwd, encoding: "utf8" })
        assert.equal(result.status, 0, result.stderr)
        return result.stdout
      }
      run("age-keygen", ["-o", "identity.txt"])
      writeFileSync(path.join(work, "recipient.txt"), run("age-keygen", ["-y", "identity.txt"]))
      mkdirSync(path.join(work, "archive", "inner"), { recursive: true })
      writeFileSync(path.join(work, "archive", "inner", "wms-schema.sql"), "CREATE SCHEMA wms;\n")
      run("tar", ["-C", path.join(work, "archive"), "-cf", path.join(work, "backup.tar"), "."])
      run("age", ["--encrypt", "--recipients-file", "recipient.txt", "--output", "backup.tar.age", "backup.tar"])
      const restore = path.join(work, "restore")
      const result = spawnSync("bash", [RESTORE, "decrypt"], {
        encoding: "utf8",
        env: { ...process.env, BACKUP_FILE: path.join(work, "backup.tar.age"), AGE_IDENTITY: readFileSync(path.join(work, "identity.txt"), "utf8"), RESTORE_DIR: restore },
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /the archive holds a member a backup never has: \.\/inner\//)
      assert.equal(existsSync(path.join(restore, "inner")), false)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
