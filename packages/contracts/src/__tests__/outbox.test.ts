import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { OUTBOX_AGGREGATES, OUTBOX_EVENTS, OUTBOX_KINDS } from "@waste/domain/outbox/vocabulary"
import * as z from "zod"

import { OUTBOX_PAYLOADS, OutboxAggregate, OutboxEvent, OutboxKind, outboxPayloadOf, RouteEvent } from "../outbox"
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

/** A route as `GET /routes/:id` answers it, before the hold and the cancel's reason code reached the wire. */
const routeBefore209 = {
  id: THIRD,
  ...STAMPS,
  projectId: OTHER,
  routeSchemeId: null,
  collectionGroupId: null,
  serviceDate: "2026-10-05",
  operatingDate: "2026-10-05",
  number: 1042,
  label: "RC-1042",
  status: "cancelled",
  note: null,
  cancelledByGeneration: false,
  generationRunId: null,
  plannedStartTime: null,
  planned: { vehicleId: null, trailerId: null, driverId: null, serviceProviderId: null, depotId: null, unloadingStationId: null },
  actual: { vehicleId: null, trailerId: null, driverId: null },
  dispatchedAt: null,
  startedAt: null,
  completedAt: null,
  cancelledAt: "2026-10-05T06:00:00.000Z",
  progress: { planned: 0, completed: 0, skipped: 0, failed: 0, total: 0, fraction: 0 },
}

describe("OutboxEvent", () => {
  test("is a kind about an aggregate, the command's instant, the wire resource as payload, and the relay's stamp once published", () => {
    assert.deepEqual(OutboxEvent.parse(event), event)
    const published = { ...event, publishedAt: "2026-10-05T06:00:05.000Z" }
    assert.deepEqual(OutboxEvent.parse(published), published)
    assert.deepEqual(refusal(OutboxEvent.safeParse({ ...event, kind: "route.started" })).map((issue) => issue.path), ["kind"], "kebab, not dotted")
    assert.deepEqual(refusal(OutboxEvent.safeParse({ ...event, aggregateKind: "warehouse" })).map((issue) => issue.path), ["aggregateKind"], "a warehouse has no event of its own; a ticket has since Resolution (Issue #109), and an alert since the staff notices (O16 of #290)")
    assert.equal(OutboxEvent.safeParse({ ...event, kind: "ticket-opened", aggregateKind: "ticket" }).success, true)
    assert.equal(OutboxEvent.safeParse({ ...event, payload: undefined }).success, false, "a payload is always there")
    assert.equal(OutboxEvent.safeParse({ ...event, payload: "a plain string is JSON too" }).success, true)
  })

  test("its kinds and aggregates are the domain's, value for value and in the database's order", () => {
    assert.deepEqual(OutboxKind.options, [...OUTBOX_KINDS])
    assert.deepEqual(OutboxAggregate.options, [...OUTBOX_AGGREGATES])
  })
})

describe("OUTBOX_PAYLOADS", () => {
  test("names one schema for each aggregate a kind is about, and nothing else", () => {
    assert.deepEqual(Object.keys(OUTBOX_PAYLOADS), [...OUTBOX_KINDS])
    for (const kind of OUTBOX_KINDS) {
      assert.deepEqual(Object.keys(OUTBOX_PAYLOADS[kind]), [...OUTBOX_EVENTS[kind]], kind)
      for (const schema of Object.values(OUTBOX_PAYLOADS[kind])) assert.ok(schema instanceof z.ZodType, kind)
    }
  })

  test("reads a payload through its kind's schema for the aggregate, and refuses another resource or an aggregate the kind is never about", () => {
    const route = outboxPayloadOf("route-cancelled", "route", routeBefore209)
    assert.deepEqual([route.heldAt, route.cancelReasonCode], [null, null], "a route cancelled before the hold and the codes reads as neither")
    assert.deepEqual(RouteEvent.parse(routeBefore209), route)
    assert.throws(() => outboxPayloadOf("route-cancelled", "route", { id: THIRD }))
    assert.throws(() => outboxPayloadOf("pickup-problem-reported", "unload" as "route", routeBefore209), /is about pickup or route, never a unload/)
    assert.equal(outboxPayloadOf("pickup-problem-reported", "route", { ...routeBefore209, proofs: [] }).id, THIRD)
  })
})
