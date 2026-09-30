import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { RoutingQuota } from "../routing-quota"

const exhausted = {
  family: "optimisation",
  remaining: 0,
  limit: 500,
  resetAt: "2026-10-01T03:00:00.000Z",
  exhaustedAt: "2026-10-01T01:12:00.000Z",
  keyRefusedAt: null,
  updatedAt: "2026-10-01T01:12:00.000Z",
}

describe("RoutingQuota: what GET /routing/quota answers for the office's banner (#132 §5)", () => {
  test("the provider and a reading per family asked of it, exhausted or refused as the engine last knew", () => {
    const answer = { provider: "openrouteservice", families: [{ ...exhausted, family: "directions", remaining: 1_480, limit: 2_000, exhaustedAt: null }, exhausted] }
    assert.deepEqual(RoutingQuota.parse(answer), answer)
  })

  test("a provider that enforces no limit reads nulls, and a provider never asked reads no families", () => {
    const unlimited = { provider: "fake", families: [{ ...exhausted, family: "directions", remaining: null, limit: null, resetAt: null, exhaustedAt: null }] }
    assert.deepEqual(RoutingQuota.parse(unlimited), unlimited)
    assert.deepEqual(RoutingQuota.parse({ provider: "fake", families: [] }), { provider: "fake", families: [] })
  })

  test("refuses a family outside the vocabulary, a negative count and a missing instant", () => {
    assert.equal(RoutingQuota.safeParse({ provider: "fake", families: [{ ...exhausted, family: "matrix" }] }).success, false)
    assert.equal(RoutingQuota.safeParse({ provider: "fake", families: [{ ...exhausted, remaining: -1 }] }).success, false)
    assert.equal(RoutingQuota.safeParse({ provider: "fake", families: [{ ...exhausted, updatedAt: null }] }).success, false)
  })
})
