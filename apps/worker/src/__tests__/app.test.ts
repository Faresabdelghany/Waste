import assert from "node:assert/strict"
import { once } from "node:events"
import net from "node:net"
import { after, describe, test } from "node:test"

import { HealthResponse, WorkerReadinessResponse } from "@waste/contracts/health"
import { createDb } from "@waste/db/client"

import { createApp } from "../app"
import { listen } from "../listen"
import type { BossProbe } from "../readiness"
import { probePoolOptions } from "../readiness"
import { databaseUnderTest } from "./database"
import { REFUSED_URL } from "./unreachable"

const database = databaseUnderTest()
const loopback = { host: "127.0.0.1", port: 0 }

/** A pool nothing connects to: these tests bind, ask the probes, and close. */
const idle = createDb(REFUSED_URL, probePoolOptions(300))
after(() => idle.close())

/** A boss whose getQueues answers as told; started unless said otherwise. */
const bossOf = (failed: number[] | Error, started = true): BossProbe => ({
  boss: { getQueues: async () => (failed instanceof Error ? Promise.reject(failed) : (failed.map((failedCount, index) => ({ name: `q.${index}`, failedCount })) as never)) },
  queues: failed instanceof Error ? [] : failed.map((_, index) => `q.${index}`),
  isStarted: () => started,
})

const pinned = new Date("2026-09-25T10:00:00Z")

describe("GET /healthz", () => {
  test("answers 200 with the contracts' HealthResponse and the injected clock, whatever the database and pg-boss are doing", async () => {
    const response = await createApp({ probe: idle, boss: bossOf(new Error("down"), false), now: () => pinned }).request("/healthz")
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(HealthResponse.parse(await response.json()), { status: "ok", time: "2026-09-25T10:00:00.000Z", build: null })
  })
})

describe("GET /readyz", () => {
  test("answers 200 with both checks ok and the failed count summed, when the database answers and pg-boss is started", { skip: database.skip }, async () => {
    const probe = createDb(database.url, probePoolOptions())
    try {
      const response = await createApp({ probe, boss: bossOf([1, 0, 2]) }).request("/readyz")
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("cache-control"), "no-store")
      assert.deepEqual(WorkerReadinessResponse.parse(await response.json()), { status: "ok", checks: { database: "ok", boss: "ok" }, failedJobs: 3 })
    } finally {
      await probe.close()
    }
  })

  test("carries the relay's stale count on a ready body as information, leaves it out when the count did not answer within the bound, and never lets it decide the status", { skip: database.skip }, async () => {
    const probe = createDb(database.url, probePoolOptions())
    try {
      const counted = await createApp({ probe, boss: bossOf([0]), staleOutbox: async () => 4 }).request("/readyz")
      assert.equal(counted.status, 200)
      assert.deepEqual(WorkerReadinessResponse.parse(await counted.json()), { status: "ok", checks: { database: "ok", boss: "ok" }, failedJobs: 0, staleOutbox: 4 })
      const hung = await createApp({ probe, boss: bossOf([0]), checkTimeoutMs: 300, staleOutbox: () => new Promise(() => undefined) }).request("/readyz")
      assert.equal(hung.status, 200, "a count that hangs is not a failed check")
      assert.deepEqual(WorkerReadinessResponse.parse(await hung.json()), { status: "ok", checks: { database: "ok", boss: "ok" }, failedJobs: 0 })
      const failed = await createApp({ probe, boss: bossOf([0]), staleOutbox: () => Promise.reject(new Error("42501")) }).request("/readyz")
      assert.equal(failed.status, 200, "nor is one that throws")
      assert.deepEqual(WorkerReadinessResponse.parse(await failed.json()), { status: "ok", checks: { database: "ok", boss: "ok" }, failedJobs: 0 })
      const down = await createApp({ probe, boss: bossOf([0], false), staleOutbox: async () => 4 }).request("/readyz")
      assert.equal(down.status, 503)
      assert.equal(down.headers.get("cache-control"), "no-store")
      assert.deepEqual(WorkerReadinessResponse.parse(await down.json()), { status: "unavailable", checks: { database: "ok", boss: "stopped" } }, "an unavailable body carries no count")
      // The dead-letter queue's waiting count rides the same way: information beside the failed count, never a status, and left out where the probe names no queue.
      const dead: BossProbe = {
        boss: { getQueues: async () => [{ name: "q.0", failedCount: 1, queuedCount: 7 }, { name: "outbox.dead", failedCount: 0, queuedCount: 2 }] as never },
        queues: ["q.0"],
        isStarted: () => true,
        deadLetterQueue: "outbox.dead",
      }
      const lettered = await createApp({ probe, boss: dead, staleOutbox: async () => 0 }).request("/readyz")
      assert.equal(lettered.status, 200, "dead letters are an operator's number, not a 503")
      assert.deepEqual(WorkerReadinessResponse.parse(await lettered.json()), { status: "ok", checks: { database: "ok", boss: "ok" }, failedJobs: 1, deadLetters: 2, staleOutbox: 0 })
    } finally {
      await probe.close()
    }
  })

  test("answers 503 naming the database unreachable when its dial is refused, the boss check still answering", async () => {
    const response = await createApp({ probe: idle, boss: bossOf([0]), checkTimeoutMs: 500 }).request("/readyz")
    assert.equal(response.status, 503)
    assert.deepEqual(WorkerReadinessResponse.parse(await response.json()), { status: "unavailable", checks: { database: "unreachable", boss: "ok" } })
  })

  test("answers 503 naming pg-boss stopped before it started and after it stopped, and unreachable when its read fails", { skip: database.skip }, async () => {
    const probe = createDb(database.url, probePoolOptions())
    try {
      let started = false
      const boss: BossProbe = { ...bossOf([0]), isStarted: () => started }
      const app = createApp({ probe, boss })
      const before = await app.request("/readyz")
      assert.equal(before.status, 503)
      assert.deepEqual(WorkerReadinessResponse.parse(await before.json()), { status: "unavailable", checks: { database: "ok", boss: "stopped" } })
      started = true
      assert.equal((await app.request("/readyz")).status, 200)
      started = false
      assert.equal((await app.request("/readyz")).status, 503)
      const failing = await createApp({ probe, boss: bossOf(new Error("connection terminated")) }).request("/readyz")
      assert.equal(failing.status, 503)
      assert.deepEqual(WorkerReadinessResponse.parse(await failing.json()), { status: "unavailable", checks: { database: "ok", boss: "unreachable" } })
    } finally {
      await probe.close()
    }
  })

  test("runs the two checks side by side, so a hung database costs one bound and not two", async () => {
    const started = Date.now()
    const response = await createApp({ probe: idle, boss: bossOf(new Error("down")), checkTimeoutMs: 300 }).request("/readyz")
    assert.equal(response.status, 503)
    assert.deepEqual(WorkerReadinessResponse.parse(await response.json()), { status: "unavailable", checks: { database: "unreachable", boss: "unreachable" } })
    assert.ok(Date.now() - started < 1_000)
  })
})

describe("an unknown path", () => {
  test("is a plain 404: the worker takes work from pg-boss, not from HTTP", async () => {
    const app = createApp({ probe: idle, boss: bossOf([0]) })
    assert.equal((await app.request("/jobs")).status, 404)
    assert.equal((await app.request("/openapi.json")).status, 404)
    assert.equal((await app.request("/readyz", { method: "POST" })).status, 404)
  })
})

describe("listen", () => {
  const app = () => createApp({ probe: idle, boss: bossOf([0]) })

  test("serves the probes on the given host and an ephemeral port, and closes on request", async (t) => {
    const listening = await listen(app(), loopback)
    t.after(() => listening.close())
    assert.match(listening.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${listening.url}/healthz`)
    assert.equal(response.status, 200)
    HealthResponse.parse(await response.json())
    await listening.close()
    await assert.rejects(fetch(`${listening.url}/healthz`))
  })

  test("fails instead of hanging when the port is taken, and closes once", async (t) => {
    const first = await listen(app(), loopback)
    t.after(() => first.close())
    const port = Number(new URL(first.url).port)
    await assert.rejects(listen(app(), { host: "127.0.0.1", port }), /EADDRINUSE/)
    const closing = first.close()
    assert.equal(first.close(), closing)
    await closing
  })

  test("close cuts a connection that never finishes its request when the grace period ends", async () => {
    const listening = await listen(app(), { ...loopback, graceMs: 200 })
    const { port } = listening.server.address() as net.AddressInfo
    const stalled = net.connect({ host: "127.0.0.1", port })
    await once(stalled, "connect")
    stalled.write("GET /healthz HTTP/1.1\r\nHost: x\r\n")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    await Promise.all([listening.close(), once(stalled, "close")])
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 150 && elapsed < 2_000, `closed after ${elapsed} ms`)
  })
})
