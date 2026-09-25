import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PICKUP_OUTCOMES } from "@waste/domain/execution/vocabulary"

import { Pickup, PickupCorrection, PickupDetail, PickupListQuery, PickupOutcome, PickupRemove, REASON_WITH_A_MISS, reasonWithOutcome } from "../pickups"
import { DAY_WINDOW_ORDERED } from "../queries"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-10-04T22:00:00.000Z", updatedAt: "2026-10-05T06:25:00.000Z" }
const WHEN = "2026-10-05T06:25:00.000Z"
const missIssue = { path: "reason", message: REASON_WITH_A_MISS }

const pickup = {
  id: ID,
  projectId: OTHER,
  routeId: THIRD,
  containerId: ID,
  position: 12,
  status: "completed",
  reason: null,
  note: null,
  propertyId: OTHER,
  sharedCollectionPointId: null,
  wasteFractionId: THIRD,
  arrivedAt: "2026-10-05T06:20:00.000Z",
  outcomeAt: WHEN,
  ...STAMPS,
}

const proof = {
  id: OTHER,
  recordedAt: WHEN,
  projectId: OTHER,
  routeId: THIRD,
  pickupId: ID,
  sessionId: THIRD,
  kind: "completion",
  source: "driver-app",
  occurredAt: WHEN,
  recordedBy: ID,
  deviceId: "device-7",
  location: null,
  locationAccuracyM: null,
  reason: null,
  note: null,
  weightKg: null,
  objectKey: null,
  outcome: null,
}

describe("Pickup", () => {
  test("is one stop-level action on a route with the place and the fraction on the service date, its outcome and when", () => {
    assert.deepEqual(Pickup.parse(pickup), pickup)
    const atAPoint = { ...pickup, status: "skipped", reason: "not-presented", propertyId: null, sharedCollectionPointId: THIRD }
    assert.deepEqual(Pickup.parse(atAPoint), atAPoint)
    const planned = { ...pickup, status: "planned", arrivedAt: null, outcomeAt: null }
    assert.deepEqual(Pickup.parse(planned), planned)
    assert.equal(Pickup.safeParse({ ...pickup, position: 0 }).success, false)
    assert.equal(Pickup.safeParse({ ...pickup, status: "rescheduled" }).success, false, "a Ticket's outcome")
    const detail = { ...pickup, proofs: [proof] }
    assert.deepEqual(PickupDetail.parse(detail), detail)
  })
})

describe("the dispatcher's commands", () => {
  test("remove carries the reason and nothing else", () => {
    assert.deepEqual(PickupRemove.parse({ reason: "Property demolished" }), { reason: "Property demolished" })
    assert.deepEqual(refusal(PickupRemove.safeParse({})).map((issue) => issue.path), ["reason"])
    assert.match(refusal(PickupRemove.safeParse({ reason: "x", status: "skipped" }))[0].message, /status/)
  })

  test("a correction gives an outcome that is not planned, a note, and a reason exactly with a skip or a failure", () => {
    assert.deepEqual(PickupOutcome.options, [...PICKUP_OUTCOMES])
    assert.deepEqual(PickupOutcome.options, ["completed", "skipped", "failed"])
    assert.deepEqual(PickupCorrection.parse({ outcome: "completed", note: "Driver's photo shows the bin emptied" }), { outcome: "completed", note: "Driver's photo shows the bin emptied" })
    assert.deepEqual(PickupCorrection.parse({ outcome: "failed", reason: "contamination", note: "Confirmed by the crew" }), { outcome: "failed", reason: "contamination", note: "Confirmed by the crew" })
    assert.deepEqual(refusal(PickupCorrection.safeParse({ outcome: "skipped", note: "x" })), [missIssue])
    assert.deepEqual(refusal(PickupCorrection.safeParse({ outcome: "completed", reason: "other", note: "x" })), [missIssue])
    assert.deepEqual(refusal(PickupCorrection.safeParse({ outcome: "planned", note: "x" })).map((issue) => issue.path), ["outcome"], "there is no correcting a pickup back to planned")
    assert.deepEqual(refusal(PickupCorrection.safeParse({ outcome: "failed", reason: "safety" })).map((issue) => issue.path), ["note"], "a correction says why")
    assert.match(refusal(PickupCorrection.safeParse({ outcome: "completed", note: "x", outcomeAt: "2026-10-05" }))[0].message, /outcomeAt/, "the instant is the server's")
    assert.equal(reasonWithOutcome({ outcome: "skipped", reason: "route-ended" }), true, "the system's reasons are a correction's to give")
    assert.equal(reasonWithOutcome({ outcome: "completed", reason: null }), true)
  })
})

describe("PickupListQuery", () => {
  test("pages by project, route, container, status, property and a window of the route's operating days, ordered", () => {
    assert.deepEqual(PickupListQuery.parse({}), { limit: 50 })
    const query = { projectId: OTHER, routeId: THIRD, containerId: ID, status: "failed", propertyId: OTHER, from: "2026-10-05", to: "2026-10-11" }
    assert.deepEqual(PickupListQuery.parse(query), { ...query, limit: 50 })
    assert.deepEqual(refusal(PickupListQuery.safeParse({ from: "2026-10-11", to: "2026-10-05" })), [{ path: "to", message: DAY_WINDOW_ORDERED }])
  })
})
