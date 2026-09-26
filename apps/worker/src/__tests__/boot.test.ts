// The wiring end to end, on a database of this file's own (database.ts says
// why the owner runs it): migration 0011 installed pg-boss's schema, `startBoss`
// registers every job of the registry — the queues the relay publishes to
// first, then each job's queue with its options, the worker, the schedule —
// the heartbeat's schedule fires and its handler runs with the context it was
// given, a job sent by hand runs the same way, a `RelayedEvent` sent to an
// `outbox.<kind>` queue the way the relay sends one is worked by the consumer
// of that kind (the seam `outbox/subscribe.ts` spells, proved against pg-boss's
// own tables), a handler that throws is a failed job the readiness count sees,
// and a second start converges: the queue options rewritten, the schedule kept
// once, a schedule dropped from the registry unscheduled, a published queue
// brought to a changed retry policy without its policy touched. pg-boss's cron
// pass is asked every second here rather than every minute, so the beat is
// seen inside the test's timeout; the expression itself stays the registry's.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { migrateDatabase } from "@waste/db/migrate"
import { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION } from "@waste/db/sql/pgboss"
import { PgBoss } from "pg-boss"

import { createBoss, startBoss, STOP_TIMEOUT_MS, type Boss } from "../boss"
import { defineJob, JOBS, type JobContext } from "../jobs"
import { heartbeat } from "../jobs/heartbeat"
import { OPEN_TICKETS_QUEUE_OPTIONS, openTickets } from "../jobs/open-tickets"
import { RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS, recordBillableEvents } from "../jobs/record-billable-events"
import { relayOutbox } from "../jobs/relay-outbox"
import { CONSUMED_RETENTION_SECONDS, DEAD_LETTER_RETENTION_SECONDS, OUTBOX_DEAD_QUEUE, OUTBOX_QUEUES, outboxQueue, UNCONSUMED_RETENTION_SECONDS, type RelayedEvent } from "../outbox/subscribe"
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

  test("starts with migrate: false on the schema 0011 installed, at the pinned version, and registers every job of the registry with the queues it publishes to — the dead-letter queue first, a consumer's queue options written over the relay's with the dead letter and the fortnight, a queue nobody consumes keeping the relay's and its ninety days", async () => {
    const boss = createBoss({ url, log: (line) => void errors.push(line), cronWorkerIntervalSeconds: 1, monitorIntervalSeconds: 1, cronMonitorIntervalSeconds: 1 })
    running = await startBoss(boss, JOBS, context(fresh))
    assert.deepEqual(running.queues, JOBS.map((job) => job.queue))
    assert.deepEqual(running.published, [OUTBOX_DEAD_QUEUE, ...OUTBOX_QUEUES.map((queue) => queue.queue)], "the dead-letter queue and then the relay's outbox.<kind> queues, each once")
    assert.equal(await boss.schemaVersion(), PGBOSS_SCHEMA_VERSION)
    const queues = await boss.getQueues([...running.queues, ...running.published])
    assert.deepEqual(
      queues.map((queue) => queue.name).sort(),
      [...new Set([...JOBS.map((job) => job.queue), ...running.published])].sort(),
      "the consumers' queues are among the published ones, and every queue exists once",
    )
    const heartbeatQueue = queues.find((queue) => queue.name === heartbeat.queue)
    assert.equal(heartbeatQueue?.retryLimit, 0)
    assert.equal(heartbeatQueue?.deleteAfterSeconds, 86_400)
    const relayQueue = queues.find((queue) => queue.name === relayOutbox.queue)
    assert.equal(relayQueue?.policy, "short", "one relay tick queued at a time")
    assert.equal(relayQueue?.retryLimit, 0)
    const dead = queues.find((queue) => queue.name === OUTBOX_DEAD_QUEUE)
    assert.deepEqual([dead?.policy, dead?.retryLimit, dead?.retentionSeconds, dead?.deadLetter], ["standard", 0, DEAD_LETTER_RETENTION_SECONDS, null], "the dead-letter queue: no retry, ninety days, no dead letter of its own")
    const unconsumed = queues.find((queue) => queue.name === outboxQueue("route-dispatched"))
    assert.deepEqual([unconsumed?.policy, unconsumed?.retryLimit, unconsumed?.retryDelay, unconsumed?.retryBackoff, unconsumed?.retentionSeconds, unconsumed?.deadLetter], ["standard", 3, 10, true, UNCONSUMED_RETENTION_SECONDS, null], "a queue no consumer works carries the relay's retry policy, keeps a job ninety days for the consumer to come, and dead-letters nowhere: nothing fails on it")
    const resolutions = queues.find((queue) => queue.name === outboxQueue("pickup-failed"))
    assert.deepEqual([resolutions?.policy, resolutions?.retryLimit, resolutions?.retryDelay, resolutions?.retryBackoff, resolutions?.retentionSeconds, resolutions?.deadLetter], ["standard", OPEN_TICKETS_QUEUE_OPTIONS.retryLimit, OPEN_TICKETS_QUEUE_OPTIONS.retryDelay, true, CONSUMED_RETENTION_SECONDS, OUTBOX_DEAD_QUEUE], "Resolution's queue options written over the relay's, the policy untouched, the seam's dead letter and fortnight with them")
    const finances = queues.find((queue) => queue.name === outboxQueue("pickup-completed"))
    assert.deepEqual([finances?.retryLimit, finances?.retryDelay, finances?.retryDelayMax, finances?.deleteAfterSeconds, finances?.deadLetter], [RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS.retryLimit, RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS.retryDelay, RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS.retryDelayMax, RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS.deleteAfterSeconds, OUTBOX_DEAD_QUEUE], "Finance's the same, its backoff cap among them")
    const schedules = await boss.getSchedules()
    // pg-boss answers the schedules in its own order, not the registry's.
    const byName = (a: [string, ...unknown[]], b: [string, ...unknown[]]) => a[0].localeCompare(b[0])
    assert.deepEqual(
      schedules.map((schedule): [string, ...unknown[]] => [schedule.name, schedule.cron, schedule.timezone, schedule.data]).sort(byName),
      JOBS.filter((job) => job.schedule !== undefined)
        .map((job): [string, ...unknown[]] => [job.queue, job.schedule, job.scheduleOptions?.tz ?? "UTC", job.scheduleData ?? null])
        .sort(byName),
    )
    const subscriptions = await fresh.sql.unsafe<{ count: string }[]>(`select count(*)::text as count from ${PGBOSS_SCHEMA}.subscription`)
    assert.equal(subscriptions[0].count, "0", "pg-boss's fan-out is not used: the relay's send to the kind's queue is the one door")
    assert.deepEqual(errors, [])
  })

  test("a RelayedEvent sent to outbox.<kind> the way the relay sends one is worked by the consumer of that kind, its handler running over the context — the one door the seam spells", async () => {
    const boss = running!.boss
    // A driver's own skip (`not-presented`) is no case (§3), so Resolution's handler reads the tenant's rows — none, on this database — and completes with `nothing`, writing nothing; what it does with a case is open-tickets.test.ts's. Here the question is the door: the send lands on the kind's queue and the consumer's worker takes it.
    const pickupId = "01a0d3a5-e5e0-7000-8000-000000000103"
    const event: RelayedEvent = {
      id: "01a0d3a5-e5e0-7000-8000-000000000101",
      companyId: "01a0d3a5-e5e0-7000-8000-000000000100",
      projectId: "01a0d3a5-e5e0-7000-8000-000000000102",
      kind: "pickup-skipped",
      aggregateKind: "pickup",
      aggregateId: pickupId,
      occurredAt: "2026-10-05T05:12:00.000Z",
      payload: {
        id: pickupId,
        createdAt: "2026-10-05T05:00:00.000Z",
        updatedAt: "2026-10-05T05:12:00.000Z",
        projectId: "01a0d3a5-e5e0-7000-8000-000000000102",
        routeId: "01a0d3a5-e5e0-7000-8000-000000000104",
        containerId: "01a0d3a5-e5e0-7000-8000-000000000105",
        position: 1,
        status: "skipped",
        reason: "not-presented",
        note: null,
        propertyId: "01a0d3a5-e5e0-7000-8000-000000000106",
        sharedCollectionPointId: null,
        wasteFractionId: "01a0d3a5-e5e0-7000-8000-000000000107",
        arrivedAt: "2026-10-05T05:10:00.000Z",
        outcomeAt: "2026-10-05T05:12:00.000Z",
      },
      publishedAt: "2026-10-05T05:12:05.000Z",
      createdAt: "2026-10-05T05:12:00.000Z",
      updatedAt: "2026-10-05T05:12:05.000Z",
    }
    const queue = outboxQueue("pickup-skipped")
    assert.ok(openTickets.some((job) => job.queue === queue), "Resolution's consumer works the kind's queue")
    const id = await boss.send(queue, event)
    assert.ok(id)
    await until(async () => (await boss.findJobs(queue, { id: id! }))[0]?.state === "completed", 10_000, "the sent event worked on the kind's queue")
    const [job] = await boss.findJobs(queue, { id: id! })
    assert.deepEqual(job.data, event, "the sent data is the job's data")
    assert.deepEqual(job.output, { events: [event.id] }, "the seam's handler ran the consumer's over the parsed event and answered")
    assert.ok(lines.some((line) => line === `resolution.open-tickets: pickup-skipped ${event.id} → nothing`), "and the consumer logged it through the context")
  })

  test("the heartbeat's schedule fires and its handler runs with the context: one line with the pinned clock and the schedule as its source", async () => {
    // A minute boundary is up to 60 s away, then pg-boss's cron pass (every second here), the forwarding worker's poll (every second here) and the heartbeat queue's own (two seconds): 75 s covers it, and the suite's `--test-timeout` (120 s) stands above this bound, so a beat that never comes fails here by name and not by the runner's clock.
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

  test("a handler that throws is a failed job, counted by the readiness check over the registered queues — the consumers' among them, whose job with data that is not an outbox row fails after its retries", async () => {
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

    // A consumer's queue is one the probe reads: a job whose data drifted from the contract fails there after its retries (three, with backoff — sent here with none, so the test sees it within its bound) and the count moves.
    const consumed = outboxQueue("command-rejected")
    assert.ok(running!.queues.includes(consumed), "the probe sums over the registry's queues, the consumers' among them")
    const drifted = await boss.send(consumed, { not: "an outbox row" }, { retryLimit: 0 })
    await until(async () => (await boss.findJobs(consumed, { id: drifted! }))[0]?.state === "failed", 10_000, "the drifted job's failure")
    await until(async () => {
      await boss.supervise(consumed)
      const check = await checkBoss({ ...probe, queues: [...running!.queues] })
      return check.boss === "ok" && check.failedJobs === 1
    }, 10_000, "the consumer's failure reaching the probe")
  })

  test("a consumer's job that fails past its retries is copied to outbox.dead with its RelayedEvent intact and the queue it came from named, where the probe counts it as a dead letter and boss.redrive puts it back on its queue", async () => {
    const boss = running!.boss
    // A Finance event naming a pickup that is not there: the handler throws on every attempt (the row is not there, and never will be), which is the poison message — sent with no retry so the test sees the dead letter within its bound; the queue's own policy is five retries.
    const pickupId = "01a0d3a5-e5e0-7000-8000-000000000203"
    const event: RelayedEvent = {
      id: "01a0d3a5-e5e0-7000-8000-000000000201",
      companyId: "01a0d3a5-e5e0-7000-8000-000000000200",
      projectId: "01a0d3a5-e5e0-7000-8000-000000000202",
      kind: "pickup-completed",
      aggregateKind: "pickup",
      aggregateId: pickupId,
      occurredAt: "2026-10-05T06:12:00.000Z",
      payload: {
        id: pickupId,
        createdAt: "2026-10-05T05:00:00.000Z",
        updatedAt: "2026-10-05T06:12:00.000Z",
        projectId: "01a0d3a5-e5e0-7000-8000-000000000202",
        routeId: "01a0d3a5-e5e0-7000-8000-000000000204",
        containerId: "01a0d3a5-e5e0-7000-8000-000000000205",
        position: 1,
        status: "completed",
        reason: null,
        note: null,
        propertyId: "01a0d3a5-e5e0-7000-8000-000000000206",
        sharedCollectionPointId: null,
        wasteFractionId: "01a0d3a5-e5e0-7000-8000-000000000207",
        arrivedAt: "2026-10-05T06:10:00.000Z",
        outcomeAt: "2026-10-05T06:12:00.000Z",
        proofs: [],
      },
      publishedAt: "2026-10-05T06:12:05.000Z",
      createdAt: "2026-10-05T06:12:00.000Z",
      updatedAt: "2026-10-05T06:12:05.000Z",
    }
    const queue = outboxQueue("pickup-completed")
    assert.ok(recordBillableEvents.some((job) => job.queue === queue), "Finance's consumer works the kind's queue")
    const [before] = await boss.getQueues([queue])
    assert.equal(before.deadLetter, OUTBOX_DEAD_QUEUE, "the queue names the dead-letter queue")
    // The test above sent Resolution's queue a job that is not an outbox row, with no retry: it failed, and it is a dead letter already — data intact, however unparseable.
    const already = await boss.findJobs(OUTBOX_DEAD_QUEUE, {})
    assert.equal(already.length, 1, "the drifted job of the test above is on the dead-letter queue")
    assert.deepEqual([already[0].sourceName, already[0].data], [outboxQueue("command-rejected"), { not: "an outbox row" }])
    const id = await boss.send(queue, event, { retryLimit: 0 })
    assert.ok(id)
    await until(async () => (await boss.findJobs(queue, { id: id! }))[0]?.state === "failed", 10_000, "the poison job failing")
    const [failed] = await boss.findJobs(queue, { id: id! })
    assert.match(JSON.stringify(failed.output), /names pickup .* which is not in company/)

    // The copy on the dead-letter queue: the same data, the failure's output, and where it came from.
    const dead = await boss.findJobs<RelayedEvent>(OUTBOX_DEAD_QUEUE, { data: { id: event.id } })
    assert.equal(dead.length, 1, "one dead letter for the one failed job")
    const [letter] = dead
    assert.deepEqual(letter.data, event, "the RelayedEvent travels intact")
    assert.equal(letter.state, "created", "waiting: nobody works the dead-letter queue")
    assert.deepEqual([letter.sourceName, letter.sourceId], [queue, id], "the queue it failed on and the job it was, for the redrive")
    assert.match(JSON.stringify(letter.output), /names pickup .* which is not in company/, "the failure's reason rides along")
    assert.ok(letter.keepUntil.getTime() - Date.now() > 89 * 86_400_000, "kept ninety days for an operator")

    // The probe: the failed count on the consumer's queue, and the dead letters beside it (this one and the drifted job's) — a number, never a 503.
    const probe = { boss, queues: [...running!.queues], isStarted: () => true, deadLetterQueue: OUTBOX_DEAD_QUEUE }
    await until(async () => {
      await boss.supervise(queue)
      await boss.supervise(OUTBOX_DEAD_QUEUE)
      const check = await checkBoss(probe)
      return check.boss === "ok" && check.deadLetters === 2
    }, 10_000, "the dead letter reaching the probe")
    const counted = await checkBoss(probe)
    assert.ok(counted.boss === "ok" && counted.failedJobs >= 2 && counted.deadLetters === 2, JSON.stringify(counted))

    // The redrive: pg-boss's own door. Previewed first — where the job would go — then moved: a fresh job on the queue it failed on, the dead-letter queue emptied of it; the drifted job, not named, stays.
    assert.deepEqual(await boss.previewRedrive(OUTBOX_DEAD_QUEUE, { ids: [letter.id] }), { total: 1, destinations: [{ name: queue, count: 1 }], unroutable: 0 })
    assert.deepEqual(await boss.previewRedrive(OUTBOX_DEAD_QUEUE), { total: 2, destinations: [{ name: outboxQueue("command-rejected"), count: 1 }, { name: queue, count: 1 }], unroutable: 0 }, "unfiltered: every dead letter, by the queue it came from")
    assert.equal(await boss.redrive(OUTBOX_DEAD_QUEUE, { ids: [letter.id] }), 1)
    assert.deepEqual(await boss.findJobs(OUTBOX_DEAD_QUEUE, { data: { id: event.id } }), [], "moved off the dead-letter queue")
    assert.equal((await boss.findJobs(OUTBOX_DEAD_QUEUE, {})).length, 1, "the one not named stays")
    // Back on its queue — and, the cause not fixed, it fails again under the queue's own policy (five retries), dead-lettered again once they run out; here the retries are what the queue says, so the redriven job is seen queued or retrying, never lost.
    await until(async () => (await boss.findJobs<RelayedEvent>(queue, { data: { id: event.id } })).some((job) => job.id !== id), 10_000, "the redriven job on its source queue")
    const redriven = (await boss.findJobs<RelayedEvent>(queue, { data: { id: event.id } })).find((job) => job.id !== id)!
    assert.deepEqual(redriven.data, event)
    assert.equal(redriven.retryLimit, RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS.retryLimit, "a redriven job takes the queue's policy as it stands, not the send's `retryLimit: 0`")
  })

  test("stop is idempotent and leaves the process with nothing to wait on; a second start converges on the registry", async () => {
    const first = running!.stop(2_000)
    assert.equal(running!.stop(2_000), first)
    await first
    assert.deepEqual(await checkBoss({ boss: running!.boss, queues: running!.queues, isStarted: () => false }), { boss: "stopped" })
    // A registry with the heartbeat's retry policy changed and its schedule dropped, the relay's published queues brought to a changed retry policy, and a consumer dropped: the second start rewrites the one, unschedules the other, updates the third without touching its policy, and leaves the dropped consumer's queues where they are (their rows are evidence; retention takes them).
    const changed = defineJob({ ...heartbeat, queueOptions: { retryLimit: 2, deleteAfterSeconds: 3_600 }, schedule: undefined })
    const republished = defineJob({ ...relayOutbox, publishes: [{ queue: "outbox.pickup-failed", queueOptions: { retryLimit: 5 } }] })
    const boss: PgBoss = createBoss({ url, log: (line) => void errors.push(line) })
    running = await startBoss(boss, [changed, republished, ...recordBillableEvents], context(fresh))
    const [queue] = await boss.getQueues([heartbeat.queue])
    assert.equal(queue.retryLimit, 2)
    assert.equal(queue.deleteAfterSeconds, 3_600)
    assert.deepEqual(await boss.getSchedules(heartbeat.queue), [])
    assert.deepEqual(running.published, ["outbox.pickup-failed"])
    const [pickupFailed] = await boss.getQueues(["outbox.pickup-failed"])
    assert.deepEqual([pickupFailed.policy, pickupFailed.retryLimit], ["standard", 5], "the published queue's retry policy rewritten; Resolution's consumer, dropped from this registry, no longer writes its own over it")
    assert.deepEqual(running.queues, [heartbeat.queue, relayOutbox.queue, ...recordBillableEvents.map((job) => job.queue)])
    const [skipped] = await boss.getQueues([outboxQueue("pickup-skipped")])
    assert.equal(skipped?.retryDelay, OPEN_TICKETS_QUEUE_OPTIONS.retryDelay, "a queue the dropped consumer worked is left as it was")
    assert.equal(STOP_TIMEOUT_MS, 10_000)
    await running.stop(2_000)
    assert.deepEqual(errors, [])
  })
})
