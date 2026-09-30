// The relay against Postgres (Issue #104 part C, §6), on a database of this
// file's own with the process's two roles as the process runs them: the sweep
// as `wms_worker`, the stamp and the sends as `wms_api` under `withCompany`.
// What is proved: two companies' events published once each, in id order,
// each on its kind's queue with the contracts' payload and the company; the
// stamp written in the same transaction as the sends, so a send that fails
// leaves the company's rows unstamped and its other sends unwritten, and the
// next tick takes them; a second relay over a published outbox publishing
// nothing; two relays at once, and a row another transaction holds, never
// published twice (`for update skip locked`); the stale count; and the job
// itself through pg-boss — a manual tick worked, its successor queued, a
// second tick refused by the `short` policy — with a consumer defined through
// `defineOutboxConsumer` receiving the event on its kind's queue and refusing
// a job of another kind.
//
// The database is fresh because the sweep crosses companies: a relay on the
// shared local database would stamp every other suite's events out from
// under it. The two application roles reach it with the cluster-wide logins
// bootstrap gave them on the shared stack (database.ts).
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { migrateDatabase } from "@waste/db/migrate"
import { outboxEvent } from "@waste/db/schema/execution"
import { company, project } from "@waste/db/schema/organisation"
import { PGBOSS_SCHEMA } from "@waste/db/sql/pgboss"
import { withCompany } from "@waste/db/tenant"
import type { OutboxKind } from "@waste/contracts/execution"
import { asc } from "drizzle-orm"
import type { PgBoss } from "pg-boss"

import { createBoss, startBoss, type Boss } from "../boss"
import { defineJob, type JobContext } from "../jobs"
import { BATCH_SIZE, OUTBOX_STALE_MS, RELAY_INTERVAL_SECONDS, RELAY_QUEUE, relayOnce, relayOutbox, staleOutboxCount } from "../jobs/relay-outbox"
import { DEAD_LETTER_RETENTION_SECONDS, defineOutboxConsumer, OUTBOX_DEAD_QUEUE, OUTBOX_QUEUE_OPTIONS, OUTBOX_QUEUES, outboxQueue, RelayedEvent } from "../outbox/subscribe"
import { rolesUnderTest, withDatabaseName } from "./database"
import { fakeRouting, settlesNothing } from "./routing-context"
import { until } from "./until"

const roles = rolesUnderTest()

/** A uuidv7-shaped id of this file's own: a nibble for the company, a counter for the row, so id order is the order they are spelled in. */
const id = (n: number, tenant = 0) => `01a0d3a5-e5e0-7000-8000-00000000${tenant.toString(16)}${n.toString(16).padStart(3, "0")}`

type Tenant = { companyId: string; projectId: string }

/** A job row of pg-boss's table, as this file reads it back. */
type JobRow = { id: string; name: string; state: string; data: unknown; start_after: string; output: unknown }

describe("execution.relay-outbox", { skip: roles.skip }, () => {
  const name = `waste_worker_relay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let owner: Database
  let api: Database
  let worker: Database
  let boss: PgBoss
  let running: Boss | undefined
  const lines: string[] = []
  const errors: string[] = []
  /** Every id the context's `send` was asked to enqueue, in order, keyed by the queue. */
  const sent: { queue: string; id: string }[] = []
  let sequence = 0

  const context: JobContext = {
    get api() {
      return api
    },
    get worker() {
      return worker
    },
    now: () => new Date(),
    log: (message) => void lines.push(message),
    complete: settlesNothing,
    routing: fakeRouting(),
    send: (queue, data, options) => {
      if (data && "id" in data && typeof data.id === "string") sent.push({ queue, id: data.id })
      return boss.send(queue, data, options)
    },
  }

  const a: Tenant = { companyId: id(1, 0xa), projectId: id(2, 0xa) }
  const b: Tenant = { companyId: id(1, 0xb), projectId: id(2, 0xb) }

  /** Seeds a company and one project as `wms_api` under the fence, the way the API would. */
  const seedTenant = async (tenant: Tenant, label: string) =>
    withCompany(api.db, tenant.companyId, async (tx) => {
      await tx.insert(company).values({ id: tenant.companyId, companyId: tenant.companyId, name: `Relay ${label}`, legalName: `Relay ${label} A/S`, registrationNumber: `7000000${label === "A" ? 1 : 2}`, country: "DK", status: "active" })
      await tx.insert(project).values({ id: tenant.projectId, companyId: tenant.companyId, name: `Project ${label}`, kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
    })

  /** Writes one event as `emit` would: as `wms_api`, in the tenant's transaction, id minted here so the order is this file's. */
  const emit = async (tenant: Tenant, kind: OutboxKind, payload: unknown, createdAt?: Date) => {
    const eventId = id(++sequence, tenant === a ? 0xa : 0xb)
    await withCompany(api.db, tenant.companyId, (tx) =>
      tx.insert(outboxEvent).values({
        id: eventId,
        companyId: tenant.companyId,
        projectId: tenant.projectId,
        kind,
        aggregateKind: kind.startsWith("pickup") ? "pickup" : kind.startsWith("route") ? "route" : kind.startsWith("unload") ? "unload" : kind.startsWith("ticket") ? "ticket" : "command",
        aggregateId: id(0x100 + sequence),
        occurredAt: new Date("2026-10-05T06:00:00Z"),
        payload,
        ...(createdAt === undefined ? {} : { createdAt }),
      }),
    )
    return eventId
  }

  /** Every row of the outbox, across companies, as the worker role sees it. */
  const outbox = () => worker.db.select({ id: outboxEvent.id, companyId: outboxEvent.companyId, kind: outboxEvent.kind, publishedAt: outboxEvent.publishedAt, updatedAt: outboxEvent.updatedAt }).from(outboxEvent).orderBy(asc(outboxEvent.id))

  /** The jobs on the `outbox.<kind>` queues, oldest first. */
  const outboxJobs = async (): Promise<JobRow[]> => owner.sql.unsafe<JobRow[]>(`select id, name, state, data, start_after::text, output from ${PGBOSS_SCHEMA}.job where name like 'outbox.%' order by created_on, id`)

  /** The jobs on the relay's own queue, oldest first. */
  const relayJobs = async (): Promise<JobRow[]> => owner.sql.unsafe<JobRow[]>(`select id, name, state, data, start_after::text, output from ${PGBOSS_SCHEMA}.job where name = '${RELAY_QUEUE}' order by created_on, id`)

  /** The consumer of this file: takes `pickup-failed`, records what it got, and fails at once on a wrong kind so the refusal shows within the test. */
  const received: RelayedEvent<"pickup-failed">[] = []
  const testConsumer = defineOutboxConsumer({
    kinds: ["pickup-failed"],
    description: "Records the failed pickups this suite relays.",
    queueOptions: { retryLimit: 0 },
    workOptions: { pollingIntervalSeconds: 0.5 },
    handler: async (event) => {
      received.push(event)
    },
  })

  before(async () => {
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    owner = createDb(withDatabaseName(roles.adminUrl, name), { max: 2 })
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 4 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    boss = createBoss({ url: withDatabaseName(roles.workerUrl, name), log: (line) => void errors.push(line), monitorIntervalSeconds: 1 })
    // The relay without its schedule, so a tick runs only when this file sends one, and the consumer beside it: the wiring creates the outbox queues before either worker starts.
    running = await startBoss(boss, [defineJob({ ...relayOutbox, schedule: undefined }), ...testConsumer], context)
    await seedTenant(a, "A")
    await seedTenant(b, "B")
  })
  after(async () => {
    await running?.stop(2_000)
    await Promise.allSettled([api?.close(), worker?.close(), owner?.close()])
    try {
      await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin.close()
    }
  })

  test("the wiring created the dead-letter queue and every outbox.<kind> queue with the relay's retry policy, before any consumer registered", async () => {
    assert.deepEqual(running!.published, [OUTBOX_DEAD_QUEUE, ...OUTBOX_QUEUES.map((queue) => queue.queue)])
    assert.deepEqual(running!.queues, [RELAY_QUEUE, "outbox.pickup-failed"])
    const queues = await boss.getQueues([...running!.published])
    assert.equal(queues.length, OUTBOX_QUEUES.length + 1)
    for (const queue of queues) {
      if (queue.name === OUTBOX_DEAD_QUEUE) {
        assert.deepEqual([queue.retryLimit, queue.retentionSeconds, queue.deadLetter], [0, DEAD_LETTER_RETENTION_SECONDS, null], "the dead-letter queue: no retry, ninety days, worked by nobody")
        continue
      }
      const expected = queue.name === "outbox.pickup-failed" ? [10, 0, OUTBOX_DEAD_QUEUE] : [10, 3, null]
      assert.deepEqual([queue.retryDelay, queue.retryLimit, queue.deadLetter], expected, `${queue.name}: the relay's policy, the consumer's retryLimit and the seam's dead letter written over it on its own queue`)
    }
  })

  test("publishes two companies' events exactly once, in id order per company, each on its kind's queue carrying the stamped event and the company, and stamps them as wms_api in the same instant", async () => {
    const a1 = await emit(a, "pickup-failed", { id: id(0x201), status: "failed", reason: "inaccessible" })
    const b1 = await emit(b, "pickup-completed", { id: id(0x202), status: "completed" })
    const a2 = await emit(a, "route-cancelled", { id: id(0x203), status: "cancelled" })
    const a3 = await emit(a, "command-rejected", { id: id(0x204), outcome: "rejected", problem: { detail: "Route RC-1042 is completed" } })
    const b2 = await emit(b, "unload-recorded", { id: id(0x205), netKg: 1200 })
    sent.length = 0

    const outcome = await relayOnce(context)
    assert.deepEqual(outcome, { swept: 5, published: 5 })
    // A's rows first (the lowest id is A's), in id order; then B's, in id order: the sweep's order is the id's, and each company's transaction keeps it.
    assert.deepEqual(
      sent,
      [
        { queue: "outbox.pickup-failed", id: a1 },
        { queue: "outbox.route-cancelled", id: a2 },
        { queue: "outbox.command-rejected", id: a3 },
        { queue: "outbox.pickup-completed", id: b1 },
        { queue: "outbox.unload-recorded", id: b2 },
      ],
      "each event sent to outbox.<kind>, in id order within its company",
    )

    const rows = await outbox()
    assert.equal(rows.length, 5)
    for (const row of rows) {
      assert.ok(row.publishedAt !== null, `${row.id} stamped`)
      assert.equal(row.updatedAt.toISOString(), row.publishedAt.toISOString(), "the touch trigger's instant is the stamp's: one transaction, one now()")
    }
    const stampsA = new Set(rows.filter((row) => row.companyId === a.companyId).map((row) => row.publishedAt!.toISOString()))
    assert.equal(stampsA.size, 1, "one company's batch is one transaction, one instant")

    const jobs = await outboxJobs()
    assert.equal(jobs.length, 5)
    for (const job of jobs) {
      const event = RelayedEvent.parse(job.data)
      const row = rows.find((candidate) => candidate.id === event.id)!
      assert.equal(job.name, outboxQueue(event.kind), "the queue is the kind's")
      assert.equal(event.companyId, row.companyId, "the company travels with the event")
      assert.equal(event.publishedAt, row.publishedAt!.toISOString(), "the payload's stamp is the row's")
      assert.equal(event.updatedAt, row.updatedAt.toISOString())
      assert.equal(event.occurredAt, "2026-10-05T06:00:00.000Z")
    }
    const failed = jobs.find((job) => job.name === "outbox.pickup-failed")!
    assert.deepEqual(RelayedEvent.parse(failed.data).payload, { id: id(0x201), status: "failed", reason: "inaccessible" }, "the payload is the wire resource as the write left it")
    assert.deepEqual(errors, [])
  })

  test("a second relay over a published outbox publishes nothing", async () => {
    sent.length = 0
    assert.deepEqual(await relayOnce(context), { swept: 0, published: 0 })
    assert.deepEqual(sent, [])
    assert.equal((await outboxJobs()).length, 5)
  })

  test("a send that fails leaves the company's rows unstamped and its other sends unwritten — one transaction — while the other company's rows are published, and the next tick takes them", async () => {
    const a4 = await emit(a, "pickup-skipped", { id: id(0x206), status: "skipped", reason: "route-ended" })
    const b3 = await emit(b, "pickup-corrected", { id: id(0x207), status: "completed" })
    const b4 = await emit(b, "route-dispatched", { id: id(0x208), status: "ready" })
    // A queue the relay cannot send to: pg-boss refuses a send on a queue that does not exist, which is what a broken consumer queue looks like to the relay.
    await boss.deleteQueue(outboxQueue("route-dispatched"))
    sent.length = 0
    lines.length = 0

    await assert.rejects(relayOnce(context), (error: Error) => {
      assert.equal(error.message, "execution.relay-outbox: 1 of 2 companies failed to publish; 1 row published")
      assert.ok(Array.isArray(error.cause) && error.cause.length === 1)
      assert.match((error.cause as Error[])[0].message, /Queue outbox\.route-dispatched does not exist/)
      return true
    })
    assert.equal(lines.length, 1)
    assert.match(lines[0], new RegExp(`^execution\\.relay-outbox: company ${b.companyId}: 2 rows left unpublished: Queue outbox\\.route-dispatched does not exist`))

    const rows = await outbox()
    const byId = new Map(rows.map((row) => [row.id, row]))
    assert.ok(byId.get(a4)!.publishedAt !== null, "A's row, its own transaction, is published")
    assert.equal(byId.get(b3)!.publishedAt, null, "B's first row is not stamped, though its send came before the failing one")
    assert.equal(byId.get(b4)!.publishedAt, null)
    const jobs = await outboxJobs()
    assert.equal(jobs.length, 6, "A's one job; none of B's two, the send of b3 rolled back with the stamp")
    assert.ok(!jobs.some((job) => RelayedEvent.parse(job.data).id === b3), "b3's send did not survive its transaction")

    // The queue back, the way a consumer's next start would bring it: the next tick takes exactly B's two rows, in order.
    await boss.createQueue(outboxQueue("route-dispatched"), { retryLimit: 3, retryDelay: 10, retryBackoff: true })
    sent.length = 0
    assert.deepEqual(await relayOnce(context), { swept: 2, published: 2 })
    assert.deepEqual(
      sent.map((entry) => entry.id),
      [b3, b4],
    )
    assert.equal((await outboxJobs()).length, 8)
    assert.ok((await outbox()).every((row) => row.publishedAt !== null))
  })

  test("one company's backlog of rows nobody can publish does not starve another's: the sweep caps each company at BATCH_SIZE, so B's one row goes the same tick as A's hundred fail, and A drains a hundred a tick once its queue is back", async () => {
    // A: a hundred and fifty rows of a kind whose queue is gone — a consumer queue broken, or a kind this worker does not know yet, mid-deploy — so every tick's transaction for A fails and its rows stay unpublished, older than anything B will ever write.
    await boss.deleteQueue(outboxQueue("ticket-rejected"))
    const poisoned: string[] = []
    for (let n = 0; n < 150; n += 1) {
      poisoned.push(await emit(a, "ticket-rejected", { id: id(0x300 + n), status: "rejected", n }))
    }
    // B: one row, younger than all of A's. Under a cap across companies (`order by id limit 100`) the hundred oldest rows are all A's and B's is never swept; under a cap per company it is.
    const b6 = await emit(b, "pickup-completed", { id: id(0x3a0), status: "completed" })
    sent.length = 0
    lines.length = 0

    await assert.rejects(relayOnce(context), (error: Error) => {
      assert.equal(error.message, "execution.relay-outbox: 1 of 2 companies failed to publish; 1 row published", "A's transaction failed, B's went, in the one tick")
      return true
    })
    // The context's `send` records the attempt before pg-boss refuses it, so A's first row shows there and nowhere else: the jobs table is the word.
    assert.ok(sent.some((entry) => entry.id === b6), "B's row was sent though A holds a hundred and fifty older ones")
    assert.equal(lines.length, 1)
    assert.match(lines[0], new RegExp(`^execution\\.relay-outbox: company ${a.companyId}: ${BATCH_SIZE} rows left unpublished: Queue outbox\\.ticket-rejected does not exist`), "A's part of the tick was its cap, not its whole backlog")
    const rows = new Map((await outbox()).map((row) => [row.id, row]))
    assert.ok(rows.get(b6)!.publishedAt !== null, "B's row is stamped")
    assert.ok(poisoned.every((eventId) => rows.get(eventId)!.publishedAt === null), "none of A's is")
    const jobs = await outboxJobs()
    assert.ok(jobs.some((job) => RelayedEvent.parse(job.data).id === b6), "B's job is on its queue")
    assert.ok(!jobs.some((job) => job.name === outboxQueue("ticket-rejected")), "none of A's survived its transaction")

    // The same again: A still fails, B has nothing, and the tick throws with nothing published — the stale count climbs for A alone.
    await assert.rejects(relayOnce(context), /1 of 1 company failed to publish; 0 rows published/)

    // A's queue back (a consumer's next start, or the deploy that knows the kind): the first tick takes A's oldest hundred in id order, the second the other fifty, and a job that swept a batch's worth would follow itself at once.
    await boss.createQueue(outboxQueue("ticket-rejected"), OUTBOX_QUEUE_OPTIONS)
    sent.length = 0
    assert.deepEqual(await relayOnce(context), { swept: BATCH_SIZE, published: BATCH_SIZE })
    assert.deepEqual(sent.map((entry) => entry.id), poisoned.slice(0, BATCH_SIZE), "the oldest hundred, in id order")
    sent.length = 0
    assert.deepEqual(await relayOnce(context), { swept: 50, published: 50 })
    assert.deepEqual(sent.map((entry) => entry.id), poisoned.slice(BATCH_SIZE))
    assert.ok((await outbox()).every((row) => row.publishedAt !== null))
    assert.equal((await outboxJobs()).filter((job) => job.name === outboxQueue("ticket-rejected")).length, 150, "one job per row, none twice")
  })

  test("a row another transaction holds is skipped, not waited for, and published by the tick after it is released (for update skip locked)", async () => {
    const a5 = await emit(a, "pickup-failed", { id: id(0x209), status: "failed", reason: "contamination" })
    const a6 = await emit(a, "pickup-problem-reported", { id: id(0x20a) })
    const b5 = await emit(b, "ticket-completed", { id: id(0x20b), status: "completed" })
    sent.length = 0
    await owner.sql.begin(async (holding) => {
      await holding`select id from wms.outbox_event where id = ${a6} for update`
      assert.deepEqual(await relayOnce(context), { swept: 3, published: 2 }, "the held row is left, the other two go")
      assert.deepEqual(sent.map((entry) => entry.id), [a5, b5])
    })
    const rows = new Map((await outbox()).map((row) => [row.id, row]))
    assert.equal(rows.get(a6)!.publishedAt, null)
    assert.ok(rows.get(a5)!.publishedAt !== null && rows.get(b5)!.publishedAt !== null)
    sent.length = 0
    assert.deepEqual(await relayOnce(context), { swept: 1, published: 1 })
    assert.deepEqual(sent.map((entry) => entry.id), [a6])
  })

  test("two relays at once publish every row exactly once between them", async () => {
    const ids: string[] = []
    for (let n = 0; n < 6; n += 1) {
      ids.push(await emit(n % 2 === 0 ? a : b, "pickup-completed", { id: id(0x210 + n), status: "completed", n }))
    }
    sent.length = 0
    const before = (await outboxJobs()).length
    const [first, second] = await Promise.all([relayOnce(context), relayOnce(context)])
    assert.equal(first.published + second.published, 6, `${first.published} + ${second.published}`)
    // Both swept before either committed, or one committed a company first and the other's sweep saw the rest: either way what one locked the other skipped, and nothing was taken twice.
    assert.equal(Math.max(first.swept, second.swept), 6, "at least one sweep saw all six")
    assert.ok(first.swept <= 6 && second.swept <= 6)
    const jobs = await outboxJobs()
    assert.equal(jobs.length, before + 6, "six new jobs, not twelve")
    const published = jobs.slice(before).map((job) => RelayedEvent.parse(job.data).id).sort()
    assert.deepEqual(published, [...ids].sort(), "each event once")
    assert.deepEqual(sent.map((entry) => entry.id).sort(), [...ids].sort())
    assert.ok((await outbox()).every((row) => row.publishedAt !== null))
  })

  test("counts the rows unpublished for longer than OUTBOX_STALE_MS, across companies, and nothing once they are published", async () => {
    const now = new Date()
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1_000)
    assert.equal(OUTBOX_STALE_MS, 60 * 60 * 1_000)
    assert.equal(await staleOutboxCount(worker, now), 0)
    const stale = await emit(a, "route-started", { id: id(0x220) }, twoHoursAgo)
    await emit(b, "route-completed", { id: id(0x221) })
    assert.equal(await staleOutboxCount(worker, now), 1, "the two-hour-old row and not the fresh one")
    assert.equal(await staleOutboxCount(worker, new Date(twoHoursAgo.getTime() + 30 * 60 * 1_000)), 0, "half an hour after it was made, it is not yet stale")
    assert.equal(await staleOutboxCount(worker, now, 90 * 60 * 1_000), 1)
    assert.equal(await staleOutboxCount(worker, now, 3 * 60 * 60 * 1_000), 0)
    await relayOnce(context)
    assert.equal(await staleOutboxCount(worker, now), 0, "published, however old")
    assert.ok((await outbox()).find((row) => row.id === stale)!.publishedAt !== null)
  })

  test("the kind's queue is the one door: a queue subscribed to outbox.<kind> through pg-boss's fan-out receives nothing, since the relay sends and does not publish", async () => {
    const subscribed = "test.subscribed"
    await boss.createQueue(subscribed)
    await boss.subscribe(outboxQueue("route-reassigned"), subscribed)
    const a8 = await emit(a, "route-reassigned", { id: id(0x240), status: "planned" })
    sent.length = 0
    assert.deepEqual(await relayOnce(context), { swept: 1, published: 1 })
    assert.deepEqual(sent.map((entry) => [entry.queue, entry.id]), [["outbox.route-reassigned", a8]], "the kind's own queue, through send")
    assert.deepEqual(await boss.findJobs(subscribed, {}), [], "no copy on the subscribed queue: one door, so a consumer that also subscribed would not hear an event twice")
    const own = (await outboxJobs()).filter((job) => job.name === "outbox.route-reassigned")
    assert.equal(own.length, 1, "the kind's queue has the one job")
    assert.equal(RelayedEvent.parse(own[0].data).id, a8)
    await boss.unsubscribe(outboxQueue("route-reassigned"), subscribed)
    await boss.deleteQueue(subscribed)
  })

  test("a tick sent to the queue is worked by the job: the events published, the consumer given its kind's events and no other, a successor queued five seconds on, a second tick refused by the short policy", async () => {
    const a7 = await emit(a, "pickup-failed", { id: id(0x230), status: "failed", reason: "safety" })
    await emit(b, "invoice-issued", { id: id(0x231), number: 1000 })
    lines.length = 0
    const tick = await context.send(RELAY_QUEUE, { source: "manual" })
    assert.ok(tick, "the queue had room for a tick")
    await until(async () => (await relayJobs()).some((job) => job.id === tick && job.state === "completed"), 15_000, "the tick completing")
    const jobs = await relayJobs()
    const done = jobs.find((job) => job.id === tick)!
    assert.deepEqual(done.output, { swept: 2, published: 2 })
    assert.deepEqual(lines, ["execution.relay-outbox: 2 events published (manual)"])
    const successor = jobs.find((job) => job.id !== tick)
    assert.ok(successor, "the tick queued its successor")
    assert.deepEqual(successor.data, { source: "successor" })
    assert.equal(successor.state, "created")
    const wait = (new Date(successor.start_after).getTime() - Date.now()) / 1_000
    assert.ok(wait > 0 && wait <= RELAY_INTERVAL_SECONDS, `due in ${wait.toFixed(1)} s, within the interval`)
    // `short`: one queued tick at a time, so a schedule's occurrence landing beside a successor is dropped, not doubled.
    assert.equal(await context.send(RELAY_QUEUE, { source: "manual" }), null, "a second tick while one is queued is refused")

    // The consumer has been working its queue since the start: every `pickup-failed` this file relayed, one job at a time, and nothing of another kind.
    const failedPickups = (await outbox()).filter((row) => row.kind === "pickup-failed").map((row) => row.id)
    assert.equal(failedPickups.length, 3)
    await until(() => received.length === failedPickups.length, 10_000, "the consumer receiving every failed pickup")
    assert.deepEqual(received.map((event) => event.id).sort(), [...failedPickups].sort())
    assert.ok(received.every((event) => event.kind === "pickup-failed"))
    const event = received.find((candidate) => candidate.id === a7)!
    assert.equal(event.companyId, a.companyId)
    assert.equal(event.projectId, a.projectId)
    assert.equal(event.aggregateKind, "pickup")
    assert.deepEqual(event.payload, { id: id(0x230), status: "failed", reason: "safety" })
    assert.equal(event.occurredAt, "2026-10-05T06:00:00.000Z")
    assert.equal(typeof event.publishedAt, "string")
    const [consumed] = await owner.sql.unsafe<JobRow[]>(`select id, name, state, data, start_after::text, output from ${PGBOSS_SCHEMA}.job where name = 'outbox.pickup-failed' and state = 'completed' and data->>'id' = '${a7}'`)
    assert.ok(consumed, "the consumer's job completed")
    assert.deepEqual(consumed.output, { events: [a7] })
  })

  test("a consumer refuses a job of another kind on its queue, and one whose data is not a relayed event: the job fails, for the readiness count, and the handler is not reached", async () => {
    const handled = received.length
    const stray = RelayedEvent.parse((await outboxJobs()).find((job) => job.name === "outbox.pickup-completed")!.data)
    const wrong = await boss.send("outbox.pickup-failed", stray)
    const garbage = await boss.send("outbox.pickup-failed", { not: "an event" })
    assert.ok(wrong && garbage)
    await until(async () => {
      const rows = await boss.findJobs("outbox.pickup-failed", {})
      return rows.filter((job) => (job.id === wrong || job.id === garbage) && job.state === "failed").length === 2
    }, 10_000, "both jobs failing")
    const [failed] = await boss.findJobs("outbox.pickup-failed", { id: wrong })
    assert.match(JSON.stringify(failed.output), /carries a pickup-completed event/)
    const [refused] = await boss.findJobs("outbox.pickup-failed", { id: garbage })
    assert.match(JSON.stringify(refused.output), /Invalid input|expected/i)
    assert.equal(received.length, handled, "the handler was not reached")
    // The successor tick of the test above may still be queued; stop the workers before the database goes.
    await running!.stop(2_000)
    running = undefined
    assert.deepEqual(errors, [])
  })

  test("the constants the tick runs on", () => {
    assert.equal(BATCH_SIZE, 100)
    assert.equal(RELAY_INTERVAL_SECONDS, 5)
    assert.equal(RELAY_QUEUE, relayOutbox.queue)
    assert.deepEqual(relayOutbox.publishes, [{ queue: OUTBOX_DEAD_QUEUE, queueOptions: { retryLimit: 0, retentionSeconds: DEAD_LETTER_RETENTION_SECONDS } }, ...OUTBOX_QUEUES])
  })

  test("every outbox row is one of the two companies', and every one was published exactly once; the two jobs the consumer refused are dead letters, data intact", async () => {
    const rows = await outbox()
    assert.ok(rows.length >= 20)
    assert.deepEqual([...new Set(rows.map((row) => row.companyId))].sort(), [a.companyId, b.companyId].sort())
    const publishedIds = await owner.sql.unsafe<{ id: string }[]>(`select data->>'id' as id from ${PGBOSS_SCHEMA}.job where name like 'outbox.%' and name <> '${OUTBOX_DEAD_QUEUE}' and data->>'companyId' is not null`)
    const ids = publishedIds.map((row) => row.id).filter((candidate) => rows.some((row) => row.id === candidate))
    assert.equal(ids.length, rows.length + 1, "one job per row, plus the stray job the consumer test sent by hand")
    assert.equal(new Set(ids).size, rows.length, "every outbox row published once, none twice")
    // The consumer refused two jobs with no retry (a stray kind, and no event at all): both failed, and both are on the dead-letter queue with what they carried and where they came from, for an operator to read and redrive or delete.
    const dead = await owner.sql.unsafe<{ state: string; source_name: string; data: unknown }[]>(`select state, source_name, data from ${PGBOSS_SCHEMA}.job where name = '${OUTBOX_DEAD_QUEUE}' order by created_on`)
    assert.equal(dead.length, 2)
    assert.ok(dead.every((letter) => letter.state === "created" && letter.source_name === "outbox.pickup-failed"))
    assert.ok(dead.some((letter) => RelayedEvent.safeParse(letter.data).success && RelayedEvent.parse(letter.data).kind === "pickup-completed"), "the stray event, intact")
    assert.ok(dead.some((letter) => JSON.stringify(letter.data) === JSON.stringify({ not: "an event" })), "the garbage, as sent")
  })
})
