import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OutboxEvent } from "../outbox"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-10-05T06:00:00.000Z", updatedAt: "2026-10-05T06:00:00.000Z" }

const event = {
  id: ID,
  projectId: OTHER,
  kind: "route-started",
  aggregateKind: "route",
  aggregateId: THIRD,
  occurredAt: "2026-10-05T06:00:00.000Z",
  payload: { id: THIRD, status: "active", progress: { planned: 40, completed: 0, skipped: 0, failed: 0, total: 40, fraction: 0 } },
  publishedAt: null,
  ...STAMPS,
}

describe("OutboxEvent", () => {
  test("is a kind about an aggregate, the command's instant, the wire resource as payload, and the relay's stamp once published", () => {
    assert.deepEqual(OutboxEvent.parse(event), event)
    const published = { ...event, publishedAt: "2026-10-05T06:00:05.000Z" }
    assert.deepEqual(OutboxEvent.parse(published), published)
    assert.deepEqual(refusal(OutboxEvent.safeParse({ ...event, kind: "route.started" })).map((issue) => issue.path), ["kind"], "kebab, not dotted")
    assert.deepEqual(refusal(OutboxEvent.safeParse({ ...event, aggregateKind: "alert" })).map((issue) => issue.path), ["aggregateKind"], "an alert has no event of its own; a ticket has, since Resolution (Issue #109)")
    assert.equal(OutboxEvent.safeParse({ ...event, kind: "ticket-opened", aggregateKind: "ticket" }).success, true)
    assert.equal(OutboxEvent.safeParse({ ...event, payload: undefined }).success, false, "a payload is always there")
    assert.equal(OutboxEvent.safeParse({ ...event, payload: "a plain string is JSON too" }).success, true)
  })
})
