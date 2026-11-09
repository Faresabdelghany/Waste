// The skew check the routes share (routes/shared.ts, Issue #109). No database.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { aheadOfClock, OCCURRED_AT_SKEW_MS, RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"

import { ProblemError } from "../problem"
import { requireNotAhead } from "../routes/shared"

describe("requireNotAhead, the one skew check the ticket create, the alert raise, the unload capture and the ledger read (Issue #109)", () => {
  const at = new Date("2026-10-05T12:00:00Z")
  const refusedAt = (path: string) => (error: unknown) =>
    error instanceof ProblemError && error.body.status === 400 && JSON.stringify(error.body.errors) === JSON.stringify([{ path, message: RECORDED_AFTER_IT_HAPPENED }])

  test("passes an instant at the clock, up to the skew ahead of it, and any distance behind it, since it has no lower bound", () => {
    requireNotAhead(at, at)
    requireNotAhead(new Date(at.getTime() + OCCURRED_AT_SKEW_MS), at)
    requireNotAhead(new Date(at.getTime() - 1), at)
    requireNotAhead(new Date("2020-01-01T00:00:00Z"), at)
  })

  test("refuses a millisecond past the skew as recorded after it happened, at `occurredAt` unless the caller names the field", () => {
    const beyond = new Date(at.getTime() + OCCURRED_AT_SKEW_MS + 1)
    assert.throws(() => requireNotAhead(beyond, at), refusedAt("occurredAt"))
    assert.throws(() => requireNotAhead(beyond, at, "detectedAt"), refusedAt("detectedAt"), "the alert raise names its own field")
    assert.throws(() => requireNotAhead(new Date(at.getTime() + 60 * 60_000), at), refusedAt("occurredAt"), "an hour ahead is no closer")
  })

  test("its verdict as a value, `aheadOfClock`, is the one a batch ingest reads to answer each reading on its own", () => {
    assert.equal(aheadOfClock(new Date(at.getTime() + OCCURRED_AT_SKEW_MS), at), false)
    assert.equal(aheadOfClock(new Date(at.getTime() + OCCURRED_AT_SKEW_MS + 1), at), true)
    assert.equal(aheadOfClock(new Date("2020-01-01T00:00:00Z"), at), false)
  })
})
