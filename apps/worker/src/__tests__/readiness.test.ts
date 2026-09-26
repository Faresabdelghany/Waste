import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"

import { CHECK_TIMEOUT_MS, checkBoss, checkDatabase, probePoolOptions, type BossProbe } from "../readiness"
import { databaseUnderTest } from "./database"
import { REFUSED_URL, silentServer } from "./unreachable"

const database = databaseUnderTest()

/** A `sql` that hands out the one probe given, so a test can watch what the check does with it. */
const sqlOf = (probe: unknown) => (() => probe) as unknown as Database["sql"]

/** A probe that would blow up if the check ever cancelled it. */
const neverCancelled = { cancel: () => assert.fail("the check must leave a probe it overtook alone; see the header of readiness.ts") }

describe("checkDatabase", () => {
  test("answers ok when the API role's pool answers", { skip: database.skip }, async () => {
    const client = createDb(database.url, probePoolOptions())
    try {
      assert.equal(await checkDatabase(client.sql), "ok")
    } finally {
      await client.close()
    }
  })

  test("answers unreachable at once when the dial is refused", async () => {
    const client = createDb(REFUSED_URL, probePoolOptions())
    try {
      const started = Date.now()
      assert.equal(await checkDatabase(client.sql), "unreachable")
      assert.ok(Date.now() - started < 1_000, "a refused dial must not wait for the bound")
    } finally {
      await client.close()
    }
  })

  test("answers unreachable when the bound passes with the dial still hanging", async () => {
    const server = await silentServer()
    const client = createDb(server.url, { max: 1 })
    try {
      const started = Date.now()
      assert.equal(await checkDatabase(client.sql, { timeoutMs: 200 }), "unreachable")
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 150 && elapsed < 2_000, `answered after ${elapsed} ms`)
    } finally {
      await client.sql.end({ timeout: 0 })
      await server.close()
    }
  })

  test("bounds a probe at two seconds by default, and the probe pool is one connection dialling within the bound", () => {
    assert.equal(CHECK_TIMEOUT_MS, 2_000)
    assert.deepEqual(probePoolOptions(2_000), { max: 1, connectTimeoutSeconds: 2, backoffSeconds: 1 })
    assert.deepEqual(probePoolOptions(), probePoolOptions(CHECK_TIMEOUT_MS))
  })

  test("leaves a probe the bound overtook to settle on its own, never cancelling it, and absorbs its late rejection", async () => {
    let settled = false
    const late = {
      ...neverCancelled,
      then: (_resolve: unknown, reject: (error: unknown) => unknown) =>
        sleep(40).then(() => {
          settled = true
          return reject(new Error("CONNECT_TIMEOUT, long after the bound"))
        }),
    }
    assert.equal(await checkDatabase(sqlOf(late), { timeoutMs: 10 }), "unreachable")
    assert.equal(settled, false)
    await sleep(80)
    assert.equal(settled, true)
  })

  test("answers ok from a probe that settles inside the bound, and unreachable from one that rejects, whatever the reason", async () => {
    const answered = { ...neverCancelled, then: (resolve: (value: unknown) => unknown) => Promise.resolve([{ "?column?": 1 }]).then(resolve) }
    assert.equal(await checkDatabase(sqlOf(answered), { timeoutMs: 20 }), "ok")
    const rejecting = {
      ...neverCancelled,
      then: (_resolve: unknown, reject: (error: unknown) => unknown) => Promise.reject(new Error("terminating connection due to administrator command")).then(undefined, reject),
    }
    assert.equal(await checkDatabase(sqlOf(rejecting)), "unreachable")
  })
})

/** A boss whose getQueues answers as told. */
const bossOf = (getQueues: BossProbe["boss"]["getQueues"], started = true): BossProbe => ({ boss: { getQueues }, queues: ["a.one", "b.two"], isStarted: () => started })

describe("checkBoss", () => {
  test("answers stopped without asking anything while pg-boss is not started", async () => {
    const probe = bossOf(async () => assert.fail("a stopped boss is not asked"), false)
    assert.deepEqual(await checkBoss(probe), { boss: "stopped" })
  })

  test("answers ok with the failed jobs summed over the registered queues, and asks for exactly those queues", async () => {
    let asked: string[] | undefined
    const probe = bossOf(async (names) => {
      asked = names
      return [{ name: "a.one", failedCount: 2 }, { name: "b.two", failedCount: 5 }] as never
    })
    assert.deepEqual(await checkBoss(probe), { boss: "ok", failedJobs: 7 })
    assert.deepEqual(asked, ["a.one", "b.two"])
  })

  test("answers ok with zero when no queue has failed jobs, or none of the queues exist yet", async () => {
    assert.deepEqual(await checkBoss(bossOf(async () => [{ name: "a.one", failedCount: 0 }] as never)), { boss: "ok", failedJobs: 0 })
    assert.deepEqual(await checkBoss(bossOf(async () => [])), { boss: "ok", failedJobs: 0 })
  })

  test("carries the dead-letter queue's waiting count as deadLetters where the probe names one, asked for in the same read and kept out of the failed sum; nothing where the queue is not there yet", async () => {
    let asked: string[] | undefined
    const rows = [
      { name: "a.one", failedCount: 2, queuedCount: 9 },
      { name: "b.two", failedCount: 0, queuedCount: 9 },
      { name: "outbox.dead", failedCount: 4, queuedCount: 3 },
    ] as never[]
    const probe: BossProbe = { ...bossOf(async (names) => ((asked = names), rows)), deadLetterQueue: "outbox.dead" }
    assert.deepEqual(await checkBoss(probe), { boss: "ok", failedJobs: 2, deadLetters: 3 }, "the dead queue's queued jobs, not its failed ones, and not in failedJobs")
    assert.deepEqual(asked, ["a.one", "b.two", "outbox.dead"], "one read for both")
    // Named among the registered queues already (a job that worked it): asked once.
    const listed: BossProbe = { ...probe, queues: ["a.one", "outbox.dead"] }
    assert.deepEqual(await checkBoss(listed), { boss: "ok", failedJobs: 6, deadLetters: 3 })
    assert.deepEqual(asked, ["a.one", "outbox.dead"])
    // Not there yet: no zero it cannot vouch for.
    const missing: BossProbe = { ...bossOf(async () => [{ name: "a.one", failedCount: 1 }] as never), deadLetterQueue: "outbox.dead" }
    assert.deepEqual(await checkBoss(missing), { boss: "ok", failedJobs: 1 })
  })

  test("answers unreachable when the read rejects, and when the bound passes with the read still hanging", async () => {
    assert.deepEqual(await checkBoss(bossOf(async () => Promise.reject(new Error("connection terminated")))), { boss: "unreachable" })
    const started = Date.now()
    assert.deepEqual(await checkBoss(bossOf(() => new Promise(() => {})), { timeoutMs: 50 }), { boss: "unreachable" })
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 40 && elapsed < 1_000, `answered after ${elapsed} ms`)
  })
})
