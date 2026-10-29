// The worker's alert rules (O4 of #290): what each rule's Alert says and is
// about, the thresholds the rules read, and the note an alert is resolved
// with when its condition clears.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { alertOfRule, CLEARED_NOTES, LICENCE_WARNING_DAYS, POSITION_STALE_MINUTES, ROUTE_START_GRACE_MINUTES, RULE_LOOKBACK_HOURS, SESSION_SILENCE_MINUTES } from "../alert-rules"
import { ALERT_RULES } from "../vocabulary"

describe("the thresholds", () => {
  test("a route is late half an hour after its planned start, a device silent after a quarter of an hour, and a licence is warned of a month ahead", () => {
    assert.deepEqual([ROUTE_START_GRACE_MINUTES, SESSION_SILENCE_MINUTES, LICENCE_WARNING_DAYS, RULE_LOOKBACK_HOURS], [30, 15, 30, 24])
  })

  test("a position is stale after ten minutes without one (O8 of #290), sooner than a device is silent, so a phone heard from whose location is off is told apart", () => {
    assert.equal(POSITION_STALE_MINUTES, 10)
    assert.ok(POSITION_STALE_MINUTES < SESSION_SILENCE_MINUTES)
  })
})

describe("what each rule's alert says", () => {
  test("a route not started is a high route exception about the route and whom it was planned for", () => {
    const alert = alertOfRule({ rule: "route-not-started", routeId: "route", routeLabel: "RC-1042", operatingDate: "2026-10-24", plannedStart: "07:00", driverId: "karen", vehicleId: "truck" })
    assert.deepEqual(alert, {
      rule: "route-not-started",
      kind: "route-exception",
      severity: "high",
      source: "rule",
      title: "RC-1042 has not started",
      details: "Planned to start at 07:00 on 2026-10-24, and still not started 30 minutes later.",
      routeId: "route",
      vehicleId: "truck",
      driverId: "karen",
      containerId: null,
      ticketId: null,
    })
  })

  test("a silent device is a medium exception the work itself raised, about the route, its driver and its vehicle", () => {
    const alert = alertOfRule({ rule: "session-silent", routeId: "route", routeLabel: "RC-1042", driverId: "mads", driverName: "Mads Jensen", vehicleId: null, lastSeen: "08:12" })
    assert.deepEqual([alert.kind, alert.severity, alert.source], ["route-exception", "medium", "execution"])
    assert.equal(alert.title, "Mads Jensen's device is silent on RC-1042")
    assert.equal(alert.details, "Last heard from at 08:12, and nothing from the Driver App for 15 minutes since.")
    assert.deepEqual([alert.routeId, alert.driverId, alert.vehicleId, alert.ticketId], ["route", "mads", null, null])
  })

  test("a licence running out is a medium resource alert naming its last day, no count of days to go stale; an expired one is high", () => {
    const expiring = alertOfRule({ rule: "licence-expiring", driverId: "mads", driverName: "Mads Jensen", licenceExpiry: "2026-11-07", today: "2026-10-24" })
    assert.deepEqual([expiring.kind, expiring.severity, expiring.source], ["resource", "medium", "rule"])
    assert.equal(expiring.title, "Mads Jensen's licence expires on 2026-11-07")
    assert.equal(expiring.details, "Renew it before 2026-11-07, or the driver cannot be planned on a route after it.")
    const lastDay = alertOfRule({ rule: "licence-expiring", driverId: "mads", driverName: "Mads Jensen", licenceExpiry: "2026-10-24", today: "2026-10-24" })
    assert.equal(lastDay.severity, "medium", "its last day is a day it still holds")
    const expired = alertOfRule({ rule: "licence-expiring", driverId: "mads", driverName: "Mads Jensen", licenceExpiry: "2026-10-20", today: "2026-10-24" })
    assert.deepEqual([expired.severity, expired.title], ["high", "Mads Jensen's licence has expired"])
    assert.equal(expired.details, "It ran out on 2026-10-20: the driver cannot be planned on a route until it is renewed.")
    assert.deepEqual([expired.driverId, expired.routeId], ["mads", null])
  })

  test("an overdue ticket is a high service risk about the ticket, never a ticket of its own", () => {
    const alert = alertOfRule({ rule: "ticket-overdue", ticketId: "ticket", ticketLabel: "T-1042", subject: "Bin left out", due: "2026-10-24 12:00" })
    assert.deepEqual([alert.kind, alert.severity, alert.source], ["service-risk", "high", "rule"])
    assert.equal(alert.title, "T-1042 is overdue")
    assert.equal(alert.details, "Bin left out was due 2026-10-24 12:00.")
    assert.deepEqual([alert.ticketId, alert.routeId, alert.driverId, alert.vehicleId, alert.containerId], ["ticket", null, null, null, null])
  })
})

describe("a stale position (O8 of #290)", () => {
  test("is a medium route exception from the telemetry, about the route, its driver and its vehicle, naming the last fix or saying there was none", () => {
    const stale = alertOfRule({ rule: "position-stale", routeId: "route", routeLabel: "RC-1042", driverId: "mads", driverName: "Mads Jensen", vehicleId: "truck", lastFix: "08:12" })
    assert.deepEqual([stale.rule, stale.kind, stale.severity, stale.source], ["position-stale", "route-exception", "medium", "telemetry"])
    assert.equal(stale.title, "No position from Mads Jensen on RC-1042")
    assert.equal(stale.details, "Last position at 08:12, and none for 10 minutes since, though the device is heard from: its location may be off, or the route's screen closed.")
    assert.deepEqual([stale.routeId, stale.driverId, stale.vehicleId, stale.ticketId, stale.containerId], ["route", "mads", "truck", null, null])
    const none = alertOfRule({ rule: "position-stale", routeId: "route", routeLabel: "RC-1042", driverId: "mads", driverName: "Mads Jensen", vehicleId: null, lastFix: null })
    assert.equal(none.details, "The Driver App has sent no position since the session started, 10 minutes or more, though the device is heard from: its location may be off, or the route's screen closed.")
  })
})

describe("a filling container (O26 of #290)", () => {
  const reading = { rule: "fill-threshold" as const, containerId: "bin", containerLabel: "BIN-82014", sensorIdentifier: "S-401", fillPercent: 88, thresholdPercent: 85, measuredAt: "2026-10-29 07:40" }

  test("is a medium service risk from the telemetry about the container, naming the sensor, the reading and the threshold", () => {
    const alert = alertOfRule(reading)
    assert.deepEqual([alert.rule, alert.kind, alert.severity, alert.source], ["fill-threshold", "service-risk", "medium", "telemetry"])
    assert.equal(alert.title, "BIN-82014 is 88% full")
    assert.equal(alert.details, "Sensor S-401 read 88% at 2026-10-29 07:40, at or past the full threshold of 85%: empty it before it overflows.")
    assert.deepEqual([alert.containerId, alert.routeId, alert.driverId, alert.vehicleId, alert.ticketId], ["bin", null, null, null, null])
  })

  test("ends with what the fill-driven emptying came to, where the pairing books one", () => {
    const route = { id: "r", label: "RC-1042", operatingDate: "2026-10-30", routeSchemeId: "s", collectionGroupId: "g" }
    assert.match(alertOfRule({ ...reading, emptying: { kind: "booked", route } }).details, /overflows\. An emptying is booked on RC-1042 on 2026-10-30\.$/)
    assert.match(alertOfRule({ ...reading, emptying: { kind: "refused", route, reason: "WH-24 has no compartment for Glass, which the stop collects" } }).details, /No emptying is booked on RC-1042: WH-24 has no compartment for Glass, which the stop collects\.$/)
    assert.match(alertOfRule({ ...reading, emptying: { kind: "no-schedule" } }).details, /no emptying of it is planned to bring forward\.$/)
  })

  test("is high once the bin reads full", () => {
    const alert = alertOfRule({ ...reading, fillPercent: 100 })
    assert.deepEqual([alert.severity, alert.title], ["high", "BIN-82014 is full"])
  })
})

describe("when a condition clears", () => {
  test("each rule resolves its alert with a note of its own", () => {
    assert.deepEqual(Object.keys(CLEARED_NOTES), [...ALERT_RULES])
    for (const note of Object.values(CLEARED_NOTES)) assert.match(note, /^Cleared: /)
  })
})
