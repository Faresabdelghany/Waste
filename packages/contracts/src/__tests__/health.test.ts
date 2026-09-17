import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { HealthResponse } from "../health"

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
