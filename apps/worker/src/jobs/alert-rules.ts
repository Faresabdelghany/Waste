// The worker's alert rules (O4 of #290): every few minutes, across companies,
// the four conditions — six since O8 and O20, below — the office should hear of without anyone raising them
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
// the six raise statements read only the occurrences no alert names yet,
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
// O20 of #290 added the sixth, `maintenance-due`: an active maintenance plan
// of a vehicle not retired that is within its margins of a limit — fourteen
// days, a thousand kilometres, fifty engine hours — or past one, judged as
// @waste/domain/resources/maintenance judges it: on its project's today, and
// against the newest odometer and engine hours a pre-trip check read of the
// vehicle, or the last service's where none is newer (`DUE_PLANS`, one probe
// each into `pre_trip_check_vehicle_id_idx`). Its key is
// `maintenance-due:<plan>:<last service's day>/<km>/<hours>` (`-` for a reading
// the plan has none of), `:overdue` once past a limit: a service done moves
// the baseline and clears it, a plan retired or relieved by a patch clears
// it, and running from due soon to overdue is a second, graver occurrence,
// the first cleared, as a licence's expiry is.
import { routeLabel } from "@waste/contracts/execution"
import { ticketLabel } from "@waste/contracts/resolution"
import { alert } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { MAINTENANCE_WARNING_DAYS, MAINTENANCE_WARNING_HOURS, MAINTENANCE_WARNING_KM } from "@waste/domain/resources/maintenance"
import { alertOfRule, CLEARED_NOTES, LICENCE_WARNING_DAYS, POSITION_STALE_MINUTES, ROUTE_START_GRACE_MINUTES, RULE_LOOKBACK_HOURS, SESSION_SILENCE_MINUTES, type RuleOccurrence } from "@waste/domain/resolution/alert-rules"
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

/** One occurrence to raise, with the company and project its alert is of. */
export type RaisedOccurrence = { companyId: string; projectId: string; ruleKey: string; occurrence: RuleOccurrence }
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

/** A vehicle's newest reading of one kind by a pre-trip check, one backward probe into the check's vehicle index. */
const newestReading = (column: "odometer_km" | "engine_hours") =>
  sql.raw(`(select pc.${column} from wms.pre_trip_check pc where pc.company_id = m.company_id and pc.vehicle_id = m.vehicle_id and pc.${column} is not null order by pc.occurred_at desc limit 1)`)

/**
 * The active plans of vehicles not retired, each judged at the tick's
 * instant: its next limits, the readings it is judged on — the newest a
 * pre-trip check read, else the last service's (`greatest` passes over a
 * null) — whether it is past a limit or within the margins of one, and its
 * key. As `mp`, read by the raise and, by the plan in the key, the clear.
 */
const duePlans = (now: SQL) => sql`(
  select j.*,
         'maintenance-due:' || j.plan_id || ':' || to_char(j.last_done_on, 'YYYY-MM-DD') || '/' || coalesce(j.last_done_km::text, '-') || '/' || coalesce(j.last_done_hours::text, '-')
           || case when j.overdue then ':overdue' else '' end as rule_key
    from (
      select r.*,
             coalesce(r.today >= r.next_on or r.odometer_km >= r.next_km or r.engine_hours >= r.next_hours, false) as overdue,
             coalesce(r.today >= r.next_on - ${MAINTENANCE_WARNING_DAYS}::int or r.odometer_km >= r.next_km - ${MAINTENANCE_WARNING_KM}::int or r.engine_hours >= r.next_hours - ${MAINTENANCE_WARNING_HOURS}::int, false) as due
        from (
          select m.company_id, m.project_id, m.id as plan_id, m.vehicle_id, m.name, coalesce(v.callsign, v.registration) as vehicle_label,
                 m.last_done_on, m.last_done_km, m.last_done_hours,
                 (${now} at time zone p.timezone)::date as today,
                 m.last_done_on + m.interval_days as next_on,
                 m.last_done_km + m.interval_km as next_km,
                 m.last_done_hours + m.interval_hours as next_hours,
                 greatest(${newestReading("odometer_km")}, m.last_done_km) as odometer_km,
                 greatest(${newestReading("engine_hours")}, m.last_done_hours) as engine_hours
            from wms.vehicle_maintenance_plan m
            join wms.vehicle v on v.company_id = m.company_id and v.id = m.vehicle_id
            join wms.project p on p.company_id = m.company_id and p.id = m.project_id
           where m.status = 'active' and v.status <> 'retired'
        ) r
    ) j
) mp`

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
  const plans = await worker.db.execute<{ company_id: string; project_id: string; rule_key: string; vehicle_id: string; vehicle_label: string; name: string; overdue: boolean; next_on: string | null; next_km: number | null; next_hours: number | null }>(sql`
    select mp.company_id, mp.project_id, mp.rule_key, mp.vehicle_id, mp.vehicle_label, mp.name, mp.overdue,
           to_char(mp.next_on, 'YYYY-MM-DD') as next_on, mp.next_km, mp.next_hours
      from ${duePlans(now)}
     where mp.due
       and ${noAlertWith(sql`mp.rule_key`, sql`mp.company_id`)}
  `)

  const of = (row: { company_id: string; project_id: string; rule_key: string }) => ({ companyId: row.company_id, projectId: row.project_id, ruleKey: row.rule_key })
  return [
    ...routes.map((row) => ({ ...of(row), occurrence: { rule: "route-not-started" as const, routeId: row.route_id, routeLabel: routeLabel(Number(row.number)), operatingDate: row.operating_date, plannedStart: row.planned_start, driverId: row.driver_id, vehicleId: row.vehicle_id } })),
    ...sessions.map((row) => ({ ...of(row), occurrence: { rule: "session-silent" as const, routeId: row.route_id, routeLabel: routeLabel(Number(row.number)), driverId: row.driver_id, driverName: row.driver_name, vehicleId: row.vehicle_id, lastSeen: row.last_seen } })),
    ...positions.map((row) => ({ ...of(row), occurrence: { rule: "position-stale" as const, routeId: row.route_id, routeLabel: routeLabel(Number(row.number)), driverId: row.driver_id, driverName: row.driver_name, vehicleId: row.vehicle_id, lastFix: row.last_fix } })),
    ...licences.map((row) => ({ ...of(row), occurrence: { rule: "licence-expiring" as const, driverId: row.driver_id, driverName: row.driver_name, licenceExpiry: row.licence_expiry, today: row.today } })),
    ...tickets.map((row) => ({ ...of(row), occurrence: { rule: "ticket-overdue" as const, ticketId: row.ticket_id, ticketLabel: ticketLabel(Number(row.number)), subject: row.subject, due: row.due } })),
    ...plans.map((row) => ({
      ...of(row),
      occurrence: {
        rule: "maintenance-due" as const,
        vehicleId: row.vehicle_id,
        vehicleLabel: row.vehicle_label,
        planName: row.name,
        overdue: row.overdue,
        nextDueOn: row.next_on,
        nextDueKm: row.next_km === null ? null : Number(row.next_km),
        nextDueHours: row.next_hours === null ? null : Number(row.next_hours),
      },
    })),
  ]
}

/**
 * The rules' open alerts whose occurrence no longer holds, across companies,
 * as the worker role: the subject, found by its id, no longer spells the
 * alert's key — a route started, moved or cancelled; a device heard from or
 * its session or route ended; a licence renewed or run out, or its driver no
 * longer active; a ticket closed or re-dated; a plan serviced, retired or run
 * overdue — or its condition has passed.
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
         when 'ticket-overdue' then not exists (
           select 1 from wms.ticket t
            where t.company_id = a.company_id and t.id = a.ticket_id and a.rule_key = ${KEYS.ticket} and t.status in (${OPEN_TICKETS}) and t.due_at < ${now})
         when 'maintenance-due' then not exists (
           select 1 from ${duePlans(now)}
            where mp.company_id = a.company_id and mp.plan_id = split_part(a.rule_key, ':', 2)::uuid and mp.rule_key = a.rule_key and mp.due)
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
    const rows = await withCompany(api.db, companyId, (tx) =>
      tx
        .insert(alert)
        .values(
          occurrences.map(({ projectId, ruleKey, occurrence }) => {
            const { rule, kind, severity, source, title, details, routeId, vehicleId, driverId, containerId, ticketId } = alertOfRule(occurrence)
            return { companyId, projectId, rule, ruleKey, kind, severity, source, title, details, detectedAt: at, routeId, vehicleId, driverId, containerId, ticketId, raisedBy: null }
          }),
        )
        // A tick that overlapped this one raised the occurrence already: the key is its word.
        .onConflictDoNothing({ target: [alert.companyId, alert.ruleKey], where: sql`${alert.ruleKey} is not null and (${alert.status} <> 'resolved' or ${alert.resolvedBy} is not null)` })
        .returning({ id: alert.id }),
    )
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
  description: "Raises the alerts the worker's rules find — a route not started, a device silent, a licence running out, a ticket overdue, a position stale — and resolves those whose condition has cleared (O4 and O8 of #290).",
  handler: async (_jobs, context) => await runAlertRules(context),
  schedule: rulesSchedule(),
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "skip" },
  // No retry: the next tick is the retry, reading the same.
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 86_400 },
})
