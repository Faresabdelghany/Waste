// The registry held to what the wiring assumes of it, without a database:
// every queue named once and spelled the way pg-boss accepts a queue name,
// every cron expression one pg-boss's scheduler parses, every scheduled job
// carrying the data its occurrences send, every consumer's queue one the
// relay publishes and worked by that consumer alone, every job saying what it
// is for. A job file that breaks one of these fails here, where the message
// names the job, and not at the worker's start(). The relay's shape and the
// outbox queues' spelling are held here too, since a consumer takes a kind by
// that spelling (`outbox.<kind>`, `defineOutboxConsumer`).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OUTBOX_KINDS } from "@waste/domain/execution/vocabulary"

import { isCronExpression } from "../boss"
import { defineJob, JOBS } from "../jobs"
import { updatableOptions } from "../jobs/definition"
import { generateRoutes } from "../jobs/generate-routes"
import { heartbeat } from "../jobs/heartbeat"
import { OPEN_TICKETS_QUEUE_OPTIONS, openTickets, RESOLUTION_KINDS } from "../jobs/open-tickets"
import { planAheadJob } from "../jobs/plan-ahead"
import { FINANCE_EVENT_KINDS, RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS, recordBillableEvents } from "../jobs/record-billable-events"
import { BATCH_SIZE, RELAY_INTERVAL_SECONDS, relayOutbox } from "../jobs/relay-outbox"
import { runScheduledBilling } from "../jobs/run-billing"
import { defineOutboxConsumer, OUTBOX_QUEUES, outboxQueue, RelayedEvent } from "../outbox/subscribe"

describe("the job registry", () => {
  test("names every queue once", () => {
    const queues = JOBS.map((job) => job.queue)
    assert.deepEqual([...new Set(queues)], queues)
    assert.ok(queues.length >= 3, "at least the heartbeat and Planning's two")
  })

  test("spells every queue <context>.<verb>, in pg-boss's alphabet: letters, digits, underscore, hyphen, period", () => {
    for (const job of JOBS) {
      assert.match(job.queue, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, job.queue)
    }
  })

  test("gives every job a description and a handler", () => {
    for (const job of JOBS) {
      assert.ok(job.description.length > 0, job.queue)
      assert.equal(typeof job.handler, "function", job.queue)
    }
  })

  test("schedules on cron expressions pg-boss accepts, each with its data", () => {
    for (const job of JOBS) {
      if (job.schedule === undefined) continue
      assert.ok(isCronExpression(job.schedule), `${job.queue}: "${job.schedule}" is not a cron expression pg-boss accepts`)
      assert.notEqual(job.scheduleData, undefined, `${job.queue}: a scheduled job says what its occurrences carry`)
    }
  })

  test("works every consumer's queue once, each one the relay publishes (`outbox.<kind>`), and schedules no consumer", () => {
    const published = new Set(OUTBOX_QUEUES.map((queue) => queue.queue))
    const consumed = JOBS.map((job) => job.queue).filter((queue) => queue.startsWith("outbox."))
    assert.deepEqual([...new Set(consumed)], consumed, "a kind is taken by one consumer")
    for (const job of JOBS) {
      if (!job.queue.startsWith("outbox.")) continue
      assert.ok(published.has(job.queue), `${job.queue}: not a queue the relay publishes`)
      assert.equal(job.schedule, undefined, `${job.queue}: a consumer is sent by the relay and not by a clock`)
      assert.equal(job.publishes, undefined, `${job.queue}: a consumer publishes nothing of its own`)
    }
    assert.deepEqual(consumed.sort(), [...RESOLUTION_KINDS, ...FINANCE_EVENT_KINDS].map(outboxQueue).sort(), "the two consumers take Resolution's four and Finance's three, and nothing else is consumed")
  })

  test("holds Resolution's consumer: one entry per kind Resolution reads on outbox.<kind>, not route-cancelled, with its retry policy", () => {
    assert.deepEqual([...RESOLUTION_KINDS], ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "command-rejected"])
    assert.deepEqual(
      openTickets.map((job) => job.queue),
      ["outbox.pickup-failed", "outbox.pickup-skipped", "outbox.pickup-problem-reported", "outbox.command-rejected"],
    )
    for (const job of openTickets) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, OPEN_TICKETS_QUEUE_OPTIONS)
      assert.equal(job.schedule, undefined, "sent by the relay, never by a clock")
      assert.match(job.description, /^Opens a Ticket .* \((pickup-failed|pickup-skipped|pickup-problem-reported|command-rejected)\)$/)
    }
    assert.ok(!openTickets.some((job) => job.queue === outboxQueue("route-cancelled")), "§7.10: a cancellation makes no ticket of its own")
  })

  test("holds the heartbeat: every minute, UTC, no retry, kept a day, sent as the schedule's", () => {
    assert.ok(JOBS.includes(heartbeat))
    assert.equal(heartbeat.queue, "worker.heartbeat")
    assert.equal(heartbeat.schedule, "* * * * *")
    assert.deepEqual(heartbeat.scheduleData, { source: "schedule" })
    assert.deepEqual(heartbeat.scheduleOptions, { tz: "UTC", missed: "skip" })
    assert.deepEqual(heartbeat.queueOptions, { retryLimit: 0, deleteAfterSeconds: 86_400 })
  })

  test("holds Planning's two (#97 part B): generate-routes on an exclusive queue keyed by the scheme with two backed-off retries, and plan-ahead nightly at 03:00 UTC, once for every night missed, sent as the schedule's", () => {
    assert.ok(JOBS.includes(generateRoutes))
    assert.equal(generateRoutes.queue, "planning.generate-routes")
    assert.equal(generateRoutes.schedule, undefined, "sent by the sweep or the API, never scheduled")
    assert.deepEqual(generateRoutes.queueOptions, { policy: "exclusive", retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 900 })
    assert.ok(JOBS.includes(planAheadJob))
    assert.equal(planAheadJob.queue, "planning.plan-ahead")
    assert.equal(planAheadJob.schedule, "0 3 * * *")
    assert.deepEqual(planAheadJob.scheduleData, { source: "schedule" })
    assert.deepEqual(planAheadJob.scheduleOptions, { tz: "UTC", missed: "once" })
    assert.deepEqual(planAheadJob.queueOptions, { retryLimit: 1, retryDelay: 60, deleteAfterSeconds: 604_800 })
    assert.deepEqual(JOBS.map((job) => job.queue), [
      "worker.heartbeat",
      "planning.generate-routes",
      "planning.plan-ahead",
      "execution.relay-outbox",
      ...RESOLUTION_KINDS.map(outboxQueue),
      ...FINANCE_EVENT_KINDS.map(outboxQueue),
      "finance.run-billing",
    ])
  })

  test("holds the relay: every minute as the backstop of its five-second successor, UTC, one tick queued at a time, no retry, publishing to one queue per outbox kind", () => {
    assert.ok(JOBS.includes(relayOutbox))
    assert.equal(relayOutbox.queue, "execution.relay-outbox")
    assert.equal(relayOutbox.schedule, "* * * * *")
    assert.deepEqual(relayOutbox.scheduleData, { source: "schedule" })
    assert.deepEqual(relayOutbox.scheduleOptions, { tz: "UTC", missed: "skip" })
    assert.deepEqual(relayOutbox.queueOptions, { policy: "short", retryLimit: 0, deleteAfterSeconds: 3_600 })
    assert.deepEqual(relayOutbox.workOptions, { pollingIntervalSeconds: 1 })
    assert.equal(RELAY_INTERVAL_SECONDS, 5)
    assert.equal(BATCH_SIZE, 100)
    assert.deepEqual(relayOutbox.publishes, OUTBOX_QUEUES)
    assert.deepEqual(
      OUTBOX_QUEUES.map((queue) => queue.queue),
      OUTBOX_KINDS.map((kind) => `outbox.${kind}`),
      "one queue per kind of the vocabulary, in its order",
    )
    for (const queue of OUTBOX_QUEUES) {
      assert.match(queue.queue, /^outbox\.[a-z][a-z-]*$/, queue.queue)
      assert.deepEqual(queue.queueOptions, { retryLimit: 3, retryDelay: 10, retryBackoff: true })
    }
  })

  test("holds Finance's two: the consumer one entry per kind it reads on outbox.<kind>, never scheduled, with its retry policy; the billing run scheduled monthly", () => {
    assert.deepEqual([...FINANCE_EVENT_KINDS], ["pickup-completed", "pickup-corrected", "ticket-completed"])
    assert.deepEqual(
      recordBillableEvents.map((job) => job.queue),
      ["outbox.pickup-completed", "outbox.pickup-corrected", "outbox.ticket-completed"],
    )
    for (const job of recordBillableEvents) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS)
      assert.equal(job.schedule, undefined)
    }
    assert.ok(JOBS.includes(runScheduledBilling))
    assert.equal(runScheduledBilling.queue, "finance.run-billing")
    assert.equal(runScheduledBilling.schedule, "0 4 1 * *")
    assert.ok(!runScheduledBilling.queue.startsWith("outbox."), "sent by the schedule, never by the relay")
  })

  test("publishes each queue once, and the queues a job publishes and nobody works are the outbox kinds no consumer takes", () => {
    const worked = new Set(JOBS.map((job) => job.queue))
    const published = JOBS.flatMap((job) => (job.publishes ?? []).map((queue) => queue.queue))
    assert.deepEqual([...new Set(published)], published, "each published queue once")
    // A consumer's queue is one of the published ones and is worked by that consumer alone; the rest wait for a consumer under retention.
    const consumed = published.filter((queue) => worked.has(queue))
    assert.deepEqual(consumed.sort(), [...RESOLUTION_KINDS, ...FINANCE_EVENT_KINDS].map(outboxQueue).sort())
    const waiting = published.filter((queue) => !worked.has(queue))
    assert.equal(waiting.length, OUTBOX_KINDS.length - RESOLUTION_KINDS.length - FINANCE_EVENT_KINDS.length, "the kinds nobody consumes yet")
  })

  test("updatableOptions drops the policy and nothing else", () => {
    assert.deepEqual(updatableOptions({ policy: "short", retryLimit: 0, deleteAfterSeconds: 3_600 }), { retryLimit: 0, deleteAfterSeconds: 3_600 })
    assert.deepEqual(updatableOptions({ retryLimit: 3 }), { retryLimit: 3 })
    assert.deepEqual(updatableOptions({ policy: "standard" }), {})
  })
})

describe("the outbox queues and defineOutboxConsumer", () => {
  test("spells the queue of a kind as outbox.<kind>", () => {
    assert.equal(outboxQueue("pickup-failed"), "outbox.pickup-failed")
    assert.equal(outboxQueue("ticket-completed"), "outbox.ticket-completed")
  })

  test("RelayedEvent is the contracts' OutboxEvent with the company: it parses a relayed row and refuses one without the company or with a kind the vocabulary lacks", () => {
    const event = {
      id: "01a0d3a5-e5e0-7000-8000-000000000001",
      companyId: "01a0d3a5-e5e0-7000-8000-000000000002",
      projectId: "01a0d3a5-e5e0-7000-8000-000000000003",
      kind: "pickup-failed",
      aggregateKind: "pickup",
      aggregateId: "01a0d3a5-e5e0-7000-8000-000000000004",
      occurredAt: "2026-10-05T06:00:00.000Z",
      payload: { id: "01a0d3a5-e5e0-7000-8000-000000000004", status: "failed", reason: "inaccessible" },
      publishedAt: "2026-10-05T06:00:05.000Z",
      createdAt: "2026-10-05T06:00:00.000Z",
      updatedAt: "2026-10-05T06:00:05.000Z",
    }
    assert.deepEqual(RelayedEvent.parse(event), event)
    assert.equal(RelayedEvent.safeParse({ ...event, companyId: undefined }).success, false)
    assert.equal(RelayedEvent.safeParse({ ...event, kind: "pickup.failed" }).success, false)
  })

  test("makes one job per kind, on the kind's queue, with the description and the options given, and no schedule", async () => {
    const seen: [string, string][] = []
    const jobs = defineOutboxConsumer({
      kinds: ["pickup-failed", "command-rejected"],
      description: "Opens a ticket.",
      queueOptions: { retryLimit: 5 },
      workOptions: { pollingIntervalSeconds: 0.5 },
      handler: async (event, { log }) => {
        seen.push([event.kind, event.id])
        log(event.kind)
      },
    })
    assert.deepEqual(
      jobs.map((job) => [job.queue, job.description, job.queueOptions, job.workOptions, job.schedule]),
      [
        ["outbox.pickup-failed", "Opens a ticket. (pickup-failed)", { retryLimit: 5 }, { pollingIntervalSeconds: 0.5 }, undefined],
        ["outbox.command-rejected", "Opens a ticket. (command-rejected)", { retryLimit: 5 }, { pollingIntervalSeconds: 0.5 }, undefined],
      ],
    )
    const bare = defineOutboxConsumer({ kinds: ["pickup-completed"], description: "Records.", handler: async () => {} })
    assert.deepEqual(Object.keys(bare[0]).sort(), ["description", "handler", "queue"])

    const lines: string[] = []
    const context = { log: (line: string) => void lines.push(line) } as unknown as Parameters<(typeof jobs)[0]["handler"]>[1]
    const event = (kind: string, id: string) => ({
      id,
      companyId: "01a0d3a5-e5e0-7000-8000-000000000002",
      projectId: "01a0d3a5-e5e0-7000-8000-000000000003",
      kind,
      aggregateKind: kind === "command-rejected" ? "command" : "pickup",
      aggregateId: "01a0d3a5-e5e0-7000-8000-000000000004",
      occurredAt: "2026-10-05T06:00:00.000Z",
      payload: {},
      publishedAt: "2026-10-05T06:00:05.000Z",
      createdAt: "2026-10-05T06:00:00.000Z",
      updatedAt: "2026-10-05T06:00:05.000Z",
    })
    const job = (data: object) => ({ id: "j", name: "outbox.pickup-failed", data, expireInSeconds: 1, heartbeatSeconds: null, signal: AbortSignal.abort() }) as Parameters<(typeof jobs)[0]["handler"]>[0][number]
    const first = "01a0d3a5-e5e0-7000-8000-000000000011"
    const second = "01a0d3a5-e5e0-7000-8000-000000000012"
    assert.deepEqual(await jobs[0].handler([job(event("pickup-failed", first)), job(event("pickup-failed", second))], context), { events: [first, second] })
    assert.deepEqual(seen, [
      ["pickup-failed", first],
      ["pickup-failed", second],
    ])
    assert.deepEqual(lines, ["pickup-failed", "pickup-failed"])
    // Another kind's event on this queue, and data that is no event: refused before the handler.
    await assert.rejects(jobs[0].handler([job(event("command-rejected", first))], context), /outbox\.pickup-failed: job j carries a command-rejected event/)
    await assert.rejects(jobs[0].handler([job({ not: "an event" })], context))
    assert.equal(seen.length, 2)
  })
})

describe("isCronExpression", () => {
  test("accepts five-field cron and refuses the rest, without dialling anything", () => {
    for (const expression of ["* * * * *", "0 3 * * *", "*/5 * * * *", "30 2 1 * *", "0 0 * * 1-5"]) {
      assert.ok(isCronExpression(expression), expression)
    }
    for (const expression of ["", "not a cron", "61 * * * *", "* * * *", "0 3 * * * *"]) {
      assert.equal(isCronExpression(expression), false, expression)
    }
  })
})

describe("defineJob", () => {
  test("returns the definition it is given, typed by the handler's data", async () => {
    const lines: string[] = []
    const job = defineJob<{ n: number }>({
      queue: "test.echo",
      description: "Echoes.",
      handler: async (jobs, { log }) => {
        for (const item of jobs) log(`n=${item.data.n}`)
        return jobs.length
      },
    })
    assert.equal(job.queue, "test.echo")
    const context = { log: (line: string) => void lines.push(line) } as unknown as Parameters<typeof job.handler>[1]
    assert.equal(await job.handler([{ id: "1", name: "test.echo", data: { n: 7 }, expireInSeconds: 1, heartbeatSeconds: null, signal: AbortSignal.abort() }], context), 1)
    assert.deepEqual(lines, ["n=7"])
  })
})
