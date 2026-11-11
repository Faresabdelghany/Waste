// The database's phases of the Pilot's operations (Issue #152): each one
// workflow step, reaching the database through the context's `adminUrl`
// alone (phase.ts). apps/pilot's operations.ts puts them in order beside the
// phases that talk to GitHub — choosing a source run's artifact, proving CI,
// deploying, observing — and the restore rehearsal runs the restore's on the
// local stack (rehearsal.ts).
//
// An operation that writes takes its backup in its `back-up` phase, after the
// checks it needs first, and the workflow stores it before the next phase
// writes anything. One that closes the write barrier records the logins in
// its `record` phase, the workflow stores the record and reads it back, and
// its last phase does its work behind the barrier (barrier.ts) and ends with
// the check's report of the roles.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { Sql } from "postgres"

import { grantLogin } from "../bootstrap"
import { createDb } from "../client"
import { requireFingerprint } from "../fingerprint"
import { OUTBOX_DEAD_QUEUE, QueueMissing, redriveDeadLetters } from "../jobs"
import { migrateAndSay, requireJournal } from "../migrate"
import { resetToSeed, spellReset } from "../reset-to-seed"
import { GRANTED_ROLES, OWNER } from "../roles"
import { seedDemo, spellSeed } from "../seed/demo"
import { checkRestoreTarget, verifyBackup } from "./backup"
import { backUpDatabase, decryptBackup, restoreDatabase } from "./backup-scripts"
import { behindBarrier, LOGIN_STATE_FILE, openFromRecord, readLogins, recordLogins, spellLogins, spellOpened, spellRecord, verifyLogins, type BarrierOperation } from "./barrier"
import { planPilotLogins } from "./grant-logins"
import { databaseIdentity } from "./identity"
import { BACKUP_ARTIFACT, LOGIN_STATE_ARTIFACT, readSourceRun, Refusal, theOneFile, type Context, type Phase } from "./phase"

async function asOwner<T>(url: string, work: (sql: Sql) => Promise<T>): Promise<T> {
  const { sql, close } = createDb(url, { max: 1 })
  try {
    return await work(sql)
  } finally {
    await close()
  }
}

/** `check`: the journal, the fingerprint against the committed file once nothing is pending, and the roles' logins. Writes nothing. */
export const checkPhases = {
  inspect: {
    name: "inspect",
    async run(context) {
      const url = context.adminUrl()
      const { pending } = await requireJournal(url, context.log)
      if (pending.length === 0) await requireFingerprint(url, context.log)
      else context.summary(`${pending.length} migration(s) pending, so the committed fingerprint (the head's) does not apply yet; a release compares it after migrating.`)
      await asOwner(url, (sql) => verifyLogins(sql, url, context.summary))
    },
  } satisfies Phase,
}

/**
 * A `back-up` phase: the checks its operation needs before anything is
 * written, then this run's encrypted backup, handed to the workflow as the
 * `artifact` to store and the `file` it is, `taken` false only where a
 * restore's safety backup goes on without one.
 */
function backingUp(checks: (context: Context, url: string) => Promise<void>, { tolerateIncomplete = false }: { tolerateIncomplete?: boolean } = {}): Phase {
  return {
    name: "back-up",
    async run(context) {
      const url = context.adminUrl()
      await checks(context, url)
      const { backup } = context.layout
      const { taken } = backUpDatabase({ env: context.env, url, output: backup.file, scratch: context.layout.scratch.backup, run: context.run, commit: context.commit, tolerateIncomplete, log: context.log })
      if (!taken) context.summary("No safety backup: the database lacks a schema a backup requires, so it cannot be backed up whole. The restore goes on.")
      context.output("taken", String(taken))
      context.output("artifact", backup.artifact)
      context.output("file", backup.file)
    },
  }
}

/** A `record` phase: the logins recorded before the barrier, handed to the workflow as the `artifact` to store, the `file` it is and the `copy` directory it is read back into. */
function recording(operation: BarrierOperation, before: (context: Context, identity: string) => void = () => {}): Phase {
  return {
    name: "record",
    async run(context) {
      const url = context.adminUrl()
      const { loginState } = context.layout
      await asOwner(url, async (sql) => {
        const identity = await databaseIdentity(sql, url)
        before(context, identity)
        const recorded = await recordLogins(sql, { operation, identity, run: context.run, commit: context.commit, barrier: context.barrier })
        mkdirSync(path.dirname(loginState.file), { recursive: true })
        writeFileSync(loginState.file, recorded.text)
        context.output("artifact", loginState.artifact)
        context.output("file", loginState.file)
        context.output("copy", loginState.copy)
        context.summary(spellRecord(recorded))
      })
    },
  }
}

/** An operation's last phase behind the barrier: closed over the record as the store gave it back, the work and its checks, the recorded logins back, and the roles reported as the check reports them. */
function behindTheBarrier(name: string, work: (context: Context, url: string) => Promise<void>): Phase {
  return {
    name,
    async run(context) {
      const url = context.adminUrl()
      const { loginState } = context.layout
      await asOwner(url, async (sql) => {
        const scope = { identity: await databaseIdentity(sql, url), run: context.run, commit: context.commit, barrier: context.barrier }
        const recorded = readFileSync(loginState.file, "utf8")
        const stored = readFileSync(path.join(loginState.copy, LOGIN_STATE_FILE), "utf8")
        await behindBarrier(sql, { ...scope, recorded, stored, say: context.summary }, () => work(context, url))
        await verifyLogins(sql, url, context.summary)
      })
    },
  }
}

/** A release's database: the journal checked, then the backup; then the migrations, the seed where asked, and the journal and the committed fingerprint again. */
export const releasePhases = {
  backUp: backingUp(async (context, url) => {
    await requireJournal(url, context.log)
  }),
  migrate: {
    name: "migrate",
    async run(context) {
      const url = context.adminUrl()
      await migrateAndSay(url, { log: context.log, notice: (line) => console.error(line) })
      if (context.env.RUN_SEED === "true") context.log(spellSeed(await seedDemo(url), url))
      await requireJournal(url, context.log)
      await requireFingerprint(url, context.log)
    },
  } satisfies Phase,
}

/** A reset to the seed: a Pilot at main's schema, fingerprinted, backed up; the logins recorded; then the sweep and the seed in one transaction behind the barrier, and the journal and the fingerprint again. */
export const resetToSeedPhases = {
  backUp: backingUp(async (context, url) => {
    const { pending } = await requireJournal(url, context.log)
    if (pending.length > 0) throw new Refusal(`${pending.length} migration(s) pending: the reset writes main's seed, which needs main's schema. Run release first.`)
    await requireFingerprint(url, context.log)
  }),
  record: recording("reset-to-seed"),
  sweep: behindTheBarrier("sweep", async (context, url) => {
    for (const line of spellReset(await resetToSeed(url), url)) context.summary(line)
    await requireJournal(url, context.log)
    await requireFingerprint(url, context.log)
  }),
}

/**
 * A restore, once its first phase has chosen the source run's backup and the
 * workflow has downloaded it: a safety backup of the database as it is; the
 * backup decrypted, with the age key and nothing else; verified against its
 * manifest, this database and the source run, and the logins recorded; then
 * behind the barrier, the schemas dropped and the backup restored in one
 * transaction, proved by the journal check and the backup's own fingerprint.
 */
export const restorePhases = {
  backUp: backingUp(async () => {}, { tolerateIncomplete: true }),
  decrypt: {
    name: "decrypt",
    async run(context) {
      const archive = theOneFile(context.layout.source(BACKUP_ARTIFACT).dir, (name) => name.endsWith(".tar.age"), "encrypted backups")
      decryptBackup({ env: context.env, archive, identity: context.required("AGE_IDENTITY"), dir: context.layout.restore, scratch: context.layout.scratch.restoreKey, log: context.log })
    },
  } satisfies Phase,
  record: recording("restore", (context, identity) => {
    const manifest = verifyBackup(context.layout.restore)
    const source = readSourceRun(context, BACKUP_ARTIFACT)
    checkRestoreTarget(manifest, { identity, commit: source.commit, run: source.run })
    context.summary(
      `Verified a backup of ${manifest.identity} at commit ${manifest.commit}, taken ${manifest.createdAt} by run ${manifest.run.id} attempt ${manifest.run.attempt}: ${manifest.journal.applied} journal rows, schemas ${manifest.schemas.join(", ")}, every file as recorded`,
    )
  }),
  apply: behindTheBarrier("apply", async (context, url) => {
    await restoreDatabase({ env: context.env, url, dir: context.layout.restore, log: context.log })
  }),
}

/** recover-logins, once its first phase has chosen the source run's login record and the workflow has downloaded it: the recorded states back. */
export const recoverLoginsPhases = {
  recover: {
    name: "recover",
    async run(context) {
      const url = context.adminUrl()
      const source = readSourceRun(context, LOGIN_STATE_ARTIFACT)
      const file = theOneFile(context.layout.source(LOGIN_STATE_ARTIFACT).dir, (name) => name === LOGIN_STATE_FILE, "login records")
      await asOwner(url, async (sql) => {
        const scope = { identity: await databaseIdentity(sql, url), run: source.run, commit: source.commit, barrier: context.barrier }
        context.summary(spellOpened(await openFromRecord(sql, readFileSync(file, "utf8"), scope)))
      })
    },
  } satisfies Phase,
}

/**
 * redrive: every job on the worker's dead-letter queue put back on the queue
 * it failed on, once the cause is fixed and released — pg-boss's own redrive
 * (jobs.ts), with no filter an operator could type. Refuses a database with
 * migrations pending, where the fix is not released yet. A job that fails
 * again is dead-lettered again; one whose queue is gone stays, and is said.
 */
export const redrivePhases = {
  redrive: {
    name: "redrive",
    async run(context) {
      const url = context.adminUrl()
      const { pending } = await requireJournal(url, context.log)
      if (pending.length > 0) throw new Refusal(`${pending.length} migration(s) pending: release first, so the jobs run on the code that fixes them`)
      const pool = createDb(url, { max: 1 })
      try {
        const { total, destinations, unroutable, moved } = await redriveDeadLetters(pool, OUTBOX_DEAD_QUEUE)
        if (total === 0) return context.summary(`${OUTBOX_DEAD_QUEUE} holds no dead letter: nothing to redrive`)
        context.summary(`${OUTBOX_DEAD_QUEUE} held ${total} dead letter(s): ${destinations.map(({ name, count }) => `${count} from ${name}`).join(", ") || "none with a queue to go back to"}`)
        context.summary(`Redrove ${moved}, each a fresh job on the queue it failed on; one that fails again is dead-lettered again`)
        if (unroutable > 0) context.summary(`${unroutable} left in place: the queue they failed on is gone`)
      } catch (error) {
        if (error instanceof QueueMissing) throw new Refusal(`No ${OUTBOX_DEAD_QUEUE} queue on this database: the worker that makes it has not started here`)
        throw error
      } finally {
        await pool.close()
      }
    },
  } satisfies Phase,
}

/**
 * grant-logins: LOGIN for exactly the roles the table (roles.ts) gives a URL
 * of their own, with the passwords the `pilot` environment's URL secrets
 * carry, every URL held to the Pilot's session pooler (PILOT_DATABASE_HOST),
 * its Supabase project, its database and its own role before anything runs,
 * and every password masked in the log first. Inside GitHub Actions only,
 * since masking is a runner's command.
 */
export const grantLoginsPhases = {
  grant: {
    name: "grant",
    async run(context) {
      if (context.env.GITHUB_ACTIONS !== "true") throw new Error("grant-logins runs inside the protected workflow only")
      const ref = context.required("PILOT_SUPABASE_REF")
      const adminUrl = context.adminUrl()
      const urls = Object.fromEntries([[OWNER.urls.pilot, adminUrl], ...GRANTED_ROLES.map((role) => [role.urls.pilot, context.required(role.urls.pilot)])])
      const plan = planPilotLogins(urls, { ref, host: context.required("PILOT_DATABASE_HOST") })
      for (const secret of plan.secrets) console.log(`::add-mask::${secret}`)
      for (const login of plan.logins) await grantLogin(adminUrl, login)
      await asOwner(adminUrl, async (sql) => {
        context.summary(`Granted LOGIN with the environment's passwords: ${spellLogins(await readLogins(sql, plan.logins.map((login) => login.role)))}`)
      })
    },
  } satisfies Phase,
}
