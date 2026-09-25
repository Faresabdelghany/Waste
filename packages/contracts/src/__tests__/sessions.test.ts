import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Session, SessionListQuery } from "../sessions"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const STAMPS = { createdAt: "2026-10-05T06:00:00.000Z", updatedAt: "2026-10-05T06:05:00.000Z" }

const session = {
  id: ID,
  projectId: OTHER,
  routeId: THIRD,
  driverId: ID,
  vehicleId: OTHER,
  trailerId: null,
  deviceId: "device-7",
  appVersion: "1.4.0",
  startedAt: "2026-10-05T06:00:00.000Z",
  endedAt: null,
  pausedAt: null,
  lastSeenAt: "2026-10-05T06:05:00.000Z",
  ...STAMPS,
}

describe("Session", () => {
  test("is the driver's work session on one route: open while endedAt is null, paused while pausedAt is set, with no status of its own", () => {
    assert.deepEqual(Session.parse(session), session)
    const paused = { ...session, pausedAt: "2026-10-05T09:00:00.000Z", trailerId: THIRD, appVersion: null }
    assert.deepEqual(Session.parse(paused), paused)
    const ended = { ...session, endedAt: "2026-10-05T14:00:00.000Z" }
    assert.deepEqual(Session.parse(ended), ended)
    assert.equal(Object.keys(Session.shape).includes("status"), false, "open and ended are readings of endedAt")
    assert.deepEqual(refusal(Session.safeParse({ ...session, deviceId: " " })).map((issue) => issue.path), ["deviceId"])
    assert.equal(Session.safeParse({ ...session, startedAt: "2026-10-05" }).success, false, "an instant, not a day")
  })
})

describe("SessionListQuery", () => {
  test("pages by project, route and driver, and by whether the session is still running, as a query string spells a boolean", () => {
    assert.deepEqual(SessionListQuery.parse({}), { limit: 50 })
    assert.deepEqual(SessionListQuery.parse({ routeId: THIRD, driverId: ID, open: "true" }), { routeId: THIRD, driverId: ID, open: true, limit: 50 })
    assert.deepEqual(SessionListQuery.parse({ open: "false" }), { open: false, limit: 50 })
    assert.equal(SessionListQuery.safeParse({ open: "yes" }).success, false)
    assert.equal(SessionListQuery.safeParse({ open: "True" }).success, false, "case-sensitive, like planAhead")
  })
})
