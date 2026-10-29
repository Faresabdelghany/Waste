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
// once the bin has read low in between. Where the pairing books an emptying,
// the alert ends with what booking came to (execution/fill-emptying.ts).
//
// M17 of #293 added the disposal-site reconciliation (row 28.4), four rules
// over what the stations' and the receiving sites' tickets say:
//   `load-not-received`: an Outbound Load departed `LOAD_RECEIPT_HOURS` ago
//   and more with no receiving ticket recorded: the load never tipped, or
//   its ticket never came back;
//   `load-weight-mismatch`: a received load whose receiving site's net differs
//   from our out-weighing beyond the project's weight tolerance, until the
//   office reconciles or disputes it;
//   `load-overweight`: a load on our vehicle heavier than its rated payload;
//   `route-not-tipped`: a completed route that planned an Unloading Station
//   and collected something, with no Unload recorded `ROUTE_TIP_GRACE_HOURS`
//   after it ended.
// "Excess tips" — more Unloads than a route's Plan visits a station — is not
// a rule: a Plan holds only the unload visits on the way (O15 of #290), not
// the tip at the end, and most routes have no Plan, so the count it would
// judge against is not there to be relied on.
import { emptyingSentence, type FillEmptyingOutcome } from "../execution/fill-emptying"
import type { AlertKind, AlertRule, AlertSeverity, AlertSource } from "./vocabulary"

/** A route is late this long after its planned start. */
export const ROUTE_START_GRACE_MINUTES = 30
/** A running route's device is silent after this long without a word. */
export const SESSION_SILENCE_MINUTES = 15
/** A running session's position is stale this long after its last fix, or after its start or its last resume without one. */
export const POSITION_STALE_MINUTES = 10
/** A licence is warned of this many days before it runs out. */
export const LICENCE_WARNING_DAYS = 30
/** An outbound load is overdue at the receiving site this long after it departed. */
export const LOAD_RECEIPT_HOURS = 24
/** A completed route is untipped this long after it ended with no unload: time for the office to capture the weighbridge's ticket. */
export const ROUTE_TIP_GRACE_HOURS = 2

/** How far back a rule looks for a new occurrence: a route planned, or a device last heard from, more than a day ago is history to read, not news to raise. */
export const RULE_LOOKBACK_HOURS = 24

/** One occurrence of a rule, with what its alert names and says. */
export type RuleOccurrence =
  | { rule: "route-not-started"; routeId: string; routeLabel: string; operatingDate: string; plannedStart: string; driverId: string | null; vehicleId: string | null }
  | { rule: "session-silent"; routeId: string; routeLabel: string; driverId: string; driverName: string; vehicleId: string | null; lastSeen: string }
  | { rule: "licence-expiring"; driverId: string; driverName: string; licenceExpiry: string; today: string }
  | { rule: "ticket-overdue"; ticketId: string; ticketLabel: string; subject: string; due: string }
  | { rule: "position-stale"; routeId: string; routeLabel: string; driverId: string; driverName: string; vehicleId: string | null; lastFix: string | null }
  | { rule: "fill-threshold"; containerId: string; containerLabel: string; sensorIdentifier: string; fillPercent: number; thresholdPercent: number; measuredAt: string; emptying?: FillEmptyingOutcome }
  | { rule: "load-not-received"; outboundLoadId: string; vehicleId: string | null; registration: string; fromStation: string; toStation: string; departedAt: string }
  | { rule: "load-weight-mismatch"; outboundLoadId: string; vehicleId: string | null; registration: string; toStation: string; ticket: string; netKg: number; receivedNetKg: number; tolerancePercent: number }
  | { rule: "load-overweight"; outboundLoadId: string; vehicleId: string; registration: string; netKg: number; capacityKg: number }
  | { rule: "route-not-tipped"; routeId: string; routeLabel: string; operatingDate: string; station: string; driverId: string | null; vehicleId: string | null }

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
  outboundLoadId: string | null
}

const NO_SUBJECT = { routeId: null, vehicleId: null, driverId: null, containerId: null, ticketId: null, outboundLoadId: null }

/** Whole kilograms as a person reads them: 18,400. */
const kilograms = (kg: number): string => String(kg).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

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
        details: `Sensor ${occurrence.sensorIdentifier} read ${occurrence.fillPercent}% at ${occurrence.measuredAt}, at or past the full threshold of ${occurrence.thresholdPercent}%: empty it before it overflows.${occurrence.emptying === undefined ? "" : ` ${emptyingSentence(occurrence.emptying)}`}`,
        ...NO_SUBJECT,
        containerId: occurrence.containerId,
      }
    }
    case "load-not-received":
      return {
        rule: occurrence.rule,
        kind: "weight",
        severity: "high",
        source: "rule",
        title: `${occurrence.registration}'s load to ${occurrence.toStation} is not received`,
        details: `It left ${occurrence.fromStation} at ${occurrence.departedAt}, and no ticket from ${occurrence.toStation} is recorded ${LOAD_RECEIPT_HOURS} hours later: the load never tipped, or its ticket never came back.`,
        ...NO_SUBJECT,
        outboundLoadId: occurrence.outboundLoadId,
        vehicleId: occurrence.vehicleId,
      }
    case "load-weight-mismatch": {
      const difference = occurrence.receivedNetKg - occurrence.netKg
      return {
        rule: occurrence.rule,
        kind: "weight",
        severity: "medium",
        source: "rule",
        title: `${occurrence.toStation} weighed ${occurrence.registration}'s load ${kilograms(Math.abs(difference))} kg ${difference < 0 ? "lighter" : "heavier"}`,
        details: `Ticket ${occurrence.ticket} says ${kilograms(occurrence.receivedNetKg)} kg against our ${kilograms(occurrence.netKg)} kg, beyond the project's ${occurrence.tolerancePercent}% tolerance: reconcile the load, or dispute it.`,
        ...NO_SUBJECT,
        outboundLoadId: occurrence.outboundLoadId,
        vehicleId: occurrence.vehicleId,
      }
    }
    case "load-overweight":
      return {
        rule: occurrence.rule,
        kind: "weight",
        severity: "high",
        source: "rule",
        title: `${occurrence.registration} left overloaded`,
        details: `Its load weighed ${kilograms(occurrence.netKg)} kg net, ${kilograms(occurrence.netKg - occurrence.capacityKg)} kg over the vehicle's rated payload of ${kilograms(occurrence.capacityKg)} kg.`,
        ...NO_SUBJECT,
        outboundLoadId: occurrence.outboundLoadId,
        vehicleId: occurrence.vehicleId,
      }
    case "route-not-tipped":
      return {
        rule: occurrence.rule,
        kind: "weight",
        severity: "medium",
        source: "rule",
        title: `${occurrence.routeLabel} has no unload`,
        details: `It ended on ${occurrence.operatingDate} with collected stops and no unload recorded, though it was planned to unload at ${occurrence.station}: the vehicle never tipped, or the weighbridge's ticket is not captured.`,
        ...NO_SUBJECT,
        routeId: occurrence.routeId,
        vehicleId: occurrence.vehicleId,
        driverId: occurrence.driverId,
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
  "load-not-received": "Cleared: the receiving site's ticket was recorded, or the load was cancelled.",
  "load-weight-mismatch": "Cleared: the load was reconciled or disputed, or its receipt corrected within the tolerance.",
  "load-overweight": "Cleared: the load was cancelled, or the vehicle's rated payload corrected.",
  "route-not-tipped": "Cleared: an unload was recorded on the route.",
}
