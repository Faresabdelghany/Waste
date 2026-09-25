import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  COMMAND_OUTCOMES,
  DRIVER_COMMAND_KINDS,
  DRIVER_PICKUP_REASONS,
  EXECUTION_SOURCES,
  OUTBOX_AGGREGATES,
  OUTBOX_KINDS,
  PICKUP_OUTCOMES,
  PICKUP_REASONS,
  PICKUP_STATUSES,
  PROOF_KINDS,
  ROUTE_STATUSES,
} from "@waste/domain/execution/vocabulary"

import {
  CommandOutcome,
  DriverCommandKind,
  DriverPickupReason,
  ExecutionSource,
  OBJECT_EXTENSIONS,
  OBJECT_KEY,
  OBJECT_KEY_SHAPE,
  ObjectKey,
  OutboxAggregate,
  OutboxKind,
  PickupOutcome,
  PickupReason,
  PickupStatus,
  ProofKind,
  ROUTE_NUMBER_PREFIX,
  routeLabel,
  RouteStatus,
} from "../execution"
import { refusal } from "./expect"

const COMPANY = "01a0d3a5-e5e0-7000-8000-000000000001"
const ROUTE = "01a0d3a5-e5e0-7000-8000-000000000002"
const COMMAND = "01a0d3a5-e5e0-7000-8000-000000000003"

describe("the Execution enums", () => {
  test("are the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(RouteStatus.options, [...ROUTE_STATUSES])
    assert.deepEqual(PickupStatus.options, [...PICKUP_STATUSES])
    assert.deepEqual(PickupOutcome.options, [...PICKUP_OUTCOMES])
    assert.deepEqual(PickupReason.options, [...PICKUP_REASONS])
    assert.deepEqual(DriverPickupReason.options, [...DRIVER_PICKUP_REASONS])
    assert.deepEqual(ProofKind.options, [...PROOF_KINDS])
    assert.deepEqual(ExecutionSource.options, [...EXECUTION_SOURCES])
    assert.deepEqual(DriverCommandKind.options, [...DRIVER_COMMAND_KINDS])
    assert.deepEqual(CommandOutcome.options, [...COMMAND_OUTCOMES])
    assert.deepEqual(OutboxKind.options, [...OUTBOX_KINDS])
    assert.deepEqual(OutboxAggregate.options, [...OUTBOX_AGGREGATES])
  })

  test("refuse the prototype's display strings and the readings that are never stored", () => {
    assert.equal(RouteStatus.safeParse("Draft").success, false, "a generated route is never a draft")
    assert.equal(RouteStatus.safeParse("paused").success, false, "a reading of the session")
    assert.equal(PickupStatus.safeParse("rescheduled").success, false, "a Ticket's outcome")
    assert.equal(PickupOutcome.safeParse("planned").success, false, "nothing moves a pickup back to planned")
    assert.equal(PickupStatus.safeParse("next").success, false, "a reading")
    assert.equal(DriverPickupReason.safeParse("route-ended").success, false, "the system's, not a device's")
    assert.equal(PickupReason.safeParse("route-ended").success, true)
    assert.equal(CommandOutcome.safeParse("replayed").success, false, "the wire's word, never stored")
    assert.equal(DriverCommandKind.safeParse("retry-sync").success, false, "the device's, not a command")
    assert.equal(ExecutionSource.safeParse("audited-correction").success, false, "a kind, not a source")
  })
})

describe("the route label", () => {
  test("is the number under the one prefix", () => {
    assert.equal(ROUTE_NUMBER_PREFIX, "RC-")
    assert.equal(routeLabel(1042), "RC-1042")
    assert.equal(routeLabel(7), "RC-7")
  })
})

describe("ObjectKey", () => {
  test("is <companyId>/<routeId>/<commandId>.<ext> over the four formats, lowercase UUIDs, and nothing else", () => {
    for (const extension of OBJECT_EXTENSIONS) assert.equal(ObjectKey.safeParse(`${COMPANY}/${ROUTE}/${COMMAND}.${extension}`).success, true, extension)
    assert.deepEqual([...OBJECT_EXTENSIONS], ["jpg", "jpeg", "png", "webp"])
    for (const wrong of [`${COMPANY}/${ROUTE}/${COMMAND}.gif`, `${COMPANY}/${ROUTE}/${COMMAND}`, `${COMPANY}/${COMMAND}.jpg`, `${COMPANY.toUpperCase()}/${ROUTE}/${COMMAND}.jpg`, `../${ROUTE}/${COMMAND}.jpg`, `${COMPANY}/${ROUTE}/${COMMAND}.jpg/extra`]) {
      assert.deepEqual(refusal(ObjectKey.safeParse(wrong)), [{ path: "", message: OBJECT_KEY_SHAPE }], wrong)
    }
    assert.equal(OBJECT_KEY.test(`${COMPANY}/${ROUTE}/${COMMAND}.png`), true)
  })
})
