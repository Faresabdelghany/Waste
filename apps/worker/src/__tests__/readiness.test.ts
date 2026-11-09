import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { checkBoss, type BossProbe } from "../readiness"

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
