// The send the API and the worker share (src/jobs.ts), as `wms_api` on the
// local stack: what migration 0011 granted is enough for a process that runs
// no pg-boss to write a job row in its own transaction — the question Issue
// #168 asks to be answered against a database before the trigger route
// rests on it — and the two questions a sender asks around it, whether the
// queue is there and whether a job is still held. The queue is this file's
// own, made and removed as the owner through pg-boss's functions, so nothing
// here touches the worker's queues.
import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"
import { fromDrizzle, PgBoss } from "pg-boss"

import { createDb, type Database } from "../client"
import { GENERATE_ROUTES_QUEUE } from "../commands/generation"
import { createJobSender, jobHeld, LIVE_JOB_STATES, QueueMissing, sendGenerateRoutes, sendInTransaction, succeedInTransaction, type Complete, type JobSender } from "../jobs"
import { API_ROLE } from "../roles"
import { PGBOSS_SCHEMA } from "../sql/pgboss"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

describe("the shared send, as the API role", { skip: database.skip }, () => {
  let owner: Database
  let api: Database
  let sender: JobSender
  /** An exclusive queue of this file's own, like the generation queue. */
  const queue = `db.specimen-${randomBytes(4).toString("hex")}`

  before(async () => {
    owner = createDb(database.adminUrl, { max: 2 })
    api = createDb(database.appUrl, { max: 2 })
    await owner.sql.unsafe(`select ${PGBOSS_SCHEMA}.create_queue($1, '{"policy": "exclusive"}'::jsonb)`, [queue])
    sender = createJobSender(api)
  })
  after(async () => {
    await owner?.sql.unsafe(`delete from ${PGBOSS_SCHEMA}.job where name = $1`, [queue])
    await owner?.sql.unsafe(`select ${PGBOSS_SCHEMA}.delete_queue($1)`, [queue])
    await api?.close()
    await owner?.close()
  })

  const jobs = async (key: string) =>
    owner.sql<{ id: string; state: string; data: { n: number }; singleton_key: string }[]>`
      select id, state, data, singleton_key from ${owner.sql(PGBOSS_SCHEMA)}.job where name = ${queue} and singleton_key = ${key} order by created_on`

  test("wms_api may insert into pg-boss's schema through a sender that never starts: the row lands, in the caller's transaction, as created", async () => {
    const [{ user }] = await api.sql<{ user: string }[]>`select current_user as user`
    assert.equal(user, API_ROLE, "the sender is built over the API role's pool")
    const key = `one-${randomBytes(3).toString("hex")}`
    const id = await api.db.transaction(async (tx) => {
      const sent = await sendInTransaction(sender.send, tx, queue, { n: 1 }, { singletonKey: key })
      assert.notEqual(sent, null)
      // Inside the transaction the row is visible to it and to nobody else.
      const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${sql.raw(PGBOSS_SCHEMA)}.job where name = ${queue} and singleton_key = ${key}`)
      assert.equal(count, 1)
      assert.equal((await jobs(key)).length, 0, "not committed yet")
      return sent
    })
    const rows = await jobs(key)
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0].id, rows[0].state, rows[0].data, rows[0].singleton_key], [id, "created", { n: 1 }, key])
  })

  test("a second send under the same singleton key answers null while the first is queued, and a rolled-back send leaves no row", async () => {
    const key = `twice-${randomBytes(3).toString("hex")}`
    await api.db.transaction(async (tx) => {
      assert.notEqual(await sendInTransaction(sender.send, tx, queue, { n: 1 }, { singletonKey: key }), null)
      assert.equal(await sendInTransaction(sender.send, tx, queue, { n: 2 }, { singletonKey: key }), null, "exclusive: one job per key while it is queued or active")
    })
    assert.equal((await jobs(key)).length, 1)

    const rolled = `rolled-${randomBytes(3).toString("hex")}`
    await assert.rejects(
      api.db.transaction(async (tx) => {
        assert.notEqual(await sendInTransaction(sender.send, tx, queue, { n: 3 }, { singletonKey: rolled }), null)
        throw new Error("the caller's rows failed: the job goes with them")
      }),
      /the caller's rows failed/,
    )
    assert.equal((await jobs(rolled)).length, 0)
  })

  test("a queue no worker has made is told apart as QueueMissing, from pg-boss's own sentence, so a reword of the library fails here and not as a 500 in the API", async () => {
    const nowhere = `db.nowhere-${randomBytes(3).toString("hex")}`
    await assert.rejects(
      api.db.transaction((tx) => sendInTransaction(sender.send, tx, nowhere, { n: 1 })),
      (error: unknown) => error instanceof QueueMissing && error.queue === nowhere && /worker that makes it has not started/.test(error.message),
    )
  })

  describe("a running job handing its place to its successor (#171: a deferral under the exclusive policy)", () => {
    /** pg-boss's `complete` and `fetch` as the worker's instance has them: an instance over the API role's pool, never started. */
    let boss: PgBoss
    /** A queue of this block's own, so a fetch takes exactly the job the test just sent. */
    const queue = `db.handover-${randomBytes(4).toString("hex")}`
    before(async () => {
      await owner.sql.unsafe(`select ${PGBOSS_SCHEMA}.create_queue($1, '{"policy": "exclusive"}'::jsonb)`, [queue])
      boss = new PgBoss({ db: fromDrizzle(api.db, sql), schema: PGBOSS_SCHEMA, migrate: false, supervise: false, schedule: false, reindex: false, persistQueueStats: false, persistWarnings: false, useListenNotify: false })
    })
    after(async () => {
      await owner?.sql.unsafe(`delete from ${PGBOSS_SCHEMA}.job where name = $1`, [queue])
      await owner?.sql.unsafe(`select ${PGBOSS_SCHEMA}.delete_queue($1)`, [queue])
    })

    // pg-boss keeps its instants as UTC wall time without a zone, so they are compared as epoch seconds.
    const jobs = async (key: string) =>
      owner.sql<{ id: string; state: string; data: { n: number }; start_epoch: number }[]>`
        select id, state, data, extract(epoch from start_after)::float8 as start_epoch from ${owner.sql(PGBOSS_SCHEMA)}.job where name = ${queue} and singleton_key = ${key} order by created_on`

    /** A job of the queue under `key`, sent and fetched, so it is active the way a worker's handler holds it. */
    const running = async (key: string): Promise<string> => {
      const sent = await api.db.transaction((tx) => sendInTransaction(sender.send, tx, queue, { n: 1 }, { singletonKey: key }))
      const [fetched] = await boss.fetch(queue)
      assert.equal(fetched?.id, sent)
      return fetched.id
    }
    const complete: Complete = (name, id, options) => boss.complete(name, id, undefined, options)
    const at = new Date("2026-10-01T03:00:30.000Z")

    test("the running job holds its key, so a plain send is refused; completing it first in the transaction lets the successor in, due at the reset", async () => {
      const key = `defer-${randomBytes(3).toString("hex")}`
      const id = await running(key)
      const successor = await api.db.transaction(async (tx) => {
        assert.equal(await sendInTransaction(sender.send, tx, queue, { n: 2 }, { singletonKey: key }), null, "exclusive: the active job still holds the key")
        return succeedInTransaction(complete, sender.send, tx, { queue, id }, { n: 2 }, { singletonKey: key, startAfter: at })
      })
      assert.ok(successor)
      const rows = await jobs(key)
      assert.deepEqual(
        rows.map((row) => [row.id, row.state, row.data.n]),
        [
          [id, "completed", 1],
          [successor, "created", 2],
        ],
      )
      assert.equal(rows[1].start_epoch, at.getTime() / 1000)
    })

    test("jobHeld by singleton key: a key's job is held while queued and while running, and not once it is done", async () => {
      const key = `held-${randomBytes(3).toString("hex")}`
      const held = async () => {
        const [row] = await api.db.execute<{ held: boolean }>(sql`select ${jobHeld({ queue, singletonKey: key })} as held`)
        return row.held
      }
      assert.equal(await held(), false, "nobody sent one")
      await api.db.transaction((tx) => sendInTransaction(sender.send, tx, queue, { n: 1 }, { singletonKey: key }))
      assert.equal(await held(), true, "queued")
      const [fetched] = await boss.fetch(queue)
      assert.equal(await held(), true, "running")
      await boss.complete(queue, fetched.id)
      assert.equal(await held(), false, "done")
    })

    test("a transaction that fails after the hand-over leaves the job running and no successor: both land or neither", async () => {
      const key = `rollback-${randomBytes(3).toString("hex")}`
      const id = await running(key)
      await assert.rejects(
        api.db.transaction(async (tx) => {
          assert.ok(await succeedInTransaction(complete, sender.send, tx, { queue, id }, { n: 2 }, { singletonKey: key, startAfter: at }))
          throw new Error("the Plan's own write failed")
        }),
        /the Plan's own write failed/,
      )
      assert.deepEqual(
        (await jobs(key)).map((row) => [row.id, row.state]),
        [[id, "active"]],
      )
    })
  })

  test("sendGenerateRoutes spells the generation job once: its queue, its payload and the scheme as the singleton key", async () => {
    const seen: Array<{ name: string; data: object | null; singletonKey: string | undefined; inTransaction: boolean }> = []
    const send = async (name: string, data: object | null, options?: { singletonKey?: string; db?: unknown }) => {
      seen.push({ name, data, singletonKey: options?.singletonKey, inTransaction: options?.db !== undefined })
      return "job-1"
    }
    await api.db.transaction(async (tx) => {
      assert.equal(await sendGenerateRoutes(send, tx, { generationRunId: "run-1", companyId: "company-1", routeSchemeId: "scheme-1" }), "job-1")
    })
    assert.deepEqual(seen, [{ name: GENERATE_ROUTES_QUEUE, data: { generationRunId: "run-1", companyId: "company-1" }, singletonKey: "scheme-1", inTransaction: true }])
  })

  test("jobHeld says whether a generation job is still pg-boss's to run: true for one just sent, false for one that is done and for one nobody sent", async () => {
    // The generation queue itself, made here as the worker's boot makes it when no worker has run on this database, and left to the worker afterwards.
    const [existing] = await owner.sql<{ name: string }[]>`select name from ${owner.sql(PGBOSS_SCHEMA)}.queue where name = ${GENERATE_ROUTES_QUEUE}`
    if (existing === undefined) await owner.sql`select ${owner.sql(PGBOSS_SCHEMA)}.create_queue(${GENERATE_ROUTES_QUEUE}, ${'{"policy": "exclusive"}'}::jsonb)`
    const schemeKey = `scheme-${randomUUID()}`
    const held = async (id: string) => {
      const [{ held }] = await api.db.execute<{ held: boolean }>(sql`select ${jobHeld({ queue: GENERATE_ROUTES_QUEUE, id: sql`${id}` })} as held`)
      return held
    }
    try {
      const id = await api.db.transaction((tx) => sendGenerateRoutes(sender.send, tx, { generationRunId: randomUUID(), companyId: randomUUID(), routeSchemeId: schemeKey }))
      assert.ok(id)
      assert.equal(await held(id), true, "queued: created is a live state")
      assert.equal(await held(randomUUID()), false, "a job nobody sent")
      await owner.sql`update ${owner.sql(PGBOSS_SCHEMA)}.job set state = 'completed' where name = ${GENERATE_ROUTES_QUEUE} and id = ${id}::uuid`
      assert.equal(await held(id), false, "done: no job is coming for its run")
      assert.deepEqual([...LIVE_JOB_STATES], ["created", "retry", "active"])
    } finally {
      await owner.sql`delete from ${owner.sql(PGBOSS_SCHEMA)}.job where name = ${GENERATE_ROUTES_QUEUE} and singleton_key = ${schemeKey}`
      if (existing === undefined) await owner.sql`select ${owner.sql(PGBOSS_SCHEMA)}.delete_queue(${GENERATE_ROUTES_QUEUE})`
    }
  })
})
