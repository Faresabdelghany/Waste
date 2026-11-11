// The reports (#292: #291's slice 26, "KPI reads"): two reads that count
// rows that exist and store nothing, for the Dashboard. The wire is
// @waste/contracts/reports, which says what each answers; what a count means
// is @waste/domain/insight/readings, and how a window is cut into its series
// is @waste/domain/insight/intervals.
//
//   GET /reports/service  `improve.performance` + `route-studio.routes`
//   GET /reports/tickets  `improve.performance` + `operate.tickets`
//
// Two grants each, both `view`: Improve's Performance, the module the report
// is read in, and the module whose rows it counts, since a total is the
// content of the rows it totals and a role refused the routes or the tickets
// is refused their counts too (a scheme's name). The charters give both to
// the roles that read each (@waste/domain/access/system-roles): the
// Operations Manager, the Dispatcher and the Fleet Manager.
//
// Every statement is fenced twice, the tenant and `inProjects` on the table
// it reads from, and the tables it joins are joined within the tenant; a
// `projectId` the caller does not work in is a 400 on the query
// (`requireProject`), and an account that works in no project reads zeros.
// A statement counts by day — a route's operating date, an instant rendered
// on its project's clock — and the handler folds the days into the window's
// intervals through the domain, so which interval a day is in is decided in
// one place and never by a `date_trunc`. A day of an instant on its
// project's clock is an expression no index holds, so each such test is
// joined by a coarse bound on the instant itself — from a day before the
// window's first to two days after its last, wider than any timezone's
// offset — which the instant's index can prune by. Each read is a handful of
// grouped statements over the window and no page: the window is at most a
// year (`REPORT_WINDOW_MAX_DAYS`), and what grows with the data — routes,
// pickups, tickets — is counted, never listed. Names sort in one collation,
// English's, whatever the server's locale.
import type { PickupReason, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"
import { PICKUP_REASONS } from "@waste/domain/execution/vocabulary"
import { intervalOf, intervalsOver, type DayInterval } from "@waste/domain/insight/intervals"
import { ON_TIME_GRACE_MINUTES, pickupStanding, rate } from "@waste/domain/insight/readings"
import { REPORT_FIRST_DAY, REPORT_WINDOW_MAX_DAYS } from "@waste/domain/insight/reports"
import type { ReportInterval as Interval } from "@waste/domain/insight/vocabulary"
import type { ModuleKey } from "@waste/domain/access/modules"
import { OPEN_TICKET_STATUSES, TICKET_KINDS, type TicketKind } from "@waste/domain/resolution/vocabulary"
import { ServiceReport, ServiceReportQuery, TicketReport, TicketReportQuery, type MissedReason, type PickupStandings, type ReportWindow, type RouteCounts, type ServiceRates, type ServiceScheme, type TicketKindCounts } from "@waste/contracts/reports"
import type { Tx } from "@waste/db/client"
import { dayOnClock, instantOnClock } from "@waste/db/query/project-clock"
import { pickup, route } from "@waste/db/schema/execution"
import { project } from "@waste/db/schema/organisation"
import { ticket } from "@waste/db/schema/resolution"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { and, count, countDistinct, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, lte, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Context } from "hono"

import type { AuthEnv, Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import type { RouteDeps } from "../deps"
import { describeJson, routes } from "../operation"
import { describeProblem } from "../problem"

const PERFORMANCE = "improve.performance"

/** What every report's 400 says beyond its own filters. */
const WINDOW_REFUSED = `a parameter is one the report does not read, \`from\` or \`to\` is missing, not a day or before ${REPORT_FIRST_DAY}, the window runs backwards or is longer than ${REPORT_WINDOW_MAX_DAYS} days, \`interval\` is not \`day\`, \`week\` or \`month\`, or \`projectId\` is not a project this account works in`

/** What a report's window and filters say in every description. */
const WINDOW_SENTENCE = `\`from\` and \`to\` are the window's first and last day, both inclusive, at most ${REPORT_WINDOW_MAX_DAYS} days, from ${REPORT_FIRST_DAY} on; \`interval\` (\`day\` when absent) cuts it into the series — days, ISO weeks from Monday, calendar months, the first and last clipped to the window. \`projectId\` narrows the report to one of the caller's projects, and absent it spans every project the caller works in; an account that works in none reads zeros. The query is strict: a parameter this report does not read is refused by name.`
const describe403 = (rows: ModuleKey) => describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${PERFORMANCE}\` and \`view\` on \`${rows}\`, the rows this report counts.`)

type WindowQuery = { projectId?: string; from: string; to: string; interval: Interval }

const windowOf = (query: WindowQuery): ReportWindow => ({ projectId: query.projectId ?? null, from: query.from, to: query.to, interval: query.interval })

type ProjectTable = { companyId: PgColumn; projectId: PgColumn }
function fenced(table: ProjectTable, principal: Principal, projectId: string | undefined): SQL {
  return and(eq(table.companyId, principal.companyId), inProjects(table.projectId, principal), projectId === undefined ? undefined : eq(table.projectId, projectId)) as SQL
}

const projectOf = (table: ProjectTable) => and(eq(project.companyId, table.companyId), eq(project.id, table.projectId))

/** An instant as the day it falls on, on its project's clock; no parameter, so a statement can group by it. */
const dayOn = (instant: PgColumn | SQL): SQL<string> => dayOnClock(instant, project.timezone)

/** A day inside the window, both ends inclusive. */
export const inWindow = (day: PgColumn | SQL, window: DayInterval): SQL => sql`${day} between ${window.from}::date and ${window.to}::date`

const DAY_MS = 86_400_000

/** An instant whose day on its project's clock is in the window: the exact test, and the coarse bound on the instant an index can prune by. */
function instantInWindow(instant: PgColumn, window: DayInterval): SQL {
  const earliest = new Date(Date.parse(`${window.from}T00:00:00Z`) - DAY_MS)
  const latest = new Date(Date.parse(`${window.to}T00:00:00Z`) + 2 * DAY_MS)
  return and(gte(instant, earliest), lt(instant, latest), inWindow(dayOn(instant), window)) as SQL
}

const countWhere = (condition: SQL | undefined) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number)

/** Names in one order wherever the API runs. */
export const byName = new Intl.Collator("en").compare

const noRoutes = (): RouteCounts => ({ total: 0, planned: 0, ready: 0, active: 0, completed: 0, cancelled: 0, started: 0, onTime: 0, late: 0, unjudged: 0 })
const noPickups = (): PickupStandings => ({ due: 0, completed: 0, missed: 0, skipped: 0, failed: 0, open: 0, withdrawn: 0 })

type RouteGroup = { status: string; routes: number; started: number; onTime: number; late: number; unjudged: number }

function addRoutes(tally: RouteCounts, group: RouteGroup): void {
  tally.total += group.routes
  tally[group.status as RouteStatus] += group.routes
  tally.started += group.started
  tally.onTime += group.onTime
  tally.late += group.late
  tally.unjudged += group.unjudged
}

function addPickups(tally: PickupStandings, status: PickupStatus, reason: PickupReason | null, n: number): void {
  const standing = pickupStanding(status, reason)
  if (standing === "withdrawn") {
    tally.withdrawn += n
    return
  }
  tally.due += n
  if (standing === "completed") tally.completed += n
  else if (standing === "open") tally.open += n
  else {
    tally.missed += n
    if (status === "failed") tally.failed += n
    else tally.skipped += n
  }
}

const serviceRates = (routes: RouteCounts, pickups: PickupStandings): ServiceRates => ({
  collection: rate(pickups.completed, pickups.completed + pickups.missed),
  missed: rate(pickups.missed, pickups.completed + pickups.missed),
  onTime: rate(routes.onTime, routes.onTime + routes.late),
})

/** The series' intervals keyed by their first day, each with a fresh tally, so a quiet interval is answered at zero. */
function seriesOf<Tally>(window: DayInterval, interval: Interval, empty: () => Tally): Map<string, DayInterval & Tally> {
  return new Map(intervalsOver(window, interval).map((span) => [span.from, { ...span, ...empty() }] as const))
}

function inSeries<Tally>(series: Map<string, DayInterval & Tally>, day: string, window: DayInterval, interval: Interval): DayInterval & Tally {
  const found = series.get(intervalOf(day, window, interval).from)
  if (found === undefined) throw new Error(`no interval for ${day} in ${window.from}..${window.to}`)
  return found
}

/** The routes a report counts: operating in the window, a regeneration's cancellations left out, since the occurrence they stood for is gone. */
export const routesOfWindow = (window: DayInterval): SQL => and(inWindow(route.operatingDate, window), eq(route.cancelledByGeneration, false)) as SQL

async function serviceReport(tx: Tx, principal: Principal, query: ServiceReportQuery): Promise<ServiceReport> {
  const { projectId, wasteFractionId, routeSchemeId } = query
  const window = { from: query.from, to: query.to }
  const routeWindow = and(routesOfWindow(window), routeSchemeId === undefined ? undefined : eq(route.routeSchemeId, routeSchemeId))
  const deadline = sql`${instantOnClock(route.operatingDate, project.timezone, route.plannedStartTime)} + ${sql.raw(`interval '${ON_TIME_GRACE_MINUTES} minutes'`)}`
  const judged = and(isNotNull(route.startedAt), isNotNull(route.plannedStartTime))
  const routeGroups = await tx
    .select({
      routeSchemeId: route.routeSchemeId,
      projectId: route.projectId,
      operatingDate: route.operatingDate,
      status: route.status,
      routes: count(),
      started: count(route.startedAt),
      onTime: countWhere(and(judged, lte(route.startedAt, deadline))),
      late: countWhere(and(judged, gt(route.startedAt, deadline))),
      unjudged: countWhere(and(isNotNull(route.startedAt), isNull(route.plannedStartTime))),
    })
    .from(route)
    .innerJoin(project, projectOf(route))
    .where(
      and(
        fenced(route, principal, projectId),
        routeWindow,
        wasteFractionId === undefined
          ? undefined
          : exists(
              tx
                .select({ one: sql`1` })
                .from(pickup)
                .where(and(eq(pickup.companyId, route.companyId), eq(pickup.routeId, route.id), eq(pickup.wasteFractionId, wasteFractionId))),
            ),
      ),
    )
    .groupBy(route.routeSchemeId, route.projectId, route.operatingDate, route.status)
  const pickupGroups = await tx
    .select({ routeSchemeId: route.routeSchemeId, projectId: route.projectId, operatingDate: route.operatingDate, status: pickup.status, reason: pickup.reason, n: count() })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    // Collections alone: a repair or a wash (O3 of #290) empties nothing, so it is neither collected nor missed here.
    .where(and(fenced(pickup, principal, projectId), routeWindow, eq(pickup.service, "empty"), wasteFractionId === undefined ? undefined : eq(pickup.wasteFractionId, wasteFractionId)))
    .groupBy(route.routeSchemeId, route.projectId, route.operatingDate, pickup.status, pickup.reason)
  const schemeIds = [...new Set(routeGroups.flatMap((group) => (group.routeSchemeId === null ? [] : [group.routeSchemeId])))]
  const names =
    schemeIds.length === 0
      ? []
      : await tx
          .select({ id: routeScheme.id, name: routeScheme.name })
          .from(routeScheme)
          .where(and(eq(routeScheme.companyId, principal.companyId), inProjects(routeScheme.projectId, principal), inArray(routeScheme.id, schemeIds)))
  const nameOf = new Map(names.map((row) => [row.id, row.name] as const))

  const routes = noRoutes()
  const pickups = noPickups()
  const series = seriesOf(window, query.interval, () => ({ routes: noRoutes(), pickups: noPickups() }))
  // A scheme's routes are one row; the office's ad-hoc routes (#111), which have no scheme, are one row per project.
  const schemeKey = (group: { routeSchemeId: string | null; projectId: string }) => group.routeSchemeId ?? `ad-hoc|${group.projectId}`
  const schemes = new Map<string, { routeSchemeId: string | null; projectId: string; routes: RouteCounts; pickups: PickupStandings }>()
  for (const group of routeGroups) {
    const scheme = schemes.get(schemeKey(group)) ?? { routeSchemeId: group.routeSchemeId, projectId: group.projectId, routes: noRoutes(), pickups: noPickups() }
    schemes.set(schemeKey(group), scheme)
    for (const tally of [routes, inSeries(series, group.operatingDate, window, query.interval).routes, scheme.routes]) addRoutes(tally, group)
  }
  const missed = new Map<PickupReason, MissedReason>()
  for (const group of pickupGroups) {
    const status = group.status
    const reason = group.reason
    // Every pickup's route is in the route groups, since both statements read the same window: its scheme is there already.
    const scheme = schemes.get(schemeKey(group))
    for (const tally of [pickups, inSeries(series, group.operatingDate, window, query.interval).pickups, ...(scheme === undefined ? [] : [scheme.pickups])]) addPickups(tally, status, reason, group.n)
    if (reason !== null && pickupStanding(status, reason) === "missed") {
      const byReason = missed.get(reason) ?? { reason, skipped: 0, failed: 0 }
      if (status === "failed") byReason.failed += group.n
      else byReason.skipped += group.n
      missed.set(reason, byReason)
    }
  }
  const schemeRows: ServiceScheme[] = [...schemes.values()]
    .map((scheme) => ({
      routeSchemeId: scheme.routeSchemeId,
      name: scheme.routeSchemeId === null ? null : (nameOf.get(scheme.routeSchemeId) ?? ""),
      projectId: scheme.projectId,
      routes: scheme.routes,
      pickups: scheme.pickups,
      rates: serviceRates(scheme.routes, scheme.pickups),
    }))
    .sort((a, b) => Number(a.name === null) - Number(b.name === null) || byName(a.name ?? "", b.name ?? "") || (a.routeSchemeId ?? "").localeCompare(b.routeSchemeId ?? "") || a.projectId.localeCompare(b.projectId))
  return {
    window: windowOf(query),
    routes,
    pickups,
    rates: serviceRates(routes, pickups),
    missedByReason: PICKUP_REASONS.flatMap((reason) => {
      const found = missed.get(reason)
      return found === undefined ? [] : [found]
    }),
    intervals: [...series.values()],
    schemes: schemeRows,
  }
}

async function ticketReport(tx: Tx, principal: Principal, query: TicketReportQuery, now: Date): Promise<TicketReport> {
  const { projectId } = query
  const window = { from: query.from, to: query.to }
  const opened = dayOn(ticket.createdAt)
  const closed = dayOn(ticket.closedAt)
  const isOpen = inArray(ticket.status, [...OPEN_TICKET_STATUSES])
  const openedGroups = await tx
    .select({ kind: ticket.kind, day: opened, n: count() })
    .from(ticket)
    .innerJoin(project, projectOf(ticket))
    .where(and(fenced(ticket, principal, projectId), instantInWindow(ticket.createdAt, window)))
    .groupBy(ticket.kind, opened)
  const closedGroups = await tx
    .select({
      kind: ticket.kind,
      status: ticket.status,
      day: closed,
      n: count(),
      withDue: countWhere(isNotNull(ticket.dueAt)),
      withinDue: countWhere(and(isNotNull(ticket.dueAt), lte(ticket.closedAt, ticket.dueAt))),
    })
    .from(ticket)
    .innerJoin(project, projectOf(ticket))
    .where(and(fenced(ticket, principal, projectId), instantInWindow(ticket.closedAt, window)))
    .groupBy(ticket.kind, ticket.status, closed)
  const openGroups = await tx
    .select({ kind: ticket.kind, n: count(), overdue: countWhere(lt(ticket.dueAt, now)) })
    .from(ticket)
    .where(and(fenced(ticket, principal, projectId), isOpen))
    .groupBy(ticket.kind)
  const [routesNamed] = await tx
    .select({ n: countDistinct(ticket.routeId) })
    .from(ticket)
    .where(and(fenced(ticket, principal, projectId), isOpen))

  const byKind = new Map<TicketKind, TicketKindCounts>()
  const kindOf = (kind: string) => {
    const found = byKind.get(kind as TicketKind) ?? { kind: kind as TicketKind, opened: 0, closed: 0, open: 0 }
    byKind.set(kind as TicketKind, found)
    return found
  }
  const series = seriesOf(window, query.interval, () => ({ opened: 0, closed: 0 }))
  let openedCount = 0
  for (const group of openedGroups) {
    openedCount += group.n
    kindOf(group.kind).opened += group.n
    inSeries(series, group.day, window, query.interval).opened += group.n
  }
  const tally = { closed: 0, completed: 0, rejected: 0, closedWithDue: 0, closedWithinDue: 0 }
  for (const group of closedGroups) {
    tally.closed += group.n
    if (group.status === "completed") tally.completed += group.n
    else tally.rejected += group.n
    tally.closedWithDue += group.withDue
    tally.closedWithinDue += group.withinDue
    kindOf(group.kind).closed += group.n
    inSeries(series, group.day, window, query.interval).closed += group.n
  }
  let open = 0
  let overdue = 0
  for (const group of openGroups) {
    open += group.n
    overdue += group.overdue
    kindOf(group.kind).open += group.n
  }
  return {
    window: windowOf(query),
    asOf: now.toISOString(),
    opened: openedCount,
    ...tally,
    open,
    overdue,
    openOnRoutes: routesNamed?.n ?? 0,
    rates: { closedWithinDue: rate(tally.closedWithinDue, tally.closedWithDue) },
    byKind: TICKET_KINDS.flatMap((kind) => {
      const found = byKind.get(kind)
      return found === undefined ? [] : [found]
    }),
    intervals: [...series.values()],
  }
}

function answer<Query extends { projectId?: string }, Report>(read: (tx: Tx, principal: Principal, query: Query) => Promise<Report>) {
  return async (c: Context<AuthEnv>, query: Query) => {
    const principal = c.get("principal")
    if (query.projectId !== undefined) requireProject(principal, query.projectId, "projectId", "query")
    return c.json(await read(c.get("tx"), principal, query))
  }
}

export function reportRoutes(deps: RouteDeps) {
  const { now } = deps
  const service = answer(serviceReport)
  const tickets = answer((tx, principal, query: TicketReportQuery) => ticketReport(tx, principal, query, now()))
  return routes(deps)
    .get(
      "/reports/service",
      {
        operationId: "getServiceReport",
        summary: "How the routes ran and their pickups were served",
        description: `The routes operating in the window — a regeneration's cancellations left out, since the occurrence they stood for is gone — by status, how many went out, and whether they went out on time: started no later than the planned start on the project's clock on the operating date plus ${ON_TIME_GRACE_MINUTES} minutes, a route with no planned start counted apart as unjudged. And their pickups by standing: completed, missed (skipped or failed, with the reasons), open (still planned) and withdrawn (taken off by a regeneration or removed by the dispatcher, counted in nothing else); \`due\` is completed, missed and open. The collection and missed rates are over the pickups with an outcome, the on-time rate over the routes judged; each is null where there was nothing to divide by. The same counts per interval of the series, every interval present, and per Route Scheme with a route in the window, the office's ad-hoc routes (no scheme) in a row of their own per project with \`routeSchemeId\` and \`name\` null. ${WINDOW_SENTENCE} \`wasteFractionId\` narrows the pickups to one fraction and the routes to the ones holding a pickup of it; \`routeSchemeId\` to one scheme's routes.`,
        module: PERFORMANCE,
        action: "view",
        also: ["route-studio.routes", "view"],
        query: ServiceReportQuery,
        invalid: [`the query does not parse: ${WINDOW_REFUSED}, or a filter is not an id`],
        responses: {
          200: describeJson("The service report.", ServiceReport),
          403: describe403("route-studio.routes"),
        },
      },
      (c) => service(c, c.req.valid("query")),
    )
    .get(
      "/reports/tickets",
      {
        operationId: "getTicketReport",
        summary: "How the tickets were opened and closed",
        description: `The tickets opened over the window — made on one of its days, on the project's clock; the ticket list's own window reads \`occurredAt\` instead, when the issue happened — and closed over it, completed or rejected, with how many of the closed had a due time and how many were closed by it; and, whatever the window, the tickets open now (open, in progress, pending or on hold) with how many are past their due time and how many routes they name. \`asOf\` is the instant "now" was read at. By kind, the kinds with any, and per interval of the series, every interval present. ${WINDOW_SENTENCE}`,
        module: PERFORMANCE,
        action: "view",
        also: ["operate.tickets", "view"],
        query: TicketReportQuery,
        invalid: [`the query does not parse: ${WINDOW_REFUSED}`],
        responses: {
          200: describeJson("The ticket report.", TicketReport),
          403: describe403("operate.tickets"),
        },
      },
      (c) => tickets(c, c.req.valid("query")),
    )
}
