// The release's and the reset's database phases (Issue #152), run as the
// workflow runs them — one after another through a context, the artifact
// store between them played by a copy — on a fresh database per test, the
// barrier closed on throwaway roles (roles are cluster-wide, and every other
// suite logs in as wms_api). The restore's phases are the rehearsal's
// (pilot-rehearsal.test.ts).
//
// The file migrates and seeds one database, once, and each test runs on a
// copy of it (`freshDatabase`'s template): three migrations of every file and
// three seeds, one after another, outran the runner's budget for the file
// under a shared stack's load.
//
// It needs the PostgreSQL client of supabase/config.toml's major and age on
// PATH, as the rehearsal does: without them it skips, unless REQUIRE_DATABASE
// is on.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, before, describe, test } from "node:test"

import { isDatabaseRequired } from "@waste/tooling/database-under-test"

import { createDb } from "../client"
import { migrateDatabase } from "../migrate"
import { backupTools } from "../pilot/backup-scripts"
import { LOGIN_STATE_FILE, readLogins } from "../pilot/barrier"
import { createContext, type Context, type Environment } from "../pilot/phase"
import { releasePhases, resetToSeedPhases } from "../pilot/phases"
import { LOCAL_RUN } from "../pilot/run"
import { seedDemo } from "../seed/demo"
import { databaseUnderTest, freshDatabase, sharedDatabase } from "./database"

const database = databaseUnderTest()
const missing = database.skip === false ? backupTools() : undefined
if (missing !== undefined && isDatabaseRequired(process.env)) {
  throw new Error(`REQUIRE_DATABASE is set, but the Pilot's phases cannot run: ${missing}`)
}
const skip = database.skip || (missing ?? false)

type Run = { context: Context; outputs: Map<string, string>; said: string[]; roles: string[] }

/** The migrated and seeded database every test copies, made once for the file. */
const seeded = sharedDatabase(database.adminUrl, "waste_phases_seeded", async (url) => {
  await migrateDatabase(url)
  await seedDemo(url)
})

before(async () => {
  if (!skip) await seeded.ready()
})
after(() => seeded.drop())

/** A copy of the migrated and seeded database, a throwaway age key, two throwaway roles that can log in, and a context over them: what one operation's phases run on. */
async function onFreshDatabase(prefix: string, env: Environment, body: (run: Run) => Promise<void>): Promise<void> {
  const fresh = await freshDatabase(database.adminUrl, prefix, { template: (await seeded.ready()).name })
  const work = mkdtempSync(path.join(tmpdir(), `${prefix}-`))
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12)
  const roles = [`${prefix}_${suffix}_a`, `${prefix}_${suffix}_b`]
  const cluster = createDb(database.adminUrl, { max: 1 })
  try {
    for (const role of roles) await cluster.sql.unsafe(`create role ${role} login`)
    spawnSync("age-keygen", ["-o", path.join(work, "identity.txt")])
    writeFileSync(path.join(work, "recipient.txt"), spawnSync("age-keygen", ["-y", path.join(work, "identity.txt")], { encoding: "utf8" }).stdout)
    const outputs = new Map<string, string>()
    const said: string[] = []
    const context = createContext({
      env: { ...process.env, DATABASE_ADMIN_URL: fresh.url, PILOT_SUPABASE_REF: "", BACKUP_RECIPIENT_FILE: path.join(work, "recipient.txt"), ...env },
      // The local run, whatever CI's own GITHUB_RUN_ID says.
      run: LOCAL_RUN,
      temp: work,
      barrier: { roles, alwaysLoggingIn: [roles[0]] },
      log: (line) => said.push(line),
      output: (name, value) => outputs.set(name, value),
    })
    await body({ context, outputs, said, roles })
  } finally {
    await fresh.drop()
    rmSync(work, { recursive: true, force: true })
    for (const role of roles) await cluster.sql.unsafe(`drop role if exists ${role}`)
    await cluster.close()
  }
}

/** What the workflow does between the record phase and the next: the record stored and read back. */
function storeTheRecord({ context }: Run): void {
  mkdirSync(context.layout.loginState.copy, { recursive: true })
  copyFileSync(context.layout.loginState.file, path.join(context.layout.loginState.copy, LOGIN_STATE_FILE))
}

describe("a release's database phases", { skip }, () => {
  test("check the journal and back up, handing the workflow the artifact to store; then migrate, seed where asked, and check the journal and the committed fingerprint", () =>
    onFreshDatabase("waste_release", { RUN_SEED: "true" }, async ({ context, outputs, said }) => {
      await releasePhases.backUp.run(context)
      assert.deepEqual(Object.fromEntries(outputs), { taken: "true", artifact: context.layout.backup.artifact, file: context.layout.backup.file })
      assert.ok(existsSync(context.layout.backup.file))
      await releasePhases.migrate.run(context)
      const after = said.slice(said.indexOf("@waste/db: no migration pending"))
      assert.match(after[1], /^@waste\/db: demo company \S+ on 127\.0\.0\.1 holds .*; nothing to change$/)
      assert.match(after[2], /^@waste\/db: journal on 127\.0\.0\.1: \d+ migrations applied, none pending$/)
      assert.match(after[3], /^@waste\/db: 127\.0\.0\.1 matches the committed fingerprint \(sha256 [0-9a-f]{64}\)$/)
    }))
})

describe("a reset to the seed's phases", { skip }, () => {
  test("refuse a database behind main's migrations before anything is written", () =>
    onFreshDatabase("waste_behind", {}, async ({ context, outputs }) => {
      const owner = createDb(context.adminUrl(), { max: 1 })
      try {
        await owner.sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`
      } finally {
        await owner.close()
      }
      await assert.rejects(resetToSeedPhases.backUp.run(context), /^Error: 1 migration\(s\) pending: the reset writes main's seed, which needs main's schema\. Run release first\.$/)
      assert.equal(outputs.size, 0, "no backup taken")
    }))

  test("back up, record the logins, and behind the barrier sweep and seed, check, open it again and report the roles", () =>
    onFreshDatabase("waste_reset", {}, async (run) => {
      const { context, outputs, said, roles } = run
      await resetToSeedPhases.backUp.run(context)
      assert.equal(outputs.get("taken"), "true")
      await resetToSeedPhases.record.run(context)
      assert.deepEqual([outputs.get("artifact"), outputs.get("file"), outputs.get("copy")], [context.layout.loginState.artifact, context.layout.loginState.file, context.layout.loginState.copy])
      assert.equal(JSON.parse(readFileSync(context.layout.loginState.file, "utf8")).operation, "reset-to-seed")
      storeTheRecord(run)
      await resetToSeedPhases.sweep.run(context)
      const closed = said.findIndex((line) => line.startsWith("Barrier closed: "))
      const reset = said.findIndex((line) => line.startsWith("Reset the demo company "))
      const opened = said.findIndex((line) => line.startsWith("Logins restored from the reset-to-seed of run 0: "))
      assert.ok(closed >= 0 && closed < reset && reset < opened, said.join("\n"))
      assert.match(said[opened - 1], /matches the committed fingerprint/)
      assert.match(said.at(-1) ?? "", /^local\/waste_reset_\w+: wms_api LOGIN/)
      const owner = createDb(context.adminUrl(), { max: 1 })
      try {
        assert.deepEqual(await readLogins(owner.sql, roles), Object.fromEntries(roles.map((role) => [role, true])))
      } finally {
        await owner.close()
      }
    }))
})
