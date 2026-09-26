// The wiring end to end, on a database of this file's own (database.ts says
// why the owner runs it): migration 0011 installed pg-boss's schema, `startBoss`
// registers every job of the registry — the queue with its options, the
// worker, the schedule, the subscriptions — the heartbeat's schedule fires and
// its handler runs with the context it was given, a job sent by hand runs the
// same way, the relay's `publish` of a subscribed kind lands on the consumer's
// queue as a job whose data is the event (the handshake `outbox/queues.ts`
// assumes, proved against pg-boss's own fan-out), a handler that throws is a
// failed job the readiness count sees, and a second start converges: the queue
// options rewritten, the schedule kept once, a schedule dropped from the
// registry unscheduled, a subscription dropped from it unsubscribed. pg-boss's
// cron pass is asked every second here rather than every minute, so the beat
// is seen inside the test's timeout; the expression itself stays the
// registry's.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { migrateDatabase } from "@waste/db/migrate"
import { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION } from "@waste/db/sql/pgboss"
import { PgBoss } from "pg-boss"

import { createBoss, startBoss, STOP_TIMEOUT_MS, subscribedEvents, type Boss } from "../boss"
import { defineJob, JOBS, type JobContext } from "../jobs"
import { heartbeat } from "../jobs/heartbeat"
import { openTickets } from "../jobs/open-tickets"
import { recordBillableEvents } from "../jobs/record-billable-events"
import { relayOutbox } from "../jobs/relay-outbox"
import { outboxEventName, outboxQueue } from "../outbox/queues"
import { OUTBOX_QUEUES } from "../outbox/subscribe"
import { checkBoss } from "../readiness"
import { ownerUnderTest, withDatabaseName } from "./database"
import { until } from "./until"
import { REFUSED_URL } from "./unreachable"

const owner = ownerUnderTest()

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
    publish: (event, data, options) => running!.boss.publish(event, data, options),
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

  test("starts with migrate: false on the schema 0011 installed, at the pinned version, and registers every job of the registry with the queues it publishes to", async () => {
    const boss = createBoss({ url, log: (line) => void errors.push(line), cronWorkerIntervalSeconds: 1, monitorIntervalSeconds: 1 })
    running = await startBoss(boss, JOBS, context(fresh))
    assert.deepEqual(running.queues, JOBS.map((job) => job.queue))
    assert.deepEqual(running.published, OUTBOX_QUEUES.map((queue) => queue.queue), "the relay's outbox.<kind> queues, each once")
    assert.equal(await boss.schemaVersion(), PGBOSS_SCHEMA_VERSION)
    const queues = await boss.getQueues([...running.queues, ...running.published])
    assert.deepEqual(
      queues.map((queue) => queue.name).sort(),
      [...JOBS.map((job) => job.queue), ...running.published].sort(),
    )
    const heartbeatQueue = queues.find((queue) => queue.name === heartbeat.queue)
    assert.equal(heartbeatQueue?.retryLimit, 0)
    assert.equal(heartbeatQueue?.deleteAfterSeconds, 86_400)
    const relayQueue = queues.find((queue) => queue.name === relayOutbox.queue)
    assert.equal(relayQueue?.policy, "short", "one relay tick queued at a time")
    assert.equal(relayQueue?.retryLimit, 0)
    const published = queues.find((queue) => queue.name === "outbox.pickup-failed")
    assert.deepEqual([published?.policy, published?.retryLimit, published?.retryDelay, published?.retryBackoff], ["standard", 3, 10, true], "a consumer's queue carries the relay's retry policy")
    const schedules = await boss.getSchedules()
    // pg-boss answers the schedules in its own order, not the registry's.
    const byName = (a: [string, ...unknown[]], b: [string, ...unknown[]]) => a[0].localeCompare(b[0])
    assert.deepEqual(
      schedules.map((schedule): [string, ...unknown[]] => [schedule.name, schedule.cron, schedule.timezone, schedule.data]).sort(byName),
      JOBS.filter((job) => job.schedule !== undefined)
        .map((job): [string, ...unknown[]] => [job.queue, job.schedule, job.scheduleOptions?.tz ?? "UTC", job.scheduleData ?? null])
        .sort(byName),
    )
    for (const job of JOBS) {
      assert.deepEqual(await subscribedEvents(boss, job.queue), [...(job.subscriptions ?? []), ...(job.subscribes ?? []).map(outboxEventName)].sort(), `${job.queue}'s subscriptions are the registry's`)
    }
    assert.deepEqual(errors, [])
  })

  test("a publish of an outbox event lands as one job on the consumer's queue and its handler runs over the context — the relay's side of the fan-out, as src/outbox/queues.ts assumes it — and an event the queue is not subscribed to sends nothing here", async () => {
    const boss = running!.boss
    // A well-formed outbox row of a kind the domain answers nothing for: the handler completes with `nothing` and reads no table, so the boot database needs no tenant. What the consumer does with a case is open-tickets.test.ts's; here the question is the fan-out.
    const row = {
      id: "01a0d3a5-e5e0-7000-8000-000000000101",
      companyId: "01a0d3a5-e5e0-7000-8000-000000000100",
      projectId: "01a0d3a5-e5e0-7000-8000-000000000102",
      kind: "pickup-completed",
      aggregateKind: "pickup",
      aggregateId: "01a0d3a5-e5e0-7000-8000-000000000103",
      occurredAt: "2026-10-05T05:12:00.000Z",
      payload: { id: "01a0d3a5-e5e0-7000-8000-000000000103" },
      publishedAt: null,
      createdAt: "2026-10-05T05:12:00.000Z",
      updatedAt: "2026-10-05T05:12:00.000Z",
    }
    await boss.publish(outboxQueue("pickup-failed"), row)
    await until(async () => (await boss.findJobs(openTickets.queue, {})).some((job) => job.state === "completed"), 10_000, "the published job worked on the consumer's queue")
    const jobs = await boss.findJobs(openTickets.queue, {})
    assert.equal(jobs.length, 1)
    assert.deepEqual(jobs[0].data, row, "the published data is the job's data")
    assert.deepEqual(jobs[0].output, { outcome: "nothing" }, "the handler ran and answered")
    assert.ok(lines.some((line) => line === `resolution.open-tickets: pickup-completed ${row.id} → nothing`), "and logged it through the context")
    await boss.publish(outboxQueue("route-cancelled"), row)
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal((await boss.findJobs(openTickets.queue, {})).length, 1, "an event the queue is not subscribed to sends nothing here (§7.10)")
  })

  test("the relay's publish of a subscribed kind lands on the consumer's queue as a job whose data is the published event, and an unsubscribed kind lands nowhere", async () => {
    const boss = running!.boss
    // The consumer's own handler would read the tenant's rows; here the fan-out is what is proved, so the queue's worker is stopped and the job is read off the table.
    await boss.offWork(recordBillableEvents.queue)
    const event = { id: "01a0d3a5-e5e0-7000-8000-00000000abcd", companyId: "01a0d3a5-e5e0-7000-8000-000000000000", projectId: "01a0d3a5-e5e0-7000-8000-000000000001", kind: "pickup-completed", aggregateKind: "pickup", aggregateId: "01a0d3a5-e5e0-7000-8000-000000000002", occurredAt: "2026-10-05T04:45:00.000Z", payload: { id: "01a0d3a5-e5e0-7000-8000-000000000002" }, publishedAt: null, createdAt: "2026-10-05T04:45:00.000Z", updatedAt: "2026-10-05T04:45:00.000Z" }
    await boss.publish(outboxEventName("pickup-completed"), event)
    await until(async () => (await boss.findJobs(recordBillableEvents.queue, {})).length === 1, 10_000, "the published event on the consumer's queue")
    const [job] = await boss.findJobs(recordBillableEvents.queue, {})
    assert.deepEqual(job.data, event, "the job's data is the event as published")
    assert.equal(job.state, "created")
    // A kind nobody subscribed to fans out to no queue and is not an error.
    await boss.publish(outboxEventName("route-dispatched"), event)
    assert.equal((await boss.findJobs(recordBillableEvents.queue, {})).length, 1)
    await boss.deleteJob(recordBillableEvents.queue, job.id)
  })

  test("the heartbeat's schedule fires and its handler runs with the context: one line with the pinned clock and the schedule as its source", async () => {
    await until(() => lines.some((line) => line.includes("(schedule, job ")), 75_000, "a scheduled heartbeat")
    const beat = lines.find((line) => line.includes("(schedule, job "))!
    assert.match(beat, /^worker\.heartbeat: 2026-09-25T12:00:00\.000Z \(schedule, job [0-9a-f-]{36}\)$/)
    const [row] = await fresh.sql.unsafe<{ state: string; output: { beats: number } | null }[]>(`select state, output from ${PGBOSS_SCHEMA}.job where name = '${heartbeat.queue}' and state = 'completed' limit 1`)
    assert.ok(row, "the beat is a completed row in pg-boss's table")
    assert.deepEqual(row.output, { beats: 1 })
  })

  test("the relay's schedule fired in the same minute and the tick chained: a completed occurrence of the schedule's, a completed successor five seconds on, and at most one tick queued at any moment", async () => {
    const ticks = () => fresh.sql.unsafe<{ state: string; source: string }[]>(`select state, data->>'source' as source from ${PGBOSS_SCHEMA}.job where name = '${relayOutbox.queue}' order by created_on`)
    await until(async () => (await ticks()).some((tick) => tick.source === "schedule" && tick.state === "completed"), 10_000, "the scheduled tick completing")
    await until(async () => (await ticks()).some((tick) => tick.source === "successor" && tick.state === "completed"), 10_000, "a successor completing")
    const seen = await ticks()
    assert.ok(seen.every((tick) => tick.state !== "failed"), `no tick failed on an empty outbox: ${JSON.stringify(seen)}`)
    assert.ok(seen.filter((tick) => tick.state === "created").length <= 1, "the short policy: one queued tick at a time")
    assert.deepEqual(lines.filter((line) => line.startsWith("execution.relay-outbox")), [], "an empty outbox logs nothing")
  })

  test("a heartbeat sent by hand through the context runs the same way", async () => {
    const id = await context(fresh).send(heartbeat.queue, { source: "manual" })
    assert.ok(id)
    await until(() => lines.some((line) => line.includes(`(manual, job ${id})`)), 10_000, "the manual heartbeat")
  })

  test("a handler that throws is a failed job, counted by the readiness check over the registered queues — the consumer's among them, whose job with data that is not an outbox row fails after its retries", async () => {
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
    assert.deepEqual(await checkBoss({ ...probe, queues: [...running!.queues] }), { boss: "ok", failedJobs: 0 }, "the heartbeat's and the consumer's own queues have no failure yet")

    // The consumer's queue is one the probe reads: a job whose data drifted from the contract fails there after its retries (three, with backoff — sent here with none, so the test sees it within its bound) and the count moves.
    assert.ok(running!.queues.includes(openTickets.queue), "the probe sums over the registry's queues, the consumer's among them")
    const drifted = await boss.send(openTickets.queue, { not: "an outbox row" }, { retryLimit: 0 })
    await until(async () => (await boss.findJobs(openTickets.queue, { id: drifted! }))[0]?.state === "failed", 10_000, "the drifted job's failure")
    await until(async () => {
      await boss.supervise(openTickets.queue)
      const check = await checkBoss({ ...probe, queues: [...running!.queues] })
      return check.boss === "ok" && check.failedJobs === 1
    }, 10_000, "the consumer's failure reaching the probe")
  })

  test("stop is idempotent and leaves the process with nothing to wait on; a second start converges on the registry", async () => {
    const first = running!.stop(2_000)
    assert.equal(running!.stop(2_000), first)
    await first
    assert.deepEqual(await checkBoss({ boss: running!.boss, queues: running!.queues, isStarted: () => false }), { boss: "stopped" })
    // A registry with the heartbeat's retry policy changed and its schedule dropped, the relay's published queues brought to a changed retry policy, and the consumer with one subscription fewer: the second start rewrites the one, unschedules the other, updates the third without touching its policy and unsubscribes the dropped event.
    const changed = defineJob({ ...heartbeat, queueOptions: { retryLimit: 2, deleteAfterSeconds: 3_600 }, schedule: undefined })
    const republished = defineJob({ ...relayOutbox, publishes: [{ queue: "outbox.pickup-failed", queueOptions: { retryLimit: 5 } }] })
    const narrowed = defineJob({ ...openTickets, subscriptions: [outboxQueue("pickup-failed"), outboxQueue("command-rejected")] })
    const narrowedFinance = defineJob({ ...recordBillableEvents, subscribes: ["pickup-completed", "ticket-completed"] })
    const boss: PgBoss = createBoss({ url, log: (line) => void errors.push(line) })
    running = await startBoss(boss, [changed, republished, narrowed, narrowedFinance], context(fresh))
    const [queue] = await boss.getQueues([heartbeat.queue])
    assert.equal(queue.retryLimit, 2)
    assert.equal(queue.deleteAfterSeconds, 3_600)
    assert.deepEqual(await boss.getSchedules(heartbeat.queue), [])
    assert.deepEqual(running.published, ["outbox.pickup-failed"])
    const [pickupFailed] = await boss.getQueues(["outbox.pickup-failed"])
    assert.deepEqual([pickupFailed.policy, pickupFailed.retryLimit], ["standard", 5])
    assert.deepEqual(await subscribedEvents(boss, openTickets.queue), ["outbox.command-rejected", "outbox.pickup-failed"], "the two dropped events are unsubscribed, the two kept stay")
    assert.deepEqual(await subscribedEvents(boss, recordBillableEvents.queue), ["pickup-completed", "ticket-completed"], "pickup-corrected unsubscribed")
    assert.equal(STOP_TIMEOUT_MS, 10_000)
    await running.stop(2_000)
    assert.deepEqual(errors, [])
  })
})
