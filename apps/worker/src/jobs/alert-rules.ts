// The worker's alert rules (O4 of #290): every few minutes, across companies,
// the four conditions — five since O8, below — the office should hear of without anyone raising them
// — a route still waiting half an hour after its planned start, a running
// route's device silent for a quarter of an hour, an active driver's licence
// within a month of running out or run out, and an open ticket past its due
// date — raised as Alerts (`source` rule, or execution for the silent
// device), never Tickets; and every rule's open alert whose condition has
// cleared resolved, with no account and the rule's note
// (@waste/domain/resolution/alert-rules says what each alert and note says).
//
// One alert per occurrence: each occurrence has a key — `route-not-started:
// <route>:<day>T<start>`, `session-silent:<session>:<last heard from>`,
// `licence-expiring:<driver>:<expiry>` (`:expired` once it has run out),
// `ticket-overdue:<ticket>:<due>` — spelled once here for the raise and the
// clear, and `alert_rule_key_idx` holds it unique per company over every
// alert but one the worker itself cleared. So a tick that overlaps the last
// raises nothing twice; a person's resolve holds while the condition does,
// the next tick finding the key taken; a condition the worker cleared that
// comes back — a ticket closed and reopened past the same due date — is
// raised again; and a new occurrence — a route moved to another day or
// start, the device heard from and silent again, a ticket re-dated, a
// licence run out — is a new key, its predecessor cleared.
//
// Small by design, since the Pilot's database is metered by its egress (#134):
// the raise statements read only the occurrences no alert names yet,
// and the clear statement only the open rule alerts whose condition no longer
// holds, each with the few columns an alert or a resolution needs, so a quiet
// tick reads seven empty results. They read across companies as `wms_worker`,
// one after another, since the Pilot's worker pool is two connections the
// other sweeps share; the writes go per company as `wms_api` under
// `withCompany`, only where there is something to raise or resolve. A route
// planned, or a device last heard from, more than `RULE_LOOKBACK_HOURS` ago
// is history and raises nothing; a paused session is not silent. The cadence
// is `WORKER_RULES_INTERVAL_SECONDS` (apps/pilot/README.md), five minutes
// unless set, and a missed occurrence is skipped: the next tick reads the
// same.
//
// O8 of #290 added the fifth, `position-stale`: a running, unpaused session
// on an active route whose device was heard from within the silence window —
// a device not heard from at all is `session-silent`'s — and whose newest
// position, or its start or its last resume where none is newer, is ten
// minutes old (`POSITION_STALE_MINUTES`). Its key is
// `position-stale:<session>:<newest fix>` (`:none` before the first), so a
// fix that comes in clears it and a later silence of the position is a new
// occurrence. Once raised it stands while the position does, whether or not
// the device goes silent too, and clears on a fix, a pause, or the session's
// or the route's end. The newest fix is one probe into
// `session_position_session_id_idx`, the last resume one into the session's
// receipts, read only for the sessions running.
//
// O26 of #290 added the sixth, `fill-threshold`: a Sensor Pairing in force
// today on the project's clock whose newest Fill Reading, within the
// lookback, is at or past the pairing's full threshold. Its key is
// `fill-threshold:<pairing>:<newest reading below the threshold>` (`:none`
// before the first), so one filling is one alert however many full readings
// follow, and the bin read low again and filling once more is a new
// occurrence. It clears when the newest reading is below the threshold — the
// container emptied, or the threshold raised — or the pairing is no longer in
// force. Both readings are probes into `fill_reading_pairing_id_idx`.
// Where the pairing books an emptying (`books_emptying`), the raise also
// books the office's emptying of the container in the same
// transaction (@waste/db/commands/fill-emptying), and the alert ends with
// what that came to; a tick that overlaps finds the stop booked already.
//
// M17 of #293 added the disposal-site reconciliation (row 28.4), four rules
// over the transfer stations' Outbound Loads and the routes' Unloads:
//   `load-not-received:<load>`: a load still `departed` `LOAD_RECEIPT_HOURS`
//   after it left. A status, not news, so no lookback: a load left unreceived
//   for a week is still to be told of. It clears once the receiving site's
//   ticket is recorded or the load is cancelled.
//   `load-weight-mismatch:<load>:<ticket>:<net>`: a `received` load whose
//   receiving site's net differs from our out-weighing beyond the project's
//   tolerance, judged on the kilograms as the domain's `receiptReading` is.
//   A corrected receipt is a new occurrence; the alert clears once the office
//   reconciles or disputes the load, or the receipt comes within tolerance.
//   `load-overweight:<load>`: a load on our vehicle heavier than the vehicle's
//   rated payload, where it has one, departed within the lookback. It clears
//   if the load is cancelled or the payload corrected.
//   `route-not-tipped:<route>`: a route completed within the lookback and at
//   least `ROUTE_TIP_GRACE_HOURS` ago that planned an Unloading Station and
//   collected at least one stop, with no Unload recorded on it, refused or
//   accepted. It clears once one is. A route with no planned station is not
//   judged: nothing says it was to tip.
// Each is about its load, or its route, and our vehicle and driver where there
// are any (@waste/domain/resolution/alert-rules).
import { routeLabel } from "@waste/contracts/execution"
import { ticketLabel } from "@waste/contracts/resolution"
import { bookFillEmptying, fillEmptyingNote } from "@waste/db/commands/fill-emptying"
import { alert } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { alertOfRule, CLEARED_NOTES, LICENCE_WARNING_DAYS, LOAD_RECEIPT_HOURS, POSITION_STALE_MINUTES, ROUTE_START_GRACE_MINUTES, ROUTE_TIP_GRACE_HOURS, RULE_LOOKBACK_HOURS, SESSION_SILENCE_MINUTES, type RuleOccurrence } from "@waste/domain/resolution/alert-rules"
import { ALERT_RULES, OPEN_TICKET_STATUSES, type AlertRule } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm"

import { cronEvery } from "../cadence"
import { defineJob, type JobContext } from "./definition"

export const ALERT_RULES_QUEUE = "resolution.alert-rules"
/** The cadence unless `WORKER_RULES_INTERVAL_SECONDS` says otherwise: five minutes. */
export const ALERT_RULES_INTERVAL_SECONDS = 300

/** The rules' cron at an even cadence in seconds (cadence.ts; the environment refuses any other). */
export const rulesSchedule = (seconds: number = ALERT_RULES_INTERVAL_SECONDS): string => cronEvery(seconds)

export type AlertRulesData = {
  /** Where the tick came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

/** One occurrence to raise, with the company and project its alert is of, and, for a filling whose pairing books one, the emptying to book on the project's today. */
export type RaisedOccurrence = { companyId: string; projectId: string; ruleKey: string; occurrence: RuleOccurrence; books?: { containerId: string; today: string; note: string } }
/** One rule alert to resolve. */
export type ClearedAlert = { companyId: string; alertId: string; rule: AlertRule }

const OPEN_TICKETS = sql.join(
  OPEN_TICKET_STATUSES.map((status) => sql`${status}`),
  sql`, `,
)

/** An instant as a key spells it: UTC, to the microsecond, as Postgres holds it. */
const keyInstant = (column: SQL) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** A session's newest fix, one backward probe into its track's index. */
const NEWEST_FIX = sql`(select max(sp.fixed_at) from wms.session_position sp where sp.company_id = s.company_id and sp.session_id = s.id)`
/** When the session last resumed, from its receipts; null where it never paused. */
const LAST_RESUME = sql`(select max(dc.occurred_at) from wms.driver_command dc where dc.company_id = s.company_id and dc.session_id = s.id and dc.kind = 'resume' and dc.outcome = 'applied')`

/** A pairing's newest reading's fill, one backward probe into its index. */
const NEWEST_FILL = sql`(select fr.fill_percent from wms.fill_reading fr where fr.company_id = sp.company_id and fr.pairing_id = sp.id order by fr.measured_at desc limit 1)`
/** When that newest reading was measured. */
const NEWEST_MEASURED = sql`(select max(fr.measured_at) from wms.fill_reading fr where fr.company_id = sp.company_id and fr.pairing_id = sp.id)`
/** The pairing's newest reading below its threshold: the last time the bin read low, which keys a filling. */
const LAST_LOW = sql`(select fr.id::text from wms.fill_reading fr where fr.company_id = sp.company_id and fr.pairing_id = sp.id and fr.fill_percent < sp.full_threshold_percent order by fr.measured_at desc limit 1)`
/** A pairing in force on the project's today. */
const pairingInForce = (now: SQL) => sql`sp.valid_from <= (${now} at time zone p.timezone)::date and (sp.valid_to is null or sp.valid_to > (${now} at time zone p.timezone)::date)`

/** A received load whose receiving site's net differs from ours beyond its project's tolerance, on the kilograms: the domain's `receiptReading` as SQL. */
const BEYOND_TOLERANCE = sql`abs(ol.received_net_kg - ol.net_kg) * 100 > p.weight_tolerance_percent * ol.net_kg`
/** A load over its vehicle's rated payload, where the vehicle has one. */
const OVER_PAYLOAD = sql`v.capacity_kg is not null and ol.net_kg > v.capacity_kg`
/** A route that collected something and has no unload recorded, refused or accepted. */
const UNTIPPED = sql`exists (select 1 from wms.pickup pk where pk.company_id = r.company_id and pk.route_id = r.id and pk.status = 'completed')
       and not exists (select 1 from wms.unload u where u.company_id = r.company_id and u.route_id = r.id)`

/** Each rule's key at the tick's instant, spelled once for the raise and the clear. */
const keysAt = (now: SQL) => ({
  /** The route and its planned day and start: a route moved is a new occurrence. */
  route: sql`'route-not-started:' || r.id || ':' || to_char(r.operating_date, 'YYYY-MM-DD') || 'T' || to_char(r.planned_start_time, 'HH24:MI')`,
  session: sql`'session-silent:' || s.id || ':' || ${keyInstant(sql`s.last_seen_at`)}`,
  /** The expiry, and `:expired` once the project's today is past it: a licence that runs out while warned of is a second, graver occurrence, and its warning clears. */
  licence: sql`'licence-expiring:' || d.id || ':' || to_char(d.licence_expiry, 'YYYY-MM-DD') || case when d.licence_expiry < (${now} at time zone p.timezone)::date then ':expired' else '' end`,
  ticket: sql`'ticket-overdue:' || t.id || ':' || ${keyInstant(sql`t.due_at`)}`,
  /** The session and its newest fix: a fix that comes in is a new occurrence, its predecessor cleared. */
  position: sql`'position-stale:' || s.id || ':' || coalesce(${keyInstant(NEWEST_FIX)}, 'none')`,
  /** The pairing and the last reading below its threshold: the bin read low and filling again is a new occurrence. */
  fill: sql`'fill-threshold:' || sp.id || ':' || coalesce(${LAST_LOW}, 'none')`,
  /** The load: once per load, whatever the ticks between. */
  unreceived: sql`'load-not-received:' || ol.id`,
  /** The load and its receipt: a corrected receipt is a new occurrence. */
  mismatch: sql`'load-weight-mismatch:' || ol.id || ':' || ol.receiving_ticket || ':' || ol.received_net_kg`,
  overweight: sql`'load-overweight:' || ol.id`,
  untipped: sql`'route-not-tipped:' || r.id`,
})

/** An alert that holds its key: any but one the worker itself cleared — `alert_rule_key_idx`'s predicate. */
const HOLDS_ITS_KEY = sql`(a.status <> 'resolved' or a.resolved_by is not null)`

const noAlertWith = (key: SQL, companyColumn: SQL) => sql`not exists (select 1 from wms.alert a where a.company_id = ${companyColumn} and a.rule_key = ${key} and ${HOLDS_ITS_KEY})`

/** The occurrences no alert names yet, across companies, as the worker role: each with what its alert says. */
export async function occurrencesToRaise(worker: JobContext["worker"], at: Date): Promise<RaisedOccurrence[]> {
  const now = sql`${at.toISOString()}::timestamptz`
  const KEYS = keysAt(now)
  const lookback = sql`${now} - make_interval(hours => ${RULE_LOOKBACK_HOURS})`

  const routes = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; route_id: string; number: number; operating_date: string; planned_start: string; driver_id: string | null; vehicle_id: string | null }>(sql`
    select r.company_id, r.project_id, ${KEYS.route} as rule_key, r.id as route_id, r.number,
           to_char(r.operating_date, 'YYYY-MM-DD') as operating_date, to_char(r.planned_start_time, 'HH24:MI') as planned_start,
           r.planned_driver_id as driver_id, r.planned_vehicle_id as vehicle_id
      from wms.route r
      join wms.project p on p.company_id = r.company_id and p.id = r.project_id
     where r.status in ('planned', 'ready')
       and r.planned_start_time is not null
       -- the days the lookback can reach on any clock, so the horizon's planned routes are not each given a start to compute
       and r.operating_date between (${now} at time zone 'UTC')::date - 2 and (${now} at time zone 'UTC')::date + 1
       and ((r.operating_date + r.planned_start_time) at time zone p.timezone) + make_interval(mins => ${ROUTE_START_GRACE_MINUTES}) <= ${now}
       and ((r.operating_date + r.planned_start_time) at time zone p.timezone) > ${lookback}
       and ${noAlertWith(KEYS.route, sql`r.company_id`)}
  `)
  const sessions = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; route_id: string; number: number; driver_id: string; driver_name: string; vehicle_id: string; last_seen: string }>(sql`
    select s.company_id, s.project_id, ${KEYS.session} as rule_key, s.route_id, r.number, s.driver_id, d.name as driver_name, s.vehicle_id,
           to_char(s.last_seen_at at time zone p.timezone, 'HH24:MI') as last_seen
      from wms.session s
      join wms.route r on r.company_id = s.company_id and r.id = s.route_id
      join wms.driver d on d.company_id = s.company_id and d.id = s.driver_id
      join wms.project p on p.company_id = s.company_id and p.id = s.project_id
     where s.ended_at is null
       and s.paused_at is null
       and r.status = 'active'
       and s.last_seen_at <= ${now} - make_interval(mins => ${SESSION_SILENCE_MINUTES})
       and s.last_seen_at > ${lookback}
       and ${noAlertWith(KEYS.session, sql`s.company_id`)}
  `)
  const positions = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; route_id: string; number: number; driver_id: string; driver_name: string; vehicle_id: string; last_fix: string | null }>(sql`
    select s.company_id, s.project_id, ${KEYS.position} as rule_key, s.route_id, r.number, s.driver_id, d.name as driver_name, s.vehicle_id,
           to_char(${NEWEST_FIX} at time zone p.timezone, 'HH24:MI') as last_fix
      from wms.session s
      join wms.route r on r.company_id = s.company_id and r.id = s.route_id
      join wms.driver d on d.company_id = s.company_id and d.id = s.driver_id
      join wms.project p on p.company_id = s.company_id and p.id = s.project_id
     where s.ended_at is null
       and s.paused_at is null
       and r.status = 'active'
       -- heard from: a device not heard from at all is the silent session's alert
       and s.last_seen_at > ${now} - make_interval(mins => ${SESSION_SILENCE_MINUTES})
       and greatest(${NEWEST_FIX}, s.started_at, ${LAST_RESUME}) <= ${now} - make_interval(mins => ${POSITION_STALE_MINUTES})
       and ${noAlertWith(KEYS.position, sql`s.company_id`)}
  `)
  const licences = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; driver_id: string; driver_name: string; licence_expiry: string; today: string }>(sql`
    select d.company_id, d.project_id, ${KEYS.licence} as rule_key, d.id as driver_id, d.name as driver_name,
           to_char(d.licence_expiry, 'YYYY-MM-DD') as licence_expiry, to_char((${now} at time zone p.timezone)::date, 'YYYY-MM-DD') as today
      from wms.driver d
      join wms.project p on p.company_id = d.company_id and p.id = d.project_id
     where d.status = 'active'
       and d.licence_expiry is not null
       and d.licence_expiry <= (${now} at time zone p.timezone)::date + ${LICENCE_WARNING_DAYS}::int
       and ${noAlertWith(KEYS.licence, sql`d.company_id`)}
  `)
  const tickets = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; ticket_id: string; number: number; subject: string; due: string }>(sql`
    select t.company_id, t.project_id, ${KEYS.ticket} as rule_key, t.id as ticket_id, t.number, t.subject,
           to_char(t.due_at at time zone p.timezone, 'YYYY-MM-DD HH24:MI') as due
      from wms.ticket t
      join wms.project p on p.company_id = t.company_id and p.id = t.project_id
     where t.status in (${OPEN_TICKETS})
       and t.due_at < ${now}
       and ${noAlertWith(KEYS.ticket, sql`t.company_id`)}
  `)

  const fills = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; container_id: string; label: string; identifier: string; fill_percent: number; threshold: number; measured_at: string; books_emptying: boolean; today: string }>(sql`
    select sp.company_id, sp.project_id, ${KEYS.fill} as rule_key, sp.container_id, c.label, se.identifier,
           ${NEWEST_FILL} as fill_percent, sp.full_threshold_percent as threshold,
           to_char(${NEWEST_MEASURED} at time zone p.timezone, 'YYYY-MM-DD HH24:MI') as measured_at,
           sp.books_emptying, to_char((${now} at time zone p.timezone)::date, 'YYYY-MM-DD') as today
      from wms.sensor_pairing sp
      join wms.sensor se on se.company_id = sp.company_id and se.id = sp.sensor_id
      join wms.container c on c.company_id = sp.company_id and c.id = sp.container_id
      join wms.project p on p.company_id = sp.company_id and p.id = sp.project_id
     where ${pairingInForce(now)}
       and ${NEWEST_FILL} >= sp.full_threshold_percent
       and ${NEWEST_MEASURED} > ${lookback}
       and ${noAlertWith(KEYS.fill, sql`sp.company_id`)}
  `)

  const unreceived = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; load_id: string; vehicle_id: string | null; registration: string; from_station: string; to_station: string; departed_at: string }>(sql`
    select ol.company_id, ol.project_id, ${KEYS.unreceived} as rule_key, ol.id as load_id, ol.vehicle_id, ol.vehicle_registration as registration,
           fs.name as from_station, ts.name as to_station, to_char(ol.departed_at at time zone p.timezone, 'YYYY-MM-DD HH24:MI') as departed_at
      from wms.outbound_load ol
      join wms.unloading_station fs on fs.company_id = ol.company_id and fs.id = ol.from_station_id
      join wms.unloading_station ts on ts.company_id = ol.company_id and ts.id = ol.to_station_id
      join wms.project p on p.company_id = ol.company_id and p.id = ol.project_id
     where ol.status = 'departed'
       and ol.departed_at <= ${now} - make_interval(hours => ${LOAD_RECEIPT_HOURS})
       and ${noAlertWith(KEYS.unreceived, sql`ol.company_id`)}
  `)
  const mismatches = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; load_id: string; vehicle_id: string | null; registration: string; to_station: string; ticket: string; net_kg: number; received_net_kg: number; tolerance: number }>(sql`
    select ol.company_id, ol.project_id, ${KEYS.mismatch} as rule_key, ol.id as load_id, ol.vehicle_id, ol.vehicle_registration as registration,
           ts.name as to_station, ol.receiving_ticket as ticket, ol.net_kg, ol.received_net_kg, p.weight_tolerance_percent as tolerance
      from wms.outbound_load ol
      join wms.unloading_station ts on ts.company_id = ol.company_id and ts.id = ol.to_station_id
      join wms.project p on p.company_id = ol.company_id and p.id = ol.project_id
     where ol.status = 'received'
       and ${BEYOND_TOLERANCE}
       and ${noAlertWith(KEYS.mismatch, sql`ol.company_id`)}
  `)
  const overweights = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; load_id: string; vehicle_id: string; registration: string; net_kg: number; capacity_kg: number }>(sql`
    select ol.company_id, ol.project_id, ${KEYS.overweight} as rule_key, ol.id as load_id, ol.vehicle_id, ol.vehicle_registration as registration, ol.net_kg, v.capacity_kg
      from wms.outbound_load ol
      join wms.vehicle v on v.company_id = ol.company_id and v.id = ol.vehicle_id
     where ol.status <> 'cancelled'
       and ${OVER_PAYLOAD}
       and ol.departed_at > ${lookback}
       and ${noAlertWith(KEYS.overweight, sql`ol.company_id`)}
  `)
  const untipped = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; route_id: string; number: number; operating_date: string; station: string; driver_id: string | null; vehicle_id: string | null }>(sql`
    select r.company_id, r.project_id, ${KEYS.untipped} as rule_key, r.id as route_id, r.number, to_char(r.operating_date, 'YYYY-MM-DD') as operating_date,
           us.name as station, coalesce(r.actual_driver_id, r.planned_driver_id) as driver_id, coalesce(r.actual_vehicle_id, r.planned_vehicle_id) as vehicle_id
      from wms.route r
      join wms.unloading_station us on us.company_id = r.company_id and us.id = r.unloading_station_id
     where r.status = 'completed'
       and r.completed_at <= ${now} - make_interval(hours => ${ROUTE_TIP_GRACE_HOURS})
       and r.completed_at > ${lookback}
       and ${UNTIPPED}
       and ${noAlertWith(KEYS.untipped, sql`r.company_id`)}
  `)

  const of = (row: { company_id: string; project_id: string; rule_key: string }) => ({ companyId: row.company_id, projectId: row.project_id, ruleKey: row.rule_key })
  return [
    ...routes.map((row) => ({ ...of(row), occurrence: { rule: "route-not-started" as const, routeId: row.route_id, routeLabel: routeLabel(Number(row.number)), operatingDate: row.operating_date, plannedStart: row.planned_start, driverId: row.driver_id, vehicleId: row.vehicle_id } })),
    ...sessions.map((row) => ({ ...of(row), occurrence: { rule: "session-silent" as const, routeId: row.route_id, routeLabel: routeLabel(Number(row.number)), driverId: row.driver_id, driverName: row.driver_name, vehicleId: row.vehicle_id, lastSeen: row.last_seen } })),
    ...positions.map((row) => ({ ...of(row), occurrence: { rule: "position-stale" as const, routeId: row.route_id, routeLabel: routeLabel(Number(row.number)), driverId: row.driver_id, driverName: row.driver_name, vehicleId: row.vehicle_id, lastFix: row.last_fix } })),
    ...licences.map((row) => ({ ...of(row), occurrence: { rule: "licence-expiring" as const, driverId: row.driver_id, driverName: row.driver_name, licenceExpiry: row.licence_expiry, today: row.today } })),
    ...tickets.map((row) => ({ ...of(row), occurrence: { rule: "ticket-overdue" as const, ticketId: row.ticket_id, ticketLabel: ticketLabel(Number(row.number)), subject: row.subject, due: row.due } })),
    ...fills.map((row) => ({
      ...of(row),
      occurrence: { rule: "fill-threshold" as const, containerId: row.container_id, containerLabel: row.label, sensorIdentifier: row.identifier, fillPercent: Number(row.fill_percent), thresholdPercent: Number(row.threshold), measuredAt: row.measured_at },
      ...(row.books_emptying ? { books: { containerId: row.container_id, today: row.today, note: fillEmptyingNote(row.identifier, Number(row.fill_percent), row.measured_at) } } : {}),
    })),
    ...unreceived.map((row) => ({
      ...of(row),
      occurrence: { rule: "load-not-received" as const, outboundLoadId: row.load_id, vehicleId: row.vehicle_id, registration: row.registration, fromStation: row.from_station, toStation: row.to_station, departedAt: row.departed_at },
    })),
    ...mismatches.map((row) => ({
      ...of(row),
      occurrence: {
        rule: "load-weight-mismatch" as const,
        outboundLoadId: row.load_id,
        vehicleId: row.vehicle_id,
        registration: row.registration,
        toStation: row.to_station,
        ticket: row.ticket,
        netKg: Number(row.net_kg),
        receivedNetKg: Number(row.received_net_kg),
        tolerancePercent: Number(row.tolerance),
      },
    })),
    ...overweights.map((row) => ({ ...of(row), occurrence: { rule: "load-overweight" as const, outboundLoadId: row.load_id, vehicleId: row.vehicle_id, registration: row.registration, netKg: Number(row.net_kg), capacityKg: Number(row.capacity_kg) } })),
    ...untipped.map((row) => ({
      ...of(row),
      occurrence: { rule: "route-not-tipped" as const, routeId: row.route_id, routeLabel: routeLabel(Number(row.number)), operatingDate: row.operating_date, station: row.station, driverId: row.driver_id, vehicleId: row.vehicle_id },
    })),
  ]
}

/**
 * The rules' open alerts whose occurrence no longer holds, across companies,
 * as the worker role: the subject, found by its id, no longer spells the
 * alert's key — a route started, moved or cancelled; a device heard from or
 * its session or route ended; a licence renewed or run out, or its driver no
 * longer active; a ticket closed or re-dated; a container read below its
 * threshold, or its pairing ended — or its condition has passed.
 */
export async function alertsToClear(worker: JobContext["worker"], at: Date): Promise<ClearedAlert[]> {
  const now = sql`${at.toISOString()}::timestamptz`
  const KEYS = keysAt(now)
  const rows = await worker.db.execute<{ company_id: string; id: string; rule: AlertRule }>(sql`
    select a.company_id, a.id, a.rule
      from wms.alert a
     where a.rule_key is not null
       and a.status <> 'resolved'
       and case a.rule
         when 'route-not-started' then not exists (
           select 1 from wms.route r
            where r.company_id = a.company_id and r.id = a.route_id and a.rule_key = ${KEYS.route} and r.status in ('planned', 'ready'))
         when 'session-silent' then not exists (
           select 1 from wms.session s join wms.route r on r.company_id = s.company_id and r.id = s.route_id
            where s.company_id = a.company_id and s.route_id = a.route_id and s.driver_id = a.driver_id and a.rule_key = ${KEYS.session}
              and s.ended_at is null and s.paused_at is null and r.status = 'active')
         when 'licence-expiring' then not exists (
           select 1 from wms.driver d join wms.project p on p.company_id = d.company_id and p.id = d.project_id
            where d.company_id = a.company_id and d.id = a.driver_id and a.rule_key = ${KEYS.licence} and d.status = 'active'
              and d.licence_expiry <= (${now} at time zone p.timezone)::date + ${LICENCE_WARNING_DAYS}::int)
         when 'position-stale' then not exists (
           select 1 from wms.session s join wms.route r on r.company_id = s.company_id and r.id = s.route_id
            where s.company_id = a.company_id and s.route_id = a.route_id and s.driver_id = a.driver_id and a.rule_key = ${KEYS.position}
              and s.ended_at is null and s.paused_at is null and r.status = 'active')
         when 'fill-threshold' then not exists (
           select 1 from wms.sensor_pairing sp join wms.project p on p.company_id = sp.company_id and p.id = sp.project_id
            where sp.company_id = a.company_id and sp.container_id = a.container_id and a.rule_key = ${KEYS.fill}
              and ${pairingInForce(now)} and ${NEWEST_FILL} >= sp.full_threshold_percent)
         when 'load-not-received' then not exists (
           select 1 from wms.outbound_load ol
            where ol.company_id = a.company_id and ol.id = a.outbound_load_id and a.rule_key = ${KEYS.unreceived} and ol.status = 'departed')
         when 'load-weight-mismatch' then not exists (
           select 1 from wms.outbound_load ol join wms.project p on p.company_id = ol.company_id and p.id = ol.project_id
            where ol.company_id = a.company_id and ol.id = a.outbound_load_id and a.rule_key = ${KEYS.mismatch} and ol.status = 'received' and ${BEYOND_TOLERANCE})
         when 'load-overweight' then not exists (
           select 1 from wms.outbound_load ol join wms.vehicle v on v.company_id = ol.company_id and v.id = ol.vehicle_id
            where ol.company_id = a.company_id and ol.id = a.outbound_load_id and a.rule_key = ${KEYS.overweight} and ol.status <> 'cancelled' and ${OVER_PAYLOAD})
         when 'route-not-tipped' then not exists (
           select 1 from wms.route r
            where r.company_id = a.company_id and r.id = a.route_id and a.rule_key = ${KEYS.untipped} and ${UNTIPPED})
         when 'ticket-overdue' then not exists (
           select 1 from wms.ticket t
            where t.company_id = a.company_id and t.id = a.ticket_id and a.rule_key = ${KEYS.ticket} and t.status in (${OPEN_TICKETS}) and t.due_at < ${now})
         else false
       end
  `)
  return rows.map((row) => ({ companyId: row.company_id, alertId: row.id, rule: row.rule }))
}

/** What a tick came to. */
export type AlertRulesOutcome = { raised: number; cleared: number }

const byCompany = <T extends { companyId: string }>(items: readonly T[]): Map<string, T[]> => {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const group = grouped.get(item.companyId)
    if (group === undefined) grouped.set(item.companyId, [item])
    else group.push(item)
  }
  return grouped
}

/** The note a cleared alert is resolved with, by its rule, in one statement. */
const clearedNote = sql.join(
  [sql`case ${alert.rule}`, ...ALERT_RULES.map((rule) => sql`when ${rule} then ${CLEARED_NOTES[rule]}`), sql`end`],
  sql` `,
)

export async function runAlertRules({ api, worker, now, log }: JobContext): Promise<AlertRulesOutcome> {
  const at = now()
  const toRaise = await occurrencesToRaise(worker, at)
  const toClear = await alertsToClear(worker, at)
  let raised = 0
  for (const [companyId, occurrences] of byCompany(toRaise)) {
    const rows = await withCompany(api.db, companyId, async (tx) => {
      // A filling whose pairing books one has its emptying booked first, so its alert can say what that came to.
      const told: RuleOccurrence[] = []
      for (const { projectId, occurrence, books } of occurrences) {
        told.push(books === undefined || occurrence.rule !== "fill-threshold" ? occurrence : { ...occurrence, emptying: await bookFillEmptying(tx, { companyId, projectId }, books.containerId, books.today, books.note) })
      }
      return await tx
        .insert(alert)
        .values(
          occurrences.map(({ projectId, ruleKey }, index) => {
            const occurrence = told[index]!
            const { rule, kind, severity, source, title, details, routeId, vehicleId, driverId, containerId, ticketId, outboundLoadId } = alertOfRule(occurrence)
            return { companyId, projectId, rule, ruleKey, kind, severity, source, title, details, detectedAt: at, routeId, vehicleId, driverId, containerId, ticketId, outboundLoadId, raisedBy: null }
          }),
        )
        // A tick that overlapped this one raised the occurrence already: the key is its word.
        .onConflictDoNothing({ target: [alert.companyId, alert.ruleKey], where: sql`${alert.ruleKey} is not null and (${alert.status} <> 'resolved' or ${alert.resolvedBy} is not null)` })
        .returning({ id: alert.id })
    })
    raised += rows.length
  }
  let cleared = 0
  for (const [companyId, alerts] of byCompany(toClear)) {
    const rows = await withCompany(api.db, companyId, (tx) =>
      tx
        .update(alert)
        .set({ status: "resolved", resolvedAt: at, resolvedBy: null, resolutionNote: clearedNote })
        .where(
          and(
            eq(alert.companyId, companyId),
            inArray(
              alert.id,
              alerts.map((cleared) => cleared.alertId),
            ),
            ne(alert.status, "resolved"),
          ),
        )
        .returning({ id: alert.id }),
    )
    cleared += rows.length
  }
  if (raised > 0 || cleared > 0) log(`alert rules: raised ${raised}, cleared ${cleared}`)
  return { raised, cleared }
}

export const alertRulesJob = defineJob<AlertRulesData>({
  queue: ALERT_RULES_QUEUE,
  description:
    "Raises the alerts the worker's rules find — a route not started, a device silent, a licence running out, a ticket overdue, a position stale, a container filled past its threshold, an outbound load not received, weighed beyond the tolerance or over its vehicle's payload, a route that never tipped — and resolves those whose condition has cleared (O4, O8 and O26 of #290, M17 of #293).",
  handler: async (_jobs, context) => await runAlertRules(context),
  schedule: rulesSchedule(),
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "skip" },
  // No retry: the next tick is the retry, reading the same.
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 86_400 },
})
