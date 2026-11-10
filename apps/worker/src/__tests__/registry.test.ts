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
import { readdirSync, readFileSync } from "node:fs"
import { describe, test } from "node:test"

import { ROUTING_OPTIMISE_QUEUE } from "@waste/db/commands/plans"
import { FINANCE_EVENT_KINDS } from "@waste/domain/finance/from-event"
import { CUSTOMER_NOTICE_KINDS } from "@waste/domain/notifications/notices"
import { NOTIFICATION_EVENTS } from "@waste/domain/notifications/vocabulary"
import { OUTBOX_KINDS, type OutboxKind } from "@waste/domain/outbox/vocabulary"
import { RESOLUTION_EVENT_KINDS } from "@waste/domain/resolution/from-event"
import type { Job } from "pg-boss"

import { isCronExpression } from "../runtime/boss"
import { CONSUMERS, JOBS, relay } from "../jobs"
import { applyPauseGrants } from "../registry/apply-pause-grants"
import { alertRulesJob } from "../resolution/alert-rules"
import { countEmptyings } from "../resolution/count-emptyings"
import { updatableOptions } from "../runtime/definition"
import { heartbeat } from "../runtime/heartbeat"
import { generateRoutes } from "../planning/generate-routes"
import { OPEN_TICKETS_QUEUE_OPTIONS, openTickets } from "../resolution/open-tickets"
import { planAheadJob } from "../planning/plan-ahead"
import { RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS, recordBillableEvents } from "../finance/record-billable-events"
import { BATCH_SIZE, RELAY_INTERVAL_SECONDS } from "../runtime/relay-outbox"
import { purgePositionsJob } from "../execution/purge-positions"
import { noticeCustomers } from "../notifications/customer-notices"
import { notifyStaff } from "../notifications/staff-notifications"
import { purgeProofObjectsJob } from "../execution/purge-proof-objects"
import { sweepHorizonJob } from "../routing/sweep-horizon"
import { runScheduledBilling } from "../finance/run-billing"
import { CONSUMED_OUTBOX_QUEUE_OPTIONS, CONSUMED_RETENTION_SECONDS, consumerQueue, DEAD_LETTER_QUEUE_OPTIONS, defineOutboxConsumer, OUTBOX_DEAD, OUTBOX_DEAD_QUEUE, OUTBOX_QUEUE_OPTIONS, OUTBOX_QUEUES, outboxQueue, payloadOf, relayedEventOf, RelayedJob, routesOf, UNCONSUMED_RETENTION_SECONDS } from "../runtime/outbox"
import { jobContext } from "./context"

const ROUTES = routesOf(CONSUMERS)

/** Resolution's and Finance's queues of their kinds, as the fan-out spells them (#339). */
const resolutionQueues = RESOLUTION_EVENT_KINDS.map((kind) => consumerQueue(kind, "resolution"))
const financeQueues = FINANCE_EVENT_KINDS.map((kind) => consumerQueue(kind, "finance"))
const notificationQueues = NOTIFICATION_EVENTS.map((kind) => consumerQueue(kind, "notifications"))
const customerNoticeQueues = CUSTOMER_NOTICE_KINDS.map((kind) => consumerQueue(kind, "customer-notices"))
/** The Registry's one (M11 of #293): a granted pause, applied. */
const registryQueues = [consumerQueue("application-decided", "registry")]
/** The counting rules' two (#547 of #544): an emptying completed, or corrected to completed. */
const countingQueues = [consumerQueue("pickup-completed", "counting"), consumerQueue("pickup-corrected", "counting")]

describe("the job registry", () => {
  test("names every queue once", () => {
    const queues = JOBS.map((job) => job.queue)
    assert.deepEqual([...new Set(queues)], queues)
    assert.ok(queues.length >= 3, "at least the heartbeat and Planning's two")
  })

  test("is composed outside the runtime, which imports nothing of a context: the relay knows the consumers' queues, never their code", () => {
    const runtime = new URL("../runtime/", import.meta.url)
    for (const file of readdirSync(runtime).filter((name) => name.endsWith(".ts"))) {
      for (const [, specifier] of readFileSync(new URL(file, runtime), "utf8").matchAll(/from "(\.[^"]*)"/g)) {
        assert.ok(specifier.startsWith("./"), `runtime/${file} imports ${specifier}`)
      }
    }
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
    assert.deepEqual(consumers, [...CONSUMERS], "every consumer in the registry is one the relay sends to")
    for (const job of consumers) {
      assert.ok(job.inherits !== undefined && published.has(job.inherits), `${job.queue}: inherits no queue the relay publishes`)
      assert.ok(job.queue.startsWith(`${job.inherits}.`), `${job.queue}: a consumer's queue of a kind is the kind's own and its name`)
      assert.equal(job.schedule, undefined, `${job.queue}: a consumer is sent by the relay and not by a clock`)
      assert.equal(job.publishes, undefined, `${job.queue}: a consumer publishes nothing of its own`)
      assert.equal(job.queueOptions?.deadLetter, OUTBOX_DEAD_QUEUE, `${job.queue}: a consumer's queue dead-letters to outbox.dead, so a poison job is kept for a redrive and not lost with its retention`)
      assert.equal(job.queueOptions?.retentionSeconds, CONSUMED_RETENTION_SECONDS, `${job.queue}: a consumed queue keeps a job a fortnight`)
    }
    assert.deepEqual([...consumed].sort(), [...resolutionQueues, ...financeQueues, ...notificationQueues, ...customerNoticeQueues, ...registryQueues, ...countingQueues].sort(), "the six consumers take Resolution's kinds, Finance's, the staff notices' two, the customer notices' four, the Registry's one and the counting rules' two, and nothing else is consumed")
    assert.ok(!consumed.includes(OUTBOX_DEAD_QUEUE), "nobody works the dead-letter queue: an operator redrives it")
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
    for (const job of openTickets) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS, ...OPEN_TICKETS_QUEUE_OPTIONS })
      assert.equal(job.schedule, undefined, "sent by the relay, never by a clock")
    }
    assert.deepEqual(OPEN_TICKETS_QUEUE_OPTIONS, { retryLimit: 3, retryDelay: 5, retryBackoff: true }, "three retries, backing off from five seconds")
    assert.ok(!openTickets.some((job) => job.inherits === outboxQueue("route-cancelled")), "§7.10: a cancellation makes no ticket of its own")
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
    // Every queue's name, as pg-boss keeps its jobs and schedules under it and the API sends to it; the order is the wiring's and nothing reads it.
    assert.deepEqual(JOBS.map((job) => job.queue).sort(), [
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
      ...customerNoticeQueues,
      ...registryQueues,
      ...countingQueues,
      "finance.run-billing",
      "execution.purge-proof-objects",
      "resolution.alert-rules",
      "execution.purge-positions",
      "messaging.send",
      "messaging.collection-reminders",
      "customers.propose-right-sizing",
    ].sort())
  })

  test("never retries a scheduled run whose next one covers what it missed — the heartbeat, the alert rules, the two purges — nor the horizon sweep, whose retry would re-ask the routes that failed and pay the provider twice", () => {
    for (const job of [heartbeat, alertRulesJob, purgePositionsJob, purgeProofObjectsJob, sweepHorizonJob]) assert.equal(job.queueOptions?.retryLimit, 0, job.queue)
  })

  test("schedules on UTC's clock, catches a missed night or month up once and lets a missed tick go, and runs the nightly jobs in their order: Plan Ahead, then the horizon sweep over what it generated, then the positions' purge, then the proofs'", () => {
    const scheduled = JOBS.filter((job) => job.schedule !== undefined)
    assert.ok(scheduled.length >= 5, "the ticks, the nightly jobs and the monthly run")
    for (const job of scheduled) {
      const [minute, hour] = job.schedule!.split(" ")
      assert.equal(job.scheduleOptions?.tz, "UTC", `${job.queue}: the registry's times are UTC's, so they compare on one clock`)
      // A job due once a day or less often loses a night's or a month's work to a worker that was down unless it runs once on its return; a tick's next occurrence is the catch-up.
      if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) assert.equal(job.scheduleOptions?.missed, "once", `${job.queue}: a missed occurrence runs once when the worker is back`)
      else assert.equal(job.scheduleOptions?.missed, "skip", `${job.queue}: a missed tick is the next tick's to read, never two at once`)
    }
    /** A nightly job's minute of the UTC day. */
    const minuteOfDay = (job: (typeof JOBS)[number]) => {
      const [minute, hour, ...every] = job.schedule!.split(" ")
      assert.deepEqual(every, ["*", "*", "*"], `${job.queue} runs every night`)
      return Number(hour) * 60 + Number(minute)
    }
    const nightly = [planAheadJob, sweepHorizonJob, purgePositionsJob, purgeProofObjectsJob]
    for (const [index, job] of nightly.entries()) {
      if (index > 0) assert.ok(minuteOfDay(job) > minuteOfDay(nightly[index - 1]), `${job.queue} runs after ${nightly[index - 1].queue}`)
    }
  })

  test("holds the relay: every minute as the backstop of its five-second successor, UTC, one tick queued at a time, no retry, publishing the dead-letter queue and then one queue per outbox kind, each kept ninety days for a consumer to come", () => {
    assert.ok(JOBS.includes(relay))
    assert.equal(relay.queue, "execution.relay-outbox")
    assert.equal(relay.schedule, "* * * * *")
    assert.deepEqual(relay.scheduleData, { source: "schedule" })
    assert.deepEqual(relay.scheduleOptions, { tz: "UTC", missed: "skip" })
    assert.deepEqual(relay.queueOptions, { policy: "short", retryLimit: 0, deleteAfterSeconds: 3_600 })
    assert.deepEqual(relay.workOptions, { pollingIntervalSeconds: 1 })
    assert.equal(RELAY_INTERVAL_SECONDS, 5)
    assert.equal(BATCH_SIZE, 100)
    assert.deepEqual(relay.publishes, [OUTBOX_DEAD, ...OUTBOX_QUEUES], "the dead-letter queue first, since a consumer's queue names it and pg-boss refuses a dead letter that does not exist")
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
    // A missed stop's two kinds fan out to Resolution and Finance both (#293 M5b on #339's fan-out).
    for (const kind of ["pickup-failed", "pickup-skipped"] as const) assert.deepEqual(ROUTES.get(kind)?.slice(0, 2), [consumerQueue(kind, "resolution"), consumerQueue(kind, "finance")], kind)
    assert.deepEqual(RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS, { retryLimit: 5, retryDelay: 10, retryBackoff: true, retryDelayMax: 300, deleteAfterSeconds: 604_800 }, "five retries backing off from ten seconds under a five-minute cap: longer than an ordinary failover")
    for (const job of recordBillableEvents) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS, ...RECORD_BILLABLE_EVENTS_QUEUE_OPTIONS })
      assert.equal(job.schedule, undefined)
    }
    assert.ok(JOBS.includes(runScheduledBilling))
    assert.equal(runScheduledBilling.queue, "finance.run-billing")
    assert.equal(runScheduledBilling.schedule, "0 12 1 * *", "noon UTC is the first of the month from UTC−11 to UTC+11 at once; 04:00 was the last of the month before in Chicago")
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
    assert.deepEqual(inherited.sort(), [...new Set([...RESOLUTION_EVENT_KINDS, ...FINANCE_EVENT_KINDS, ...NOTIFICATION_EVENTS, ...CUSTOMER_NOTICE_KINDS, "application-decided" as const])].map(outboxQueue).sort())
    for (const queue of inherited) assert.ok(published.includes(queue), queue)
    assert.ok(published.includes(OUTBOX_DEAD_QUEUE), "the dead-letter queue is published and worked by nobody")
    assert.ok(worked.has(ROUTING_OPTIMISE_QUEUE) && !published.includes(ROUTING_OPTIMISE_QUEUE), "the API sends optimiser Plans (#170) to a queue with a worker of its own (#171), which nobody publishes to hold it open")
    assert.equal(published.length - 1, OUTBOX_KINDS.length, "every kind's own queue, and the dead-letter queue")
  })

  test("holds the Registry's consumer (M11 of #293): one entry on outbox.application-decided.registry that starts fresh, so a decision relayed before it ran is never applied", () => {
    assert.deepEqual(applyPauseGrants.map((job) => [job.queue, job.inherits, job.startsFresh]), [["outbox.application-decided.registry", "outbox.application-decided", true]])
    assert.deepEqual(ROUTES.get("application-decided"), ["outbox.application-decided.registry"], "the relay sends a decision to it from the first start")
    assert.equal(openTickets.some((job) => job.startsFresh === true) || recordBillableEvents.some((job) => job.startsFresh === true), false, "the others take their kinds' backlog")
  })

  test("holds the counting rules' consumer (#547 of #544): one entry each on outbox.pickup-completed.counting and outbox.pickup-corrected.counting, starting fresh, sent each stop after Finance and the customer notices", () => {
    assert.deepEqual(countEmptyings.map((job) => [job.queue, job.inherits, job.startsFresh]), [
      ["outbox.pickup-completed.counting", "outbox.pickup-completed", true],
      ["outbox.pickup-corrected.counting", "outbox.pickup-corrected", true],
    ])
    assert.deepEqual(ROUTES.get("pickup-completed"), ["outbox.pickup-completed.finance", "outbox.pickup-completed.customer-notices", "outbox.pickup-completed.counting"])
  })

  test("holds the staff notices' consumer (O16 of #290): one entry per kind on outbox.<kind>.notifications, never scheduled, on the seam's policy", () => {
    for (const job of notifyStaff) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS })
      assert.equal(job.schedule, undefined)
    }
  })

  test("holds the customer notices' consumer (O16 of #290, part b; C18 of #291): the booking's two kinds, its stop's completion and failure, the ticket's reply and completion, the route's cancel and a rule's alert, fanned out beside the other consumers", () => {
    assert.deepEqual(noticeCustomers.map((job) => job.queue), [
      "outbox.bulky-booking-booked.customer-notices",
      "outbox.bulky-booking-cancelled.customer-notices",
      "outbox.pickup-completed.customer-notices",
      "outbox.pickup-failed.customer-notices",
      "outbox.ticket-replied.customer-notices",
      "outbox.ticket-completed.customer-notices",
      "outbox.route-cancelled.customer-notices",
      "outbox.alert-raised.customer-notices",
    ])
    for (const job of noticeCustomers) {
      assert.ok(JOBS.includes(job), job.queue)
      assert.deepEqual(job.queueOptions, { ...OUTBOX_QUEUE_OPTIONS, ...CONSUMED_OUTBOX_QUEUE_OPTIONS })
    }
    assert.deepEqual(ROUTES.get("pickup-failed"), [consumerQueue("pickup-failed", "resolution"), consumerQueue("pickup-failed", "finance"), consumerQueue("pickup-failed", "customer-notices")])
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

  test("every consumer takes outbox kinds alone, each context's from the list its domain rule declares against the outbox's", () => {
    const kinds = new Set<string>(OUTBOX_KINDS)
    for (const job of CONSUMERS) assert.ok(job.inherits !== undefined && kinds.has(job.inherits.slice("outbox.".length)), `${job.queue} inherits ${job.inherits}, no outbox kind's queue`)
    for (const [context, list] of Object.entries({ RESOLUTION_EVENT_KINDS, FINANCE_EVENT_KINDS, NOTIFICATION_EVENTS, CUSTOMER_NOTICE_KINDS })) {
      for (const kind of list) assert.ok(kinds.has(kind), `${context} names ${kind}, no outbox kind`)
    }
  })

  test("RelayedJob is the contracts' OutboxEvent with the company: it parses a relayed row and refuses one without the company or with a kind the vocabulary lacks; a relayed event is about an aggregate its kind is about, and its payload is read as the kind's resource", () => {
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
    assert.deepEqual(RelayedJob.parse(event), event)
    assert.equal(RelayedJob.safeParse({ ...event, companyId: undefined }).success, false)
    assert.equal(RelayedJob.safeParse({ ...event, kind: "pickup.failed" }).success, false)
    const relayed = relayedEventOf(event)
    assert.deepEqual(relayed, event)
    assert.throws(() => relayedEventOf({ ...event, aggregateKind: "ticket" }), /a pickup-failed event is about a pickup, never a ticket/)
    assert.throws(() => relayedEventOf({ ...event, kind: "pickup-problem-reported", aggregateKind: "route" }), /a pickup-problem-reported event is about a pickup, never a route/, "a problem on the route is its own kind")
    if (relayed.kind !== "pickup-failed") assert.fail("the kind relayed")
    assert.throws(() => payloadOf(relayed), /Invalid|expected/i, "a stop's event carries the whole Pickup, not three of its fields")
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
    const context = jobContext({ log: (line) => void lines.push(line) })
    const event = (kind: OutboxKind, id: string): RelayedJob => ({
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
    const job = (data: RelayedJob): Job<RelayedJob> => ({ id: "j", name: "outbox.pickup-failed", data, expireInSeconds: 1, heartbeatSeconds: null, signal: AbortSignal.abort() })
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
    await assert.rejects(jobs[0].handler([job({ not: "an event" } as unknown as RelayedJob)], context))
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
