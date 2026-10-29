// The registry held to what the wiring assumes of it, without a database:
// every queue named once and spelled the way pg-boss accepts a queue name,
// every cron expression one pg-boss's scheduler parses, every scheduled job
// carrying the data its occurrences send, every consumer's queue its own —
// one queue per kind and consumer, inheriting the kind's queue the relay
// publishes (#339) — every job saying what it is for. A job file that breaks
// one of these fails here, where the message names the job, and not at the
// worker's start(). The relay's shape and the outbox queues' spelling are held
// here too, since a consumer takes a kind by that spelling
// (`outbox.<kind>.<consumer>`, `defineOutboxConsumer`).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { ROUTING_OPTIMISE_QUEUE } from "@waste/db/commands/plans"
import { OUTBOX_KINDS, type OutboxKind } from "@waste/domain/execution/vocabulary"
import { NOTIFICATION_EVENTS } from "@waste/domain/notifications/vocabulary"

import { isCronExpression } from "../boss"
import { defineJob, JOBS } from "../jobs"
import { alertRulesJob } from "../jobs/alert-rules"
import { updatableOptions } from "../jobs/definition"
import { generateRoutes } from "../jobs/generate-routes"
import { heartbeat } from "../jobs/heartbeat"
import { OPEN_TICKETS_QUEUE_OPTIONS, openTickets, RESOLUTION_KINDS } from "../jobs/open-tickets"
import { planAheadJob } from "../jobs/plan-ahead"
import { FINANCE_EVENT_KINDS, RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS, recordBillableEvents } from "../jobs/record-billable-events"
import { BATCH_SIZE, RELAY_INTERVAL_SECONDS, relayOutbox } from "../jobs/relay-outbox"
import { OUTBOX_CONSUMERS, OUTBOX_ROUTES, routesOf } from "../outbox/routes"
import { purgePositionsJob } from "../jobs/purge-positions"
import { notifyStaff } from "../jobs/staff-notifications"
import { purgeProofObjectsJob } from "../jobs/purge-proof-objects"
import { sweepHorizonJob } from "../jobs/routing-horizon"
import { runScheduledBilling } from "../jobs/run-billing"
import { CONSUMED_OUTBOX_QUEUE_OPTIONS, CONSUMED_RETENTION_SECONDS, consumerQueue, DEAD_LETTER_QUEUE_OPTIONS, defineOutboxConsumer, OUTBOX_DEAD, OUTBOX_DEAD_QUEUE, OUTBOX_QUEUE_OPTIONS, OUTBOX_QUEUES, outboxQueue, RelayedEvent, UNCONSUMED_RETENTION_SECONDS } from "../outbox/subscribe"

/** Resolution's and Finance's queues of their kinds, as the fan-out spells them (#339). */
const resolutionQueues = RESOLUTION_KINDS.map((kind) => consumerQueue(kind, "resolution"))
const financeQueues = FINANCE_EVENT_KINDS.map((kind) => consumerQueue(kind, "finance"))
const notificationQueues = NOTIFICATION_EVENTS.map((kind) => consumerQueue(kind, "notifications"))

describe("the job registry", () => {
  test("names every queue once", () => {
    const queues = JOBS.map((job) => job.queue)
    assert.deepEqual([...new Set(queues)], queues)
    assert.ok(queues.length >= 3, "at least the heartbeat and Planning's two")
  })

  test("spells every queue <context>.<verb>, or an outbox consumer's outbox.<kind>.<consumer>, in pg-boss's alphabet: letters, digits, underscore, hyphen, period", () => {
    for (const job of JOBS) {
      assert.match(job.queue, job.inherits === undefined ? /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/ : /^outbox\.[a-z][a-z-]*\.[a-z]+(?:-[a-z]+)*$/, job.queue)
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

  test("works one queue per kind and consumer (#339), each inheriting the kind's queue the relay publishes, dead-lettering to outbox.dead, and schedules no consumer", () => {
    const published = new Set(OUTBOX_QUEUES.map((queue) => queue.queue))
    const consumers = JOBS.filter((job) => job.queue.startsWith("outbox."))
    const consumed = consumers.map((job) => job.queue)
    assert.deepEqual([...new Set(consumed)], consumed, "a consumer takes a kind once")
    assert.deepEqual(consumers, [...OUTBOX_CONSUMERS], "every consumer in the registry is one the relay sends to")
    for (const job of consumers) {
      assert.ok(job.inherits !== undefined && published.has(job.inherits), `${job.queue}: inherits no queue the relay publishes`)
      assert.ok(job.queue.startsWith(`${job.inherits}.`), `${job.queue}: a consumer's queue of a kind is the kind's own and its name`)
      assert.equal(job.schedule, undefined, `${job.queue}: a consumer is sent by the relay and not by a clock`)
      assert.equal(job.publishes, undefined, `${job.queue}: a consumer publishes nothing of its own`)
      assert.equal(job.queueOptions?.deadLetter, OUTBOX_DEAD_QUEUE, `${job.queue}: a consumer's queue dead-letters to outbox.dead, so a poison job is kept for a redrive and not lost with its retention`)
      assert.equal(job.queueOptions?.retentionSeconds, CONSUMED_RETENTION_SECONDS, `${job.queue}: a consumed queue keeps a job a fortnight`)
    }
    assert.deepEqual([...consumed].sort(), [...resolutionQueues, ...financeQueues, ...notificationQueues].sort(), "the three consumers take Resolution's kinds, Finance's and the staff notices' two, and nothing else is consumed")
    assert.ok(!consumed.includes(OUTBOX_DEAD_QUEUE), "nobody works the dead-letter queue: an operator redrives it")
    // The relay's routes are the consumers' queues by kind, in the consumers' order.
    for (const kind of OUTBOX_KINDS) {
      const expected = consumers.filter((job) => job.inherits === outboxQueue(kind)).map((job) => job.queue)
      assert.deepEqual(OUTBOX_ROUTES.get(kind) ?? [], expected, kind)
    }
  })

  test("routes a kind two consumers take to both their queues, in the consumers' order, and a kind none takes to none (#339)", () => {
    const of = (name: string, kinds: OutboxKind[]) => defineOutboxConsumer({ name, kinds, description: "Hears.", handler: async () => undefined })
    const routes = routesOf([...of("resolution", ["pickup-failed", "pickup-skipped"]), ...of("notices", ["pickup-failed"])], OUTBOX_KINDS)
    assert.deepEqual(Object.fromEntries(routes), {
      "pickup-failed": ["outbox.pickup-failed.resolution", "outbox.pickup-failed.notices"],
      "pickup-skipped": ["outbox.pickup-skipped.resolution"],
    })
  })

  test("holds Resolution's consumer: one entry per kind Resolution reads on outbox.<kind>.resolution, not route-cancelled, with its retry policy over the seam's", () => {
    assert.deepEqual([...RESOLUTION_KINDS], ["pickup-failed", "pickup-skipped", "pickup-problem-reported", "command-rejected"])
    assert.deepEqual(
      openTickets.map((job) => job.queue),
      ["outbox.pickup-failed.resolution", "outbox.pickup-skipped.resolution", "outbox.pickup-problem-reported.resolution", "outbox.command-rejected.resolution"],
    )
    for (const job of openTickets) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS, ...OPEN_TICKETS_QUEUE_OPTIONS })
      assert.equal(job.schedule, undefined, "sent by the relay, never by a clock")
      assert.match(job.description, /^Opens a Ticket .* \((pickup-failed|pickup-skipped|pickup-problem-reported|command-rejected)\)$/)
    }
    assert.ok(!openTickets.some((job) => job.inherits === outboxQueue("route-cancelled")), "§7.10: a cancellation makes no ticket of its own")
  })

  test("holds the heartbeat: every minute, UTC, no retry, kept a day, sent as the schedule's", () => {
    assert.ok(JOBS.includes(heartbeat))
    assert.equal(heartbeat.queue, "worker.heartbeat")
    assert.equal(heartbeat.schedule, "* * * * *")
    assert.deepEqual(heartbeat.scheduleData, { source: "schedule" })
    assert.deepEqual(heartbeat.scheduleOptions, { tz: "UTC", missed: "skip" })
    assert.deepEqual(heartbeat.queueOptions, { retryLimit: 0, deleteAfterSeconds: 86_400 })
  })

  test("holds Planning's two (#97 part B): generate-routes on an exclusive queue keyed by the scheme with two backed-off retries and an hour to run, and plan-ahead nightly at 03:00 UTC, once for every night missed, sent as the schedule's", () => {
    assert.ok(JOBS.includes(generateRoutes))
    assert.equal(generateRoutes.queue, "planning.generate-routes")
    assert.equal(generateRoutes.schedule, undefined, "sent by the sweep or the API, never scheduled")
    assert.deepEqual(generateRoutes.queueOptions, { policy: "exclusive", retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 3_600 }, "an hour: a full walk over a large project is one transaction, and a job expired mid-run is a spurious retry")
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
      "routing.measure",
      "routing.optimise",
      "routing.sweep-horizon",
      "execution.relay-outbox",
      ...resolutionQueues,
      ...financeQueues,
      ...notificationQueues,
      "finance.run-billing",
      "execution.purge-proof-objects",
      "resolution.alert-rules",
      "execution.purge-positions",
      "messaging.send",
    ])
  })

  test("holds the alert rules (O4 of #290): every five minutes unless the knob says otherwise, a missed tick skipped, sent as the schedule's, no retry — the next tick reads the same", () => {
    assert.ok(JOBS.includes(alertRulesJob))
    assert.equal(alertRulesJob.queue, "resolution.alert-rules")
    assert.equal(alertRulesJob.schedule, "*/5 * * * *")
    assert.deepEqual(alertRulesJob.scheduleData, { source: "schedule" })
    assert.deepEqual(alertRulesJob.scheduleOptions, { tz: "UTC", missed: "skip" })
    assert.deepEqual(alertRulesJob.queueOptions, { retryLimit: 0, deleteAfterSeconds: 86_400 })
  })

  test("holds the proofs' purge (O1 of #290): nightly at 03:45 UTC, after the horizon sweep, once for every night missed, sent as the schedule's, no retry — the next night's window overlaps by a week", () => {
    assert.ok(JOBS.includes(purgeProofObjectsJob))
    assert.equal(purgeProofObjectsJob.queue, "execution.purge-proof-objects")
    assert.equal(purgeProofObjectsJob.schedule, "45 3 * * *")
    assert.deepEqual(purgeProofObjectsJob.scheduleData, { source: "schedule" })
    assert.deepEqual(purgeProofObjectsJob.scheduleOptions, { tz: "UTC", missed: "once" })
    assert.deepEqual(purgeProofObjectsJob.queueOptions, { retryLimit: 0, deleteAfterSeconds: 604_800 })
  })

  test("holds the positions' purge (O8 of #290): nightly at 03:40 UTC, after the horizon sweep and before the proofs', once for every night missed, sent as the schedule's, no retry — the next night sweeps everything past the days", () => {
    assert.ok(JOBS.includes(purgePositionsJob))
    assert.equal(purgePositionsJob.queue, "execution.purge-positions")
    assert.equal(purgePositionsJob.schedule, "40 3 * * *")
    assert.deepEqual(purgePositionsJob.scheduleData, { source: "schedule" })
    assert.deepEqual(purgePositionsJob.scheduleOptions, { tz: "UTC", missed: "once" })
    assert.deepEqual(purgePositionsJob.queueOptions, { retryLimit: 0, deleteAfterSeconds: 604_800 })
  })

  test("holds routing's horizon sweep (#172, #132 §2): nightly at 03:30 UTC, half an hour after Plan Ahead, once for every night missed, sent as the schedule's, no retry — the next night is the retry", () => {
    assert.ok(JOBS.includes(sweepHorizonJob))
    assert.equal(sweepHorizonJob.queue, "routing.sweep-horizon")
    assert.equal(sweepHorizonJob.schedule, "30 3 * * *")
    assert.deepEqual(sweepHorizonJob.scheduleData, { source: "schedule" })
    assert.deepEqual(sweepHorizonJob.scheduleOptions, { tz: "UTC", missed: "once" })
    assert.deepEqual(sweepHorizonJob.queueOptions, { retryLimit: 0, deleteAfterSeconds: 604_800 })
  })

  test("holds the relay: every minute as the backstop of its five-second successor, UTC, one tick queued at a time, no retry, publishing the dead-letter queue and then one queue per outbox kind, each kept ninety days for a consumer to come", () => {
    assert.ok(JOBS.includes(relayOutbox))
    assert.equal(relayOutbox.queue, "execution.relay-outbox")
    assert.equal(relayOutbox.schedule, "* * * * *")
    assert.deepEqual(relayOutbox.scheduleData, { source: "schedule" })
    assert.deepEqual(relayOutbox.scheduleOptions, { tz: "UTC", missed: "skip" })
    assert.deepEqual(relayOutbox.queueOptions, { policy: "short", retryLimit: 0, deleteAfterSeconds: 3_600 })
    assert.deepEqual(relayOutbox.workOptions, { pollingIntervalSeconds: 1 })
    assert.equal(RELAY_INTERVAL_SECONDS, 5)
    assert.equal(BATCH_SIZE, 100)
    assert.deepEqual(relayOutbox.publishes, [OUTBOX_DEAD, ...OUTBOX_QUEUES], "the dead-letter queue first, since a consumer's queue names it and pg-boss refuses a dead letter that does not exist")
    assert.deepEqual(OUTBOX_DEAD, { queue: "outbox.dead", queueOptions: DEAD_LETTER_QUEUE_OPTIONS })
    assert.deepEqual(DEAD_LETTER_QUEUE_OPTIONS, { retryLimit: 0, retentionSeconds: 90 * 86_400 })
    assert.equal(OUTBOX_DEAD_QUEUE, "outbox.dead")
    assert.match(OUTBOX_DEAD_QUEUE, /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/, "spelled like a queue of the registry, and never a kind's (`dead` is no OutboxKind)")
    assert.ok(!(OUTBOX_KINDS as readonly string[]).includes("dead"))
    assert.deepEqual(
      OUTBOX_QUEUES.map((queue) => queue.queue),
      OUTBOX_KINDS.map((kind) => `outbox.${kind}`),
      "one queue per kind of the vocabulary, in its order",
    )
    assert.equal(UNCONSUMED_RETENTION_SECONDS, 90 * 86_400)
    assert.equal(CONSUMED_RETENTION_SECONDS, 14 * 86_400)
    for (const queue of OUTBOX_QUEUES) {
      assert.match(queue.queue, /^outbox\.[a-z][a-z-]*$/, queue.queue)
      assert.deepEqual(queue.queueOptions, { retryLimit: 3, retryDelay: 10, retryBackoff: true, retentionSeconds: UNCONSUMED_RETENTION_SECONDS }, `${queue.queue}: the relay's policy and the ninety days a kind waits for its consumer`)
    }
  })

  test("holds Finance's two: the consumer one entry per kind it reads on outbox.<kind>.finance, never scheduled, with five backed-off retries under a cap over the seam's dead letter; the billing run scheduled monthly at noon UTC", () => {
    assert.deepEqual([...FINANCE_EVENT_KINDS], ["pickup-completed", "pickup-corrected", "pickup-failed", "pickup-skipped", "ticket-completed", "site-visit-recorded", "site-visit-voided"])
    assert.deepEqual(
      recordBillableEvents.map((job) => job.queue),
      ["outbox.pickup-completed.finance", "outbox.pickup-corrected.finance", "outbox.pickup-failed.finance", "outbox.pickup-skipped.finance", "outbox.ticket-completed.finance", "outbox.site-visit-recorded.finance", "outbox.site-visit-voided.finance"],
    )
    // A missed stop's two kinds fan out to Resolution and Finance both (#293 M5b on #339's fan-out).
    for (const kind of ["pickup-failed", "pickup-skipped"] as const) assert.deepEqual(OUTBOX_ROUTES.get(kind), [consumerQueue(kind, "resolution"), consumerQueue(kind, "finance")], kind)
    assert.deepEqual(RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS, { retryLimit: 5, retryDelay: 10, retryBackoff: true, retryDelayMax: 300, deleteAfterSeconds: 604_800 }, "five retries backing off from ten seconds under a five-minute cap: longer than an ordinary failover")
    for (const job of recordBillableEvents) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS, ...RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS })
      assert.equal(job.schedule, undefined)
    }
    assert.ok(JOBS.includes(runScheduledBilling))
    assert.equal(runScheduledBilling.queue, "finance.run-billing")
    assert.equal(runScheduledBilling.schedule, "0 12 1 * *", "noon UTC is the first of the month from UTC−11 to UTC+11 at once; 04:00 was the last of the month before in Chicago")
    assert.ok(!runScheduledBilling.queue.startsWith("outbox."), "sent by the schedule, never by the relay")
  })

  test("publishes each queue once, none of them worked: the outbox kinds' own queues, which hold what no consumer takes and are inherited by the consumers that take a kind (#339), and the dead-letter queue; routing.optimise has its worker (#171)", () => {
    const worked = new Set(JOBS.map((job) => job.queue))
    const published = JOBS.flatMap((job) => (job.publishes ?? []).map((queue) => queue.queue))
    assert.deepEqual([...new Set(published)], published, "each published queue once")
    assert.deepEqual(
      published.filter((queue) => worked.has(queue)),
      [],
      "a consumer works its own queue, never the kind's",
    )
    // What the consumers inherit is the consumed kinds' own queues, each published; the rest wait for a consumer under retention, and the dead-letter queue for an operator.
    const inherited = [...new Set(JOBS.flatMap((job) => (job.inherits === undefined ? [] : [job.inherits])))]
    assert.deepEqual(inherited.sort(), [...new Set([...RESOLUTION_KINDS, ...FINANCE_EVENT_KINDS, ...NOTIFICATION_EVENTS])].map(outboxQueue).sort())
    for (const queue of inherited) assert.ok(published.includes(queue), queue)
    assert.ok(published.includes(OUTBOX_DEAD_QUEUE), "the dead-letter queue is published and worked by nobody")
    assert.ok(worked.has(ROUTING_OPTIMISE_QUEUE) && !published.includes(ROUTING_OPTIMISE_QUEUE), "the API sends optimiser Plans (#170) to a queue with a worker of its own (#171), which nobody publishes to hold it open")
    assert.equal(published.length - 1, OUTBOX_KINDS.length, "every kind's own queue, and the dead-letter queue")
  })

  test("holds the staff notices' consumer (O16 of #290): one entry per kind on outbox.<kind>.notifications, never scheduled, on the seam's policy", () => {
    assert.deepEqual([...NOTIFICATION_EVENTS], ["alert-raised", "ticket-assigned"])
    assert.deepEqual(
      notifyStaff.map((job) => job.queue),
      ["outbox.alert-raised.notifications", "outbox.ticket-assigned.notifications"],
    )
    for (const job of notifyStaff) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS })
      assert.equal(job.schedule, undefined)
    }
  })

  test("updatableOptions drops the policy and nothing else, the dead letter among what it keeps", () => {
    assert.deepEqual(updatableOptions({ policy: "short", retryLimit: 0, deleteAfterSeconds: 3_600 }), { retryLimit: 0, deleteAfterSeconds: 3_600 })
    assert.deepEqual(updatableOptions({ retryLimit: 3 }), { retryLimit: 3 })
    assert.deepEqual(updatableOptions({ policy: "standard" }), {})
    assert.deepEqual(updatableOptions({ retryLimit: 3, deadLetter: "outbox.dead", retentionSeconds: 1 }), { retryLimit: 3, deadLetter: "outbox.dead", retentionSeconds: 1 })
  })
})

describe("the outbox queues and defineOutboxConsumer", () => {
  test("spells the queue of a kind as outbox.<kind>, and a consumer's as outbox.<kind>.<consumer> (#339)", () => {
    assert.equal(outboxQueue("pickup-failed"), "outbox.pickup-failed")
    assert.equal(outboxQueue("ticket-completed"), "outbox.ticket-completed")
    assert.equal(consumerQueue("pickup-failed", "resolution"), "outbox.pickup-failed.resolution")
    assert.equal(consumerQueue("pickup-failed", "finance"), "outbox.pickup-failed.finance")
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

  test("makes one job per kind, on the consumer's queue of the kind inheriting the kind's own, with the description and the options given over the seam's retry, dead letter and retention, and no schedule", async () => {
    const seen: [string, string][] = []
    const jobs = defineOutboxConsumer({
      name: "resolution",
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
      jobs.map((job) => [job.queue, job.inherits, job.description, job.queueOptions, job.workOptions, job.schedule]),
      [
        ["outbox.pickup-failed.resolution", "outbox.pickup-failed", "Opens a ticket. (pickup-failed)", { ...OUTBOX_QUEUE_OPTIONS, retentionSeconds: CONSUMED_RETENTION_SECONDS, deadLetter: OUTBOX_DEAD_QUEUE, retryLimit: 5 }, { pollingIntervalSeconds: 0.5 }, undefined],
        ["outbox.command-rejected.resolution", "outbox.command-rejected", "Opens a ticket. (command-rejected)", { ...OUTBOX_QUEUE_OPTIONS, retentionSeconds: CONSUMED_RETENTION_SECONDS, deadLetter: OUTBOX_DEAD_QUEUE, retryLimit: 5 }, { pollingIntervalSeconds: 0.5 }, undefined],
      ],
    )
    const bare = defineOutboxConsumer({ name: "finance", kinds: ["pickup-completed"], description: "Records.", handler: async () => {} })
    assert.deepEqual(Object.keys(bare[0]).sort(), ["description", "handler", "inherits", "queue", "queueOptions"])
    assert.deepEqual(bare[0].queueOptions, { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS }, "a consumer that names no options still retries, dead-letters and keeps a fortnight: its queue is its own to create")
    // A consumer may say otherwise, and its word stands over the seam's.
    const [own] = defineOutboxConsumer({ name: "finance", kinds: ["pickup-completed"], description: "Records.", queueOptions: { deadLetter: "test.dead", retentionSeconds: 60 }, handler: async () => {} })
    assert.deepEqual(own.queueOptions, { ...OUTBOX_QUEUE_OPTIONS, deadLetter: "test.dead", retentionSeconds: 60 })
    // A name is the context's, as a queue spells it.
    assert.throws(() => defineOutboxConsumer({ name: "Finance", kinds: ["pickup-completed"], description: "Records.", handler: async () => {} }), /lowercase words joined by hyphens/)

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
    await assert.rejects(jobs[0].handler([job(event("command-rejected", first))], context), /outbox\.pickup-failed\.resolution: job j carries a command-rejected event/)
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
