// The wiring end to end, on a database of this file's own (database.ts says
// why the owner runs it): migration 0011 installed pg-boss's schema, `startBoss`
// registers every job of the registry — the queue with its options, the
// worker, the schedule — the heartbeat's schedule fires and its handler runs
// with the context it was given, a job sent by hand runs the same way, a
// handler that throws is a failed job the readiness count sees, and a second
// start converges: the queue options rewritten, the schedule kept once, a
// schedule dropped from the registry unscheduled. pg-boss's cron pass is asked
// every second here rather than every minute, so the beat is seen inside the
// test's timeout; the expression itself stays the registry's.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { migrateDatabase } from "@waste/db/migrate"
import { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION } from "@waste/db/sql/pgboss"
import { PgBoss } from "pg-boss"

import { createBoss, startBoss, STOP_TIMEOUT_MS, type Boss } from "../boss"
import { defineJob, JOBS, type JobContext } from "../jobs"
import { heartbeat } from "../jobs/heartbeat"
import { checkBoss } from "../readiness"
import { ownerUnderTest } from "./database"
import { REFUSED_URL } from "./unreachable"

const owner = ownerUnderTest()

/** Waits for `condition` to hold, asking every 100 ms, for at most `ms`. */
async function until(condition: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`${what} did not happen within ${ms} ms`)
}

/** The same server and credentials, another database. */
const withDatabaseName = (url: string, name: string): string => {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

describe("the worker booted against a migrated database", { skip: owner.skip }, () => {
  const name = `waste_worker_boot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let fresh: Database
  let url: string
  const lines: string[] = []
  const errors: string[] = []
  let running: Boss | undefined

  const context = (pools: Database): JobContext => ({
    api: pools,
    worker: pools,
    now: () => new Date("2026-09-25T12:00:00Z"),
    log: (message) => void lines.push(message),
    send: (queue, data, options) => running!.boss.send(queue, data, options),
  })

  before(async () => {
    admin = createDb(owner.url, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    url = withDatabaseName(owner.url, name)
    await migrateDatabase(url)
    fresh = createDb(url, { max: 2 })
  })
  after(async () => {
    await running?.stop(2_000)
    await fresh?.close()
    try {
      await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin.close()
    }
  })

  test("refuses to start on a database without pg-boss's schema, naming the reason, and on one nobody answers on", async () => {
    // The fresh database has the schema; a schema name nothing installed stands in for a database without one.
    const missing = new PgBoss({ connectionString: url, schema: "nowhere", migrate: false })
    await assert.rejects(missing.start(), /pg-boss is not installed/)
    await missing.stop({ graceful: false, close: true, timeout: 1_000 })
    const refused = createBoss({ url: REFUSED_URL, log: (line) => void errors.push(line) })
    await assert.rejects(refused.start(), /ECONNREFUSED/)
    await refused.stop({ graceful: false, close: true, timeout: 1_000 })
  })

  test("starts with migrate: false on the schema 0011 installed, at the pinned version, and registers every job of the registry", async () => {
    const boss = createBoss({ url, log: (line) => void errors.push(line), cronWorkerIntervalSeconds: 1, monitorIntervalSeconds: 1 })
    running = await startBoss(boss, JOBS, context(fresh))
    assert.deepEqual(running.queues, JOBS.map((job) => job.queue))
    assert.equal(await boss.schemaVersion(), PGBOSS_SCHEMA_VERSION)
    const queues = await boss.getQueues([...running.queues])
    assert.deepEqual(
      queues.map((queue) => queue.name),
      JOBS.map((job) => job.queue),
    )
    const heartbeatQueue = queues.find((queue) => queue.name === heartbeat.queue)
    assert.equal(heartbeatQueue?.retryLimit, 0)
    assert.equal(heartbeatQueue?.deleteAfterSeconds, 86_400)
    const schedules = await boss.getSchedules()
    // pg-boss answers the schedules in its own order, not the registry's.
    const byName = (a: [string, ...unknown[]], b: [string, ...unknown[]]) => a[0].localeCompare(b[0])
    assert.deepEqual(
      schedules.map((schedule): [string, ...unknown[]] => [schedule.name, schedule.cron, schedule.timezone, schedule.data]).sort(byName),
      JOBS.filter((job) => job.schedule !== undefined)
        .map((job): [string, ...unknown[]] => [job.queue, job.schedule, job.scheduleOptions?.tz ?? "UTC", job.scheduleData ?? null])
        .sort(byName),
    )
    assert.deepEqual(errors, [])
  })

  test("the heartbeat's schedule fires and its handler runs with the context: one line with the pinned clock and the schedule as its source", async () => {
    await until(() => lines.some((line) => line.includes("(schedule, job ")), 75_000, "a scheduled heartbeat")
    const beat = lines.find((line) => line.includes("(schedule, job "))!
    assert.match(beat, /^worker\.heartbeat: 2026-09-25T12:00:00\.000Z \(schedule, job [0-9a-f-]{36}\)$/)
    const [row] = await fresh.sql.unsafe<{ state: string; output: { beats: number } | null }[]>(`select state, output from ${PGBOSS_SCHEMA}.job where name = '${heartbeat.queue}' and state = 'completed' limit 1`)
    assert.ok(row, "the beat is a completed row in pg-boss's table")
    assert.deepEqual(row.output, { beats: 1 })
  })

  test("a heartbeat sent by hand through the context runs the same way", async () => {
    const id = await context(fresh).send(heartbeat.queue, { source: "manual" })
    assert.ok(id)
    await until(() => lines.some((line) => line.includes(`(manual, job ${id})`)), 10_000, "the manual heartbeat")
  })

  test("a handler that throws is a failed job, counted by the readiness check over the registered queues", async () => {
    const failing = defineJob<{ reason: string }>({
      queue: "test.fails",
      description: "Throws.",
      queueOptions: { retryLimit: 0 },
      workOptions: { pollingIntervalSeconds: 0.5 },
      handler: async (jobs) => {
        throw new Error(`refused: ${jobs[0].data.reason}`)
      },
    })
    const boss = running!.boss
    await boss.createQueue(failing.queue, failing.queueOptions)
    await boss.work<{ reason: string }>(failing.queue, failing.workOptions!, (batch) => failing.handler(batch, context(fresh)))
    const id = await boss.send(failing.queue, { reason: "on purpose" })
    await until(async () => (await boss.findJobs(failing.queue, { id: id! }))[0]?.state === "failed", 10_000, "the failure")
    const probe = { boss, queues: [...running!.queues, failing.queue], isStarted: () => true }
    // The count the probe reads is the one pg-boss's monitor pass caches on the queue row, once a
    // supervise interval (a minute in production; readiness.ts says so). Asked for here rather than waited for.
    await until(async () => {
      await boss.supervise(failing.queue)
      const check = await checkBoss(probe)
      return check.boss === "ok" && check.failedJobs === 1
    }, 10_000, "the failed count reaching the probe")
    assert.deepEqual(await checkBoss({ ...probe, queues: [...running!.queues] }), { boss: "ok", failedJobs: 0 }, "the heartbeat's own queue has no failure")
  })

  test("stop is idempotent and leaves the process with nothing to wait on; a second start converges on the registry", async () => {
    const first = running!.stop(2_000)
    assert.equal(running!.stop(2_000), first)
    await first
    assert.deepEqual(await checkBoss({ boss: running!.boss, queues: running!.queues, isStarted: () => false }), { boss: "stopped" })
    // A registry with the heartbeat's retry policy changed and its schedule dropped: the second start rewrites the one and unschedules the other.
    const changed = defineJob({ ...heartbeat, queueOptions: { retryLimit: 2, deleteAfterSeconds: 3_600 }, schedule: undefined })
    const boss: PgBoss = createBoss({ url, log: (line) => void errors.push(line) })
    running = await startBoss(boss, [changed], context(fresh))
    const [queue] = await boss.getQueues([heartbeat.queue])
    assert.equal(queue.retryLimit, 2)
    assert.equal(queue.deleteAfterSeconds, 3_600)
    assert.deepEqual(await boss.getSchedules(heartbeat.queue), [])
    assert.equal(STOP_TIMEOUT_MS, 10_000)
    await running.stop(2_000)
    assert.deepEqual(errors, [])
  })
})
