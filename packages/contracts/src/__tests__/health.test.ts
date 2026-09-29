import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BuildInfo, HealthResponse, ReadinessResponse, ReadyResponse, UnavailableResponse, WorkerReadinessResponse, WorkerReadyResponse, WorkerUnavailableResponse } from "../health"

const COMMIT = "21e7e2c0c8f1b4d9a3e5f6a7b8c9d0e1f2a3b4c5"

describe("HealthResponse", () => {
  test("is the status, the server's clock as an instant with offset, and the build it runs", () => {
    const body = { status: "ok", time: "2026-09-17T13:41:00Z", build: { commit: COMMIT } }
    assert.deepEqual(HealthResponse.parse(body), body)
    assert.deepEqual(HealthResponse.parse({ status: "ok", time: "2026-09-17T15:41:00+02:00", build: null }).time, "2026-09-17T15:41:00+02:00")
  })

  test("knows no other status and no clock without an offset", () => {
    assert.equal(HealthResponse.safeParse({ status: "degraded", time: "2026-09-17T13:41:00Z", build: null }).success, false)
    assert.equal(HealthResponse.safeParse({ status: "ok", time: "2026-09-17T13:41:00", build: null }).success, false)
    assert.equal(HealthResponse.safeParse({ status: "ok", build: null }).success, false)
  })

  test("says the build or says null, and a build is one full commit id (Issue #152)", () => {
    assert.equal(HealthResponse.safeParse({ status: "ok", time: "2026-09-17T13:41:00Z" }).success, false)
    for (const commit of [COMMIT.slice(0, 7), COMMIT.toUpperCase(), `${COMMIT}\n`, "main", "", "a".repeat(64)]) {
      assert.equal(HealthResponse.safeParse({ status: "ok", time: "2026-09-17T13:41:00Z", build: { commit } }).success, false, JSON.stringify(commit))
    }
    assert.deepEqual(BuildInfo.parse({ commit: COMMIT }), { commit: COMMIT })
  })
})

describe("ReadinessResponse", () => {
  test("is ready when the database answers, and says so per check", () => {
    const body = { status: "ok", checks: { database: "ok" } }
    assert.deepEqual(ReadinessResponse.parse(body), body)
    assert.deepEqual(ReadyResponse.parse(body), body)
  })

  test("is unavailable when the database is unreachable", () => {
    const body = { status: "unavailable", checks: { database: "unreachable" } }
    assert.deepEqual(ReadinessResponse.parse(body), body)
    assert.deepEqual(UnavailableResponse.parse(body), body)
  })

  test("ties the status to the checks: ready with an unreachable database is no answer, nor the reverse", () => {
    assert.equal(ReadinessResponse.safeParse({ status: "ok", checks: { database: "unreachable" } }).success, false)
    assert.equal(ReadinessResponse.safeParse({ status: "unavailable", checks: { database: "ok" } }).success, false)
  })

  test("knows no other status, no other check result, and no answer without its checks", () => {
    assert.equal(ReadinessResponse.safeParse({ status: "degraded", checks: { database: "ok" } }).success, false)
    assert.equal(ReadinessResponse.safeParse({ status: "ok", checks: { database: "slow" } }).success, false)
    assert.equal(ReadinessResponse.safeParse({ status: "ok", checks: {} }).success, false)
    assert.equal(ReadinessResponse.safeParse({ status: "ok" }).success, false)
  })
})

describe("WorkerReadinessResponse", () => {
  test("is ready when both checks pass, and carries the count of failed jobs and, where the worker counted them, the dead letters and the stale outbox rows", () => {
    const body = { status: "ok", checks: { database: "ok", boss: "ok" }, failedJobs: 0 }
    assert.deepEqual(WorkerReadinessResponse.parse(body), body)
    assert.deepEqual(WorkerReadyResponse.parse({ ...body, failedJobs: 12 }).failedJobs, 12)
    assert.deepEqual(WorkerReadyResponse.parse({ ...body, staleOutbox: 3 }), { ...body, staleOutbox: 3 })
    assert.deepEqual(WorkerReadyResponse.parse({ ...body, deadLetters: 2 }), { ...body, deadLetters: 2 })
    assert.equal(WorkerReadyResponse.parse(body).staleOutbox, undefined, "a worker with no outbox to relay, or a count that did not answer, carries none")
    assert.equal(WorkerReadyResponse.parse(body).deadLetters, undefined, "a worker with no dead-letter queue, or one not created yet, carries none")
    assert.equal(WorkerReadyResponse.safeParse({ ...body, staleOutbox: -1 }).success, false)
    assert.equal(WorkerReadyResponse.safeParse({ ...body, staleOutbox: 0.5 }).success, false)
    assert.equal(WorkerReadyResponse.safeParse({ ...body, deadLetters: -1 }).success, false)
    assert.equal(WorkerReadyResponse.safeParse({ ...body, deadLetters: 1.5 }).success, false)
  })

  test("is unavailable when a check did not pass, naming which", () => {
    for (const checks of [
      { database: "unreachable", boss: "ok" },
      { database: "ok", boss: "stopped" },
      { database: "ok", boss: "unreachable" },
      { database: "unreachable", boss: "stopped" },
    ]) {
      const body = { status: "unavailable", checks }
      assert.deepEqual(WorkerReadinessResponse.parse(body), body)
      assert.deepEqual(WorkerUnavailableResponse.parse(body), body)
    }
  })

  test("ties the status to the checks: ready with a failed check is no answer, nor unavailable with both passing, nor ready without the count or with a negative or fractional one", () => {
    assert.equal(WorkerReadinessResponse.safeParse({ status: "ok", checks: { database: "unreachable", boss: "ok" }, failedJobs: 0 }).success, false)
    assert.equal(WorkerReadinessResponse.safeParse({ status: "ok", checks: { database: "ok", boss: "stopped" }, failedJobs: 0 }).success, false)
    assert.equal(WorkerReadinessResponse.safeParse({ status: "unavailable", checks: { database: "ok", boss: "ok" } }).success, false)
    assert.equal(WorkerReadinessResponse.safeParse({ status: "ok", checks: { database: "ok", boss: "ok" } }).success, false)
    assert.equal(WorkerReadinessResponse.safeParse({ status: "ok", checks: { database: "ok", boss: "ok" }, failedJobs: -1 }).success, false)
    assert.equal(WorkerReadinessResponse.safeParse({ status: "ok", checks: { database: "ok", boss: "ok" }, failedJobs: 1.5 }).success, false)
  })

  test("knows no other status and no other check result", () => {
    assert.equal(WorkerReadinessResponse.safeParse({ status: "degraded", checks: { database: "ok", boss: "ok" }, failedJobs: 0 }).success, false)
    assert.equal(WorkerReadinessResponse.safeParse({ status: "unavailable", checks: { database: "slow", boss: "ok" } }).success, false)
    assert.equal(WorkerReadinessResponse.safeParse({ status: "unavailable", checks: { database: "ok", boss: "starting" } }).success, false)
    assert.equal(WorkerReadinessResponse.safeParse({ status: "unavailable", checks: { database: "ok" } }).success, false)
  })
})
