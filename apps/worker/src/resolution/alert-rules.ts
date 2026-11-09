// The worker's alert rules (O4 of #290): every few minutes, across companies,
// the four conditions — eleven since O8, O26, O20 and M17, below — the office should hear of without anyone raising them
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
// tick reads twelve empty results. They read across companies as `wms_worker`,
// one after another, since the Pilot's worker pool is two connections the
// other sweeps share; the writes go per company as `wms_api` under
// `withCompany`, only where there is something to raise or resolve. A route
// planned, or a device last heard from, more than `RULE_LOOKBACK_HOURS` ago
// is history and raises nothing; a paused session is not silent. A tick runs
// every five minutes, and a missed occurrence is skipped: the next tick reads
// the same.
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
// Each alert raised writes `alert-raised` to the outbox in the raise's
// transaction (O16 of #290), the `Alert` as the API would answer it, so the
// staff notices' consumer tells the people who asked to hear of an alert that
// severe; an alert the key already held writes neither row nor event.
//
// O20 of #290 added the seventh, `maintenance-due`: an active maintenance plan
// of a vehicle not retired that is within its margins of a limit — fourteen
// days, a thousand kilometres, fifty engine hours — or past one, judged as
// @waste/domain/resources/maintenance judges it: on its project's today, and
// against the last service's odometer and engine hours, since nothing reads
// a vehicle's between services (`duePlans`). Its key is
// `maintenance-due:<plan>:<last service's day>/<km>/<hours>` (`-` for a reading
// the plan has none of), `:overdue` once past a limit: a service done moves
// the baseline and clears it, a plan retired or relieved by a patch clears
// it, and running from due soon to overdue is a second, graver occurrence,
// the first cleared, as a licence's expiry is.
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
import { routeLabel, ticketLabel } from "@waste/domain/numbering"
import type { Database } from "@waste/db/client"
import { bookFillEmptying, fillEmptyingNote } from "@waste/db/commands/fill-emptying"
import { raiseAlerts } from "@waste/db/commands/alerts"
import { maintenanceDueState, nextDue } from "@waste/db/query/maintenance-due"
import { dayOnClock, instantAt, instantOnClock, shownOnClock, timeOnClock, utcInstantText } from "@waste/db/query/project-clock"
import { alert, holdsItsRuleKey } from "@waste/db/schema/resolution"
import { vehicleLabelOf } from "@waste/db/shapes/vehicles"
import { withCompany } from "@waste/db/tenant"
import { alertOfRule, CLEARED_NOTES, LICENCE_WARNING_DAYS, LOAD_RECEIPT_HOURS, POSITION_STALE_MINUTES, ROUTE_START_GRACE_MINUTES, ROUTE_TIP_GRACE_HOURS, RULE_LOOKBACK_HOURS, SESSION_SILENCE_MINUTES, type RuleOccurrence } from "@waste/domain/resolution/alert-rules"
import { ALERT_RULES, OPEN_TICKET_STATUSES, type AlertRule } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm"

import { defineJob, type JobContext } from "../runtime/definition"

export const ALERT_RULES_QUEUE = "resolution.alert-rules"
export const ALERT_RULES_SCHEDULE = "*/5 * * * *"

export type AlertRulesData = {
  source: "schedule" | "manual"
}

/** One occurrence to raise, with the company and project its alert is of, and, for a filling whose pairing books one, the emptying to book on the project's today. */
export type RaisedOccurrence = { companyId: string; projectId: string; ruleKey: string; occurrence: RuleOccurrence; books?: { containerId: string; today: string; note: string } }
export type ClearedAlert = { companyId: string; alertId: string; rule: AlertRule }

const OPEN_TICKETS = sql.join(
  OPEN_TICKET_STATUSES.map((status) => sql`${status}`),
  sql`, `,
)

/** The project every rule's statement joins as `p`, whose clock its days and times are read on. */
const PROJECT_ZONE = sql`p.timezone`
const todayOn = (now: SQL) => dayOnClock(now, PROJECT_ZONE)
const PLANNED_START = instantOnClock(sql`r.operating_date`, PROJECT_ZONE, sql`r.planned_start_time`)

/** A session's newest fix, one backward probe into its track's index. */
const NEWEST_FIX = sql`(select max(sp.fixed_at) from wms.session_position sp where sp.company_id = s.company_id and sp.session_id = s.id)`
/** When the session last resumed, from its receipts; null where it never paused. */
const LAST_RESUME = sql`(select max(dc.occurred_at) from wms.driver_command dc where dc.company_id = s.company_id and dc.session_id = s.id and dc.kind = 'resume' and dc.outcome = 'applied')`

/** A pairing's newest reading's fill, one backward probe into its index. */
const NEWEST_FILL = sql`(select fr.fill_percent from wms.fill_reading fr where fr.company_id = sp.company_id and fr.pairing_id = sp.id order by fr.measured_at desc limit 1)`
const NEWEST_MEASURED = sql`(select max(fr.measured_at) from wms.fill_reading fr where fr.company_id = sp.company_id and fr.pairing_id = sp.id)`
/** The pairing's newest reading below its threshold: the last time the bin read low, which keys a filling. */
const LAST_LOW = sql`(select fr.id::text from wms.fill_reading fr where fr.company_id = sp.company_id and fr.pairing_id = sp.id and fr.fill_percent < sp.full_threshold_percent order by fr.measured_at desc limit 1)`
const pairingInForce = (now: SQL) => sql`sp.valid_from <= ${todayOn(now)} and (sp.valid_to is null or sp.valid_to > ${todayOn(now)})`
/** A maintenance plan as `duePlans` names it, and its vehicle. */
const PLAN = {
  intervalDays: sql`m.interval_days`,
  intervalKm: sql`m.interval_km`,
  intervalHours: sql`m.interval_hours`,
  lastDoneOn: sql`m.last_done_on`,
  lastDoneKm: sql`m.last_done_km`,
  lastDoneHours: sql`m.last_done_hours`,
}
const NEXT_DUE = nextDue(PLAN)
const VEHICLE = { registration: sql`v.registration`, callsign: sql`v.callsign` }

/**
 * The active plans of vehicles not retired, each judged at the tick's
 * instant on the last service's readings (@waste/db/query/maintenance-due):
 * its next limits, whether it is past a limit or within the margins of one,
 * and its key. As `mp`.
 */
const duePlans = (now: SQL) => sql`(
  select j.*, j.state = 'overdue' as overdue, j.state <> 'ok' as due,
         'maintenance-due:' || j.plan_id || ':' || to_char(j.last_done_on, 'YYYY-MM-DD') || '/' || coalesce(j.last_done_km::text, '-') || '/' || coalesce(j.last_done_hours::text, '-')
           || case when j.state = 'overdue' then ':overdue' else '' end as rule_key
    from (
      select m.company_id, m.project_id, m.id as plan_id, m.vehicle_id, m.name, ${vehicleLabelOf(VEHICLE)} as vehicle_label,
             m.last_done_on, m.last_done_km, m.last_done_hours,
             ${NEXT_DUE.on} as next_on, ${NEXT_DUE.km} as next_km, ${NEXT_DUE.hours} as next_hours,
             ${maintenanceDueState(PLAN, todayOn(now))} as state
        from wms.vehicle_maintenance_plan m
        join wms.vehicle v on v.company_id = m.company_id and v.id = m.vehicle_id
        join wms.project p on p.company_id = m.company_id and p.id = m.project_id
       where m.status = 'active' and v.status <> 'retired'
    ) j
) mp`

/** A received load whose receiving site's net differs from ours beyond its project's tolerance, on the kilograms: the domain's `receiptReading` as SQL. */
const BEYOND_TOLERANCE = sql`abs(ol.received_net_kg - ol.net_kg) * 100 > p.weight_tolerance_percent * ol.net_kg`
const OVER_PAYLOAD = sql`v.capacity_kg is not null and ol.net_kg > v.capacity_kg`
const UNTIPPED = sql`exists (select 1 from wms.pickup pk where pk.company_id = r.company_id and pk.route_id = r.id and pk.status = 'completed')
       and not exists (select 1 from wms.unload u where u.company_id = r.company_id and u.route_id = r.id)`

type Keyed = { company_id: string; project_id: string; rule_key: string }

type Told<R extends AlertRule> = Omit<Extract<RuleOccurrence, { rule: R }>, "rule">

/**
 * One rule in SQL. `from` is the subject's rows, with the joins `key` and
 * `holds` read; `company`, `project` and `subjectOf` are how the subject's
 * row names its tenant and project and how an alert `a` names the subject.
 * `holds` is the condition the alert stands on at the tick `now`. The raise
 * reads `raise.joins` beside `from`, takes the rows where `raise.when` makes
 * the condition news, and reads `raise.columns` into what the alert tells.
 */
type RuleSql<R extends AlertRule, Row> = {
  from: (now: SQL) => SQL
  company: SQL
  project: SQL
  subjectOf: SQL
  key: (now: SQL) => SQL
  holds: (now: SQL) => SQL
  raise: {
    joins?: SQL
    when?: (now: SQL, lookback: SQL) => SQL
    columns: (now: SQL) => SQL
    told: (row: Row) => Told<R>
    books?: (row: Row) => RaisedOccurrence["books"]
  }
}

type RuleSweep<R extends AlertRule> = {
  raises: (worker: Database, now: SQL, lookback: SQL) => Promise<{ companyId: string; projectId: string; ruleKey: string; told: Told<R>; books?: RaisedOccurrence["books"] }[]>
  clears: (now: SQL) => SQL
}

/** An alert `a` that holds its key: `alert_rule_key_idx`'s predicate. */
const HOLDS_ITS_KEY = holdsItsRuleKey({ status: sql`a.status`, resolvedBy: sql`a.resolved_by` })

const noAlertWith = (key: SQL, companyColumn: SQL) => sql`not exists (select 1 from wms.alert a where a.company_id = ${companyColumn} and a.rule_key = ${key} and ${HOLDS_ITS_KEY})`

function sweep<R extends AlertRule, Row extends Record<string, unknown>>(rule: RuleSql<R, Row>): RuleSweep<R> {
  const { from, company, project, subjectOf, key, holds, raise } = rule
  return {
    raises: async (worker, now, lookback) => {
      const rows = await worker.db.execute<Keyed & Row>(sql`
        select ${company} as company_id, ${project} as project_id, ${key(now)} as rule_key, ${raise.columns(now)}
          from ${from(now)} ${raise.joins ?? sql``}
         where ${holds(now)}
           and ${raise.when?.(now, lookback) ?? sql`true`}
           and ${noAlertWith(key(now), company)}
      `)
      // The statement's columns are the rule's: `execute` cannot see through a row type the rule names.
      return rows.map((found) => {
        const row = found as Keyed & Row
        const books = raise.books?.(row)
        return { companyId: row.company_id, projectId: row.project_id, ruleKey: row.rule_key, told: raise.told(row), ...(books === undefined ? {} : { books }) }
      })
    },
    clears: (now) => sql`not exists (select 1 from ${from(now)} where ${company} = a.company_id and ${subjectOf} and a.rule_key = ${key(now)} and ${holds(now)})`,
  }
}

const RUNNING_SESSION = {
  from: () => sql`wms.session s join wms.route r on r.company_id = s.company_id and r.id = s.route_id`,
  company: sql`s.company_id`,
  project: sql`s.project_id`,
  subjectOf: sql`s.route_id = a.route_id and s.driver_id = a.driver_id`,
  holds: () => sql`s.ended_at is null and s.paused_at is null and r.status = 'active'`,
}
const SESSION_TOLD = sql`join wms.driver d on d.company_id = s.company_id and d.id = s.driver_id
          join wms.project p on p.company_id = s.company_id and p.id = s.project_id`

const LOAD = {
  company: sql`ol.company_id`,
  project: sql`ol.project_id`,
  subjectOf: sql`ol.id = a.outbound_load_id`,
}

type FillRow = { container_id: string; label: string; identifier: string; fill_percent: number; threshold: number; measured_at: string; books_emptying: boolean; today: string }

const RULES: { [R in AlertRule]: RuleSweep<R> } = {
  "route-not-started": sweep({
    from: () => sql`wms.route r`,
    company: sql`r.company_id`,
    project: sql`r.project_id`,
    subjectOf: sql`r.id = a.route_id`,
    /** The route and its planned day and start: a route moved is a new occurrence. */
    key: () => sql`'route-not-started:' || r.id || ':' || to_char(r.operating_date, 'YYYY-MM-DD') || 'T' || to_char(r.planned_start_time, 'HH24:MI')`,
    holds: () => sql`r.status in ('planned', 'ready')`,
    raise: {
      joins: sql`join wms.project p on p.company_id = r.company_id and p.id = r.project_id`,
      when: (now, lookback) => sql`r.planned_start_time is not null
       -- the days the lookback can reach on any clock, so the horizon's planned routes are not each given a start to compute
       and r.operating_date between (${now} at time zone 'UTC')::date - 2 and (${now} at time zone 'UTC')::date + 1
       and ${PLANNED_START} + make_interval(mins => ${ROUTE_START_GRACE_MINUTES}) <= ${now}
       and ${PLANNED_START} > ${lookback}`,
      columns: () => sql`r.id as route_id, r.number, to_char(r.operating_date, 'YYYY-MM-DD') as operating_date, to_char(r.planned_start_time, 'HH24:MI') as planned_start,
           r.planned_driver_id as driver_id, r.planned_vehicle_id as vehicle_id`,
      told: (row: { route_id: string; number: number; operating_date: string; planned_start: string; driver_id: string | null; vehicle_id: string | null }) => ({
        routeId: row.route_id,
        routeLabel: routeLabel(Number(row.number)),
        operatingDate: row.operating_date,
        plannedStart: row.planned_start,
        driverId: row.driver_id,
        vehicleId: row.vehicle_id,
      }),
    },
  }),
  "session-silent": sweep({
    ...RUNNING_SESSION,
    key: () => sql`'session-silent:' || s.id || ':' || ${utcInstantText(sql`s.last_seen_at`)}`,
    raise: {
      joins: SESSION_TOLD,
      when: (now, lookback) => sql`s.last_seen_at <= ${now} - make_interval(mins => ${SESSION_SILENCE_MINUTES}) and s.last_seen_at > ${lookback}`,
      columns: () => sql`s.route_id, r.number, s.driver_id, d.name as driver_name, s.vehicle_id, ${timeOnClock(sql`s.last_seen_at`, PROJECT_ZONE)} as last_seen`,
      told: (row: { route_id: string; number: number; driver_id: string; driver_name: string; vehicle_id: string; last_seen: string }) => ({
        routeId: row.route_id,
        routeLabel: routeLabel(Number(row.number)),
        driverId: row.driver_id,
        driverName: row.driver_name,
        vehicleId: row.vehicle_id,
        lastSeen: row.last_seen,
      }),
    },
  }),
  "position-stale": sweep({
    ...RUNNING_SESSION,
    /** The session and its newest fix: a fix that comes in is a new occurrence, its predecessor cleared. */
    key: () => sql`'position-stale:' || s.id || ':' || coalesce(${utcInstantText(NEWEST_FIX)}, 'none')`,
    raise: {
      joins: SESSION_TOLD,
      // Heard from: a device not heard from at all is the silent session's alert.
      when: (now) => sql`s.last_seen_at > ${now} - make_interval(mins => ${SESSION_SILENCE_MINUTES})
       and greatest(${NEWEST_FIX}, s.started_at, ${LAST_RESUME}) <= ${now} - make_interval(mins => ${POSITION_STALE_MINUTES})`,
      columns: () => sql`s.route_id, r.number, s.driver_id, d.name as driver_name, s.vehicle_id, ${timeOnClock(NEWEST_FIX, PROJECT_ZONE)} as last_fix`,
      told: (row: { route_id: string; number: number; driver_id: string; driver_name: string; vehicle_id: string; last_fix: string | null }) => ({
        routeId: row.route_id,
        routeLabel: routeLabel(Number(row.number)),
        driverId: row.driver_id,
        driverName: row.driver_name,
        vehicleId: row.vehicle_id,
        lastFix: row.last_fix,
      }),
    },
  }),
  "licence-expiring": sweep({
    from: () => sql`wms.driver d join wms.project p on p.company_id = d.company_id and p.id = d.project_id`,
    company: sql`d.company_id`,
    project: sql`d.project_id`,
    subjectOf: sql`d.id = a.driver_id`,
    /** The expiry, and `:expired` once the project's today is past it: a licence that runs out while warned of is a second, graver occurrence, and its warning clears. */
    key: (now) => sql`'licence-expiring:' || d.id || ':' || to_char(d.licence_expiry, 'YYYY-MM-DD') || case when d.licence_expiry < ${todayOn(now)} then ':expired' else '' end`,
    holds: (now) => sql`d.status = 'active' and d.licence_expiry <= ${todayOn(now)} + ${LICENCE_WARNING_DAYS}::int`,
    raise: {
      columns: (now) => sql`d.id as driver_id, d.name as driver_name, to_char(d.licence_expiry, 'YYYY-MM-DD') as licence_expiry, to_char(${todayOn(now)}, 'YYYY-MM-DD') as today`,
      told: (row: { driver_id: string; driver_name: string; licence_expiry: string; today: string }) => ({ driverId: row.driver_id, driverName: row.driver_name, licenceExpiry: row.licence_expiry, today: row.today }),
    },
  }),
  "ticket-overdue": sweep({
    from: () => sql`wms.ticket t`,
    company: sql`t.company_id`,
    project: sql`t.project_id`,
    subjectOf: sql`t.id = a.ticket_id`,
    key: () => sql`'ticket-overdue:' || t.id || ':' || ${utcInstantText(sql`t.due_at`)}`,
    holds: (now) => sql`t.status in (${OPEN_TICKETS}) and t.due_at < ${now}`,
    raise: {
      joins: sql`join wms.project p on p.company_id = t.company_id and p.id = t.project_id`,
      columns: () => sql`t.id as ticket_id, t.number, t.subject, ${shownOnClock(sql`t.due_at`, PROJECT_ZONE)} as due`,
      told: (row: { ticket_id: string; number: number; subject: string; due: string }) => ({ ticketId: row.ticket_id, ticketLabel: ticketLabel(Number(row.number)), subject: row.subject, due: row.due }),
    },
  }),
  "fill-threshold": sweep({
    from: () => sql`wms.sensor_pairing sp join wms.project p on p.company_id = sp.company_id and p.id = sp.project_id`,
    company: sql`sp.company_id`,
    project: sql`sp.project_id`,
    subjectOf: sql`sp.container_id = a.container_id`,
    /** The pairing and the last reading below its threshold: the bin read low and filling again is a new occurrence. */
    key: () => sql`'fill-threshold:' || sp.id || ':' || coalesce(${LAST_LOW}, 'none')`,
    holds: (now) => sql`${pairingInForce(now)} and ${NEWEST_FILL} >= sp.full_threshold_percent`,
    raise: {
      joins: sql`join wms.sensor se on se.company_id = sp.company_id and se.id = sp.sensor_id
          join wms.container c on c.company_id = sp.company_id and c.id = sp.container_id`,
      when: (_now, lookback) => sql`${NEWEST_MEASURED} > ${lookback}`,
      columns: (now) => sql`sp.container_id, c.label, se.identifier,
           ${NEWEST_FILL} as fill_percent, sp.full_threshold_percent as threshold,
           ${shownOnClock(NEWEST_MEASURED, PROJECT_ZONE)} as measured_at,
           sp.books_emptying, to_char(${todayOn(now)}, 'YYYY-MM-DD') as today`,
      told: (row: FillRow) => ({
        containerId: row.container_id,
        containerLabel: row.label,
        sensorIdentifier: row.identifier,
        fillPercent: Number(row.fill_percent),
        thresholdPercent: Number(row.threshold),
        measuredAt: row.measured_at,
      }),
      books: (row: FillRow) =>
        row.books_emptying ? { containerId: row.container_id, today: row.today, note: fillEmptyingNote(row.identifier, Number(row.fill_percent), row.measured_at) } : undefined,
    },
  }),
  "maintenance-due": sweep({
    from: (now) => duePlans(now),
    company: sql`mp.company_id`,
    project: sql`mp.project_id`,
    subjectOf: sql`mp.plan_id = split_part(a.rule_key, ':', 2)::uuid`,
    key: () => sql`mp.rule_key`,
    holds: () => sql`mp.due`,
    raise: {
      columns: () => sql`mp.vehicle_id, mp.vehicle_label, mp.name, mp.overdue,
           to_char(mp.next_on, 'YYYY-MM-DD') as next_on, mp.next_km, mp.next_hours`,
      told: (row: { vehicle_id: string; vehicle_label: string; name: string; overdue: boolean; next_on: string | null; next_km: number | null; next_hours: number | null }) => ({
        vehicleId: row.vehicle_id,
        vehicleLabel: row.vehicle_label,
        planName: row.name,
        overdue: row.overdue,
        nextDueOn: row.next_on,
        nextDueKm: row.next_km === null ? null : Number(row.next_km),
        nextDueHours: row.next_hours === null ? null : Number(row.next_hours),
      }),
    },
  }),
  "load-not-received": sweep({
    ...LOAD,
    from: () => sql`wms.outbound_load ol`,
    /** The load: once per load, whatever the ticks between. */
    key: () => sql`'load-not-received:' || ol.id`,
    holds: () => sql`ol.status = 'departed'`,
    raise: {
      joins: sql`join wms.unloading_station fs on fs.company_id = ol.company_id and fs.id = ol.from_station_id
          join wms.unloading_station ts on ts.company_id = ol.company_id and ts.id = ol.to_station_id
          join wms.project p on p.company_id = ol.company_id and p.id = ol.project_id`,
      when: (now) => sql`ol.departed_at <= ${now} - make_interval(hours => ${LOAD_RECEIPT_HOURS})`,
      columns: () => sql`ol.id as load_id, ol.vehicle_id, ol.vehicle_registration as registration,
           fs.name as from_station, ts.name as to_station, ${shownOnClock(sql`ol.departed_at`, PROJECT_ZONE)} as departed_at`,
      told: (row: { load_id: string; vehicle_id: string | null; registration: string; from_station: string; to_station: string; departed_at: string }) => ({
        outboundLoadId: row.load_id,
        vehicleId: row.vehicle_id,
        registration: row.registration,
        fromStation: row.from_station,
        toStation: row.to_station,
        departedAt: row.departed_at,
      }),
    },
  }),
  "load-weight-mismatch": sweep({
    ...LOAD,
    from: () => sql`wms.outbound_load ol join wms.project p on p.company_id = ol.company_id and p.id = ol.project_id`,
    /** The load and its receipt: a corrected receipt is a new occurrence. */
    key: () => sql`'load-weight-mismatch:' || ol.id || ':' || ol.receiving_ticket || ':' || ol.received_net_kg`,
    holds: () => sql`ol.status = 'received' and ${BEYOND_TOLERANCE}`,
    raise: {
      joins: sql`join wms.unloading_station ts on ts.company_id = ol.company_id and ts.id = ol.to_station_id`,
      columns: () => sql`ol.id as load_id, ol.vehicle_id, ol.vehicle_registration as registration,
           ts.name as to_station, ol.receiving_ticket as ticket, ol.net_kg, ol.received_net_kg, p.weight_tolerance_percent as tolerance`,
      told: (row: { load_id: string; vehicle_id: string | null; registration: string; to_station: string; ticket: string; net_kg: number; received_net_kg: number; tolerance: number }) => ({
        outboundLoadId: row.load_id,
        vehicleId: row.vehicle_id,
        registration: row.registration,
        toStation: row.to_station,
        ticket: row.ticket,
        netKg: Number(row.net_kg),
        receivedNetKg: Number(row.received_net_kg),
        tolerancePercent: Number(row.tolerance),
      }),
    },
  }),
  "load-overweight": sweep({
    ...LOAD,
    from: () => sql`wms.outbound_load ol join wms.vehicle v on v.company_id = ol.company_id and v.id = ol.vehicle_id`,
    key: () => sql`'load-overweight:' || ol.id`,
    holds: () => sql`ol.status <> 'cancelled' and ${OVER_PAYLOAD}`,
    raise: {
      when: (_now, lookback) => sql`ol.departed_at > ${lookback}`,
      columns: () => sql`ol.id as load_id, ol.vehicle_id, ol.vehicle_registration as registration, ol.net_kg, v.capacity_kg`,
      told: (row: { load_id: string; vehicle_id: string; registration: string; net_kg: number; capacity_kg: number }) => ({
        outboundLoadId: row.load_id,
        vehicleId: row.vehicle_id,
        registration: row.registration,
        netKg: Number(row.net_kg),
        capacityKg: Number(row.capacity_kg),
      }),
    },
  }),
  "route-not-tipped": sweep({
    from: () => sql`wms.route r`,
    company: sql`r.company_id`,
    project: sql`r.project_id`,
    subjectOf: sql`r.id = a.route_id`,
    key: () => sql`'route-not-tipped:' || r.id`,
    holds: () => UNTIPPED,
    raise: {
      joins: sql`join wms.unloading_station us on us.company_id = r.company_id and us.id = r.unloading_station_id`,
      when: (now, lookback) => sql`r.status = 'completed'
       and r.completed_at <= ${now} - make_interval(hours => ${ROUTE_TIP_GRACE_HOURS})
       and r.completed_at > ${lookback}`,
      columns: () => sql`r.id as route_id, r.number, to_char(r.operating_date, 'YYYY-MM-DD') as operating_date,
           us.name as station, coalesce(r.actual_driver_id, r.planned_driver_id) as driver_id, coalesce(r.actual_vehicle_id, r.planned_vehicle_id) as vehicle_id`,
      told: (row: { route_id: string; number: number; operating_date: string; station: string; driver_id: string | null; vehicle_id: string | null }) => ({
        routeId: row.route_id,
        routeLabel: routeLabel(Number(row.number)),
        operatingDate: row.operating_date,
        station: row.station,
        driverId: row.driver_id,
        vehicleId: row.vehicle_id,
      }),
    },
  }),
}

/** The occurrences no alert names yet, across companies, as the worker role: each with what its alert says. */
export async function occurrencesToRaise(worker: JobContext["worker"], at: Date): Promise<RaisedOccurrence[]> {
  const now = instantAt(at)
  const lookback = sql`${now} - make_interval(hours => ${RULE_LOOKBACK_HOURS})`
  const raised: RaisedOccurrence[] = []
  for (const rule of Object.keys(RULES) as AlertRule[]) {
    for (const { told, ...found } of await RULES[rule].raises(worker, now, lookback)) raised.push({ ...found, occurrence: { rule, ...told } as RuleOccurrence })
  }
  return raised
}

/**
 * The rules' open alerts whose occurrence no longer holds, across companies,
 * as the worker role: the subject, found by the alert's columns, no longer
 * spells the alert's key — a route started, moved or cancelled; a device
 * heard from or its session or route ended; a licence renewed or run out, or
 * its driver no longer active; a ticket closed or re-dated; a container read
 * below its threshold, or its pairing ended; a plan serviced, retired or run
 * overdue — or its condition has passed.
 */
export async function alertsToClear(worker: JobContext["worker"], at: Date): Promise<ClearedAlert[]> {
  const now = instantAt(at)
  const rows = await worker.db.execute<{ company_id: string; id: string; rule: AlertRule }>(sql`
    select a.company_id, a.id, a.rule
      from wms.alert a
     where a.rule_key is not null
       and a.status <> 'resolved'
       and case a.rule
         ${sql.join(
           (Object.keys(RULES) as AlertRule[]).map((rule) => sql`when ${rule} then ${RULES[rule].clears(now)}`),
           sql`
         `,
         )}
         else false
       end
  `)
  return rows.map((row) => ({ companyId: row.company_id, alertId: row.id, rule: row.rule }))
}

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
      const told: RuleOccurrence[] = []
      for (const { projectId, occurrence, books } of occurrences) {
        told.push(books === undefined || occurrence.rule !== "fill-threshold" ? occurrence : { ...occurrence, emptying: await bookFillEmptying(tx, { companyId, projectId }, books.containerId, books.today, books.note) })
      }
      // A tick that overlapped this one raised the occurrence already: the key is its word.
      return await raiseAlerts(
        tx,
        companyId,
        occurrences.map(({ projectId, ruleKey }, index) => {
          const { rule, kind, severity, source, title, details, routeId, vehicleId, driverId, containerId, ticketId, outboundLoadId } = alertOfRule(told[index]!)
          return { projectId, rule, ruleKey, kind, severity, source, title, details, detectedAt: at, routeId, vehicleId, driverId, containerId, ticketId, outboundLoadId, raisedBy: null }
        }),
      )
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
  schedule: ALERT_RULES_SCHEDULE,
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "skip" },
  // No retry: the next tick is the retry, reading the same.
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 86_400 },
})
