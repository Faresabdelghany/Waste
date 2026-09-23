import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { HealthResponse, ReadinessResponse, ReadyResponse, UnavailableResponse } from "../health"

describe("HealthResponse", () => {
  test("is the status and the server's clock as an instant with offset", () => {
    const body = { status: "ok", time: "2026-09-17T13:41:00Z" }
    assert.deepEqual(HealthResponse.parse(body), body)
    assert.deepEqual(HealthResponse.parse({ status: "ok", time: "2026-09-17T15:41:00+02:00" }).time, "2026-09-17T15:41:00+02:00")
  })

  test("knows no other status and no clock without an offset", () => {
    assert.equal(HealthResponse.safeParse({ status: "degraded", time: "2026-09-17T13:41:00Z" }).success, false)
    assert.equal(HealthResponse.safeParse({ status: "ok", time: "2026-09-17T13:41:00" }).success, false)
    assert.equal(HealthResponse.safeParse({ status: "ok" }).success, false)
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
