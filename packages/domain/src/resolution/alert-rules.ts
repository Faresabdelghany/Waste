// The worker's alert rules (O4 of #290): four conditions the office should
// hear of without anyone raising them by hand. A route still waiting half an
// hour after its planned start; a driver's device silent for a quarter of an
// hour on a route that is running; a driver's licence running out within a
// month, or run out; and a ticket past its due date. Each is an Alert — a
// condition that requires attention — and never a Ticket: an overdue ticket's
// alert is about that ticket and linked to it.
//
// The worker finds the occurrences and keys them (apps/worker's alert-rules
// job, one alert per occurrence, so a person's resolve is not undone by the
// next tick); this module says what each one's alert is — its kind,
// severity, source, words and subject — from the facts the worker read, and
// what the note says when the worker resolves it because the condition has
// cleared. Times and days come in already spelled on the project's clock.
//
// O8 of #290 added a fifth, decided on #344: a running session whose device
// is still heard from but has sent no position for ten minutes — the phone's
// location refused or lost, or the route's screen closed — raised from the
// telemetry. A device not heard from at all is the silent session's alert,
// not this one.
//
// O26 of #290 added a sixth: a container whose fill-level Sensor's newest
// reading is at or past its pairing's full threshold, raised from the
// telemetry and about the container. One filling is one alert: the worker
// keys it by the last reading below the threshold, so it is raised again only
// once the bin has read low in between.
import type { AlertKind, AlertRule, AlertSeverity, AlertSource } from "./vocabulary"

/** A route is late this long after its planned start. */
export const ROUTE_START_GRACE_MINUTES = 30
/** A running route's device is silent after this long without a word. */
export const SESSION_SILENCE_MINUTES = 15
/** A running session's position is stale this long after its last fix, or after its start or its last resume without one. */
export const POSITION_STALE_MINUTES = 10
/** A licence is warned of this many days before it runs out. */
export const LICENCE_WARNING_DAYS = 30
/** How far back a rule looks for a new occurrence: a route planned, or a device last heard from, more than a day ago is history to read, not news to raise. */
export const RULE_LOOKBACK_HOURS = 24

/** One occurrence of a rule, with what its alert names and says. */
export type RuleOccurrence =
  | { rule: "route-not-started"; routeId: string; routeLabel: string; operatingDate: string; plannedStart: string; driverId: string | null; vehicleId: string | null }
  | { rule: "session-silent"; routeId: string; routeLabel: string; driverId: string; driverName: string; vehicleId: string | null; lastSeen: string }
  | { rule: "licence-expiring"; driverId: string; driverName: string; licenceExpiry: string; today: string }
  | { rule: "ticket-overdue"; ticketId: string; ticketLabel: string; subject: string; due: string }
  | { rule: "position-stale"; routeId: string; routeLabel: string; driverId: string; driverName: string; vehicleId: string | null; lastFix: string | null }
  | { rule: "fill-threshold"; containerId: string; containerLabel: string; sensorIdentifier: string; fillPercent: number; thresholdPercent: number; measuredAt: string }

/** An alert as a rule raises it: everything but its project, its key and its instants. */
export type RuleAlert = {
  rule: AlertRule
  kind: AlertKind
  severity: AlertSeverity
  source: AlertSource
  title: string
  details: string
  routeId: string | null
  vehicleId: string | null
  driverId: string | null
  containerId: string | null
  ticketId: string | null
}

const NO_SUBJECT = { routeId: null, vehicleId: null, driverId: null, containerId: null, ticketId: null }

const DAY_MS = 24 * 60 * 60 * 1000
const daysUntil = (today: string, day: string): number => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)

/** The alert a rule raises for one occurrence. */
export function alertOfRule(occurrence: RuleOccurrence): RuleAlert {
  switch (occurrence.rule) {
    case "route-not-started":
      return {
        rule: occurrence.rule,
        kind: "route-exception",
        severity: "high",
        source: "rule",
        title: `${occurrence.routeLabel} has not started`,
        details: `Planned to start at ${occurrence.plannedStart} on ${occurrence.operatingDate}, and still not started ${ROUTE_START_GRACE_MINUTES} minutes later.`,
        ...NO_SUBJECT,
        routeId: occurrence.routeId,
        vehicleId: occurrence.vehicleId,
        driverId: occurrence.driverId,
      }
    case "session-silent":
      return {
        rule: occurrence.rule,
        kind: "route-exception",
        severity: "medium",
        source: "execution",
        title: `${occurrence.driverName}'s device is silent on ${occurrence.routeLabel}`,
        details: `Last heard from at ${occurrence.lastSeen}, and nothing from the Driver App for ${SESSION_SILENCE_MINUTES} minutes since.`,
        ...NO_SUBJECT,
        routeId: occurrence.routeId,
        vehicleId: occurrence.vehicleId,
        driverId: occurrence.driverId,
      }
    case "licence-expiring": {
      const expired = daysUntil(occurrence.today, occurrence.licenceExpiry) < 0
      return {
        rule: occurrence.rule,
        kind: "resource",
        severity: expired ? "high" : "medium",
        source: "rule",
        title: expired ? `${occurrence.driverName}'s licence has expired` : `${occurrence.driverName}'s licence expires on ${occurrence.licenceExpiry}`,
        // No count of days: the alert stands until the licence is renewed or runs out, and a count would be stale by then.
        details: expired ? `It ran out on ${occurrence.licenceExpiry}: the driver cannot be planned on a route until it is renewed.` : `Renew it before ${occurrence.licenceExpiry}, or the driver cannot be planned on a route after it.`,
        ...NO_SUBJECT,
        driverId: occurrence.driverId,
      }
    }
    case "ticket-overdue":
      return {
        rule: occurrence.rule,
        kind: "service-risk",
        severity: "high",
        source: "rule",
        title: `${occurrence.ticketLabel} is overdue`,
        details: `${occurrence.subject} was due ${occurrence.due}.`,
        ...NO_SUBJECT,
        ticketId: occurrence.ticketId,
      }
    case "position-stale":
      return {
        rule: occurrence.rule,
        kind: "route-exception",
        severity: "medium",
        source: "telemetry",
        title: `No position from ${occurrence.driverName} on ${occurrence.routeLabel}`,
        details:
          occurrence.lastFix === null
            ? `The Driver App has sent no position since the session started, ${POSITION_STALE_MINUTES} minutes or more, though the device is heard from: its location may be off, or the route's screen closed.`
            : `Last position at ${occurrence.lastFix}, and none for ${POSITION_STALE_MINUTES} minutes since, though the device is heard from: its location may be off, or the route's screen closed.`,
        ...NO_SUBJECT,
        routeId: occurrence.routeId,
        vehicleId: occurrence.vehicleId,
        driverId: occurrence.driverId,
      }
    case "fill-threshold": {
      const full = occurrence.fillPercent >= 100
      return {
        rule: occurrence.rule,
        kind: "service-risk",
        severity: full ? "high" : "medium",
        source: "telemetry",
        title: full ? `${occurrence.containerLabel} is full` : `${occurrence.containerLabel} is ${occurrence.fillPercent}% full`,
        details: `Sensor ${occurrence.sensorIdentifier} read ${occurrence.fillPercent}% at ${occurrence.measuredAt}, at or past the full threshold of ${occurrence.thresholdPercent}%: empty it before it overflows.`,
        ...NO_SUBJECT,
        containerId: occurrence.containerId,
      }
    }
  }
}

/** What the worker resolves a rule's alert with once its condition no longer holds, in the vocabulary's order. */
export const CLEARED_NOTES: Readonly<Record<AlertRule, string>> = {
  "route-not-started": "Cleared: the route started, or was cancelled.",
  "session-silent": "Cleared: the device was heard from again, or the session or the route ended.",
  "licence-expiring": "Cleared: the licence was renewed, or has run out and is raised again as expired, or the driver is no longer active.",
  "ticket-overdue": "Cleared: the ticket was closed, or given a later due date.",
  "position-stale": "Cleared: a position came in, or the session was paused or ended, or the route ended.",
  "fill-threshold": "Cleared: the sensor read below the threshold again, or the pairing ended.",
}
