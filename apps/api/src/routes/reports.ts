// The reports (#292: #291's slice 26, "KPI reads", and #290's O12, "tonnage
// reporting"): four reads that count rows that exist and store nothing, for
// the Dashboard and the Improve workspace. The wire is
// @waste/contracts/reports, which says what each answers; what a count means
// is @waste/domain/insight/readings, and how a window is cut into its series
// is @waste/domain/insight/intervals.
//
//   GET /reports/service  `improve.performance` + `route-studio.routes`
//   GET /reports/tickets  `improve.performance` + `operate.tickets`
//   GET /reports/revenue  `improve.analytics`   + `commercial.invoices`
//   GET /reports/tonnage  `improve.analytics`   + `route-studio.weights`
//
// Two grants each, both `view`: the Improve module the report is read in —
// Performance's operational service, Analytics' period analysis — and the
// module whose rows it counts, since a total is the content of the rows it
// totals and a role refused the routes, the tickets, the invoices or the
// unloads is refused their counts too (a scheme's name, a station's
// tonnage). The charters give both to the roles that read each
// (@waste/domain/access/system-roles): the Operations Manager all four, the
// Dispatcher and the Fleet Manager service and tickets, the Route Planner
// and the Fleet Manager tonnage, the Finance Specialist revenue.
//
// Every statement is fenced twice, the tenant and `inProjects` on the table
// it reads from, and the tables it joins are joined within the tenant; a
// `projectId` the caller does not work in is a 400 on the query
// (`requireProject`), and an account that works in no project reads zeros.
// A statement counts by day — a route's operating date, an invoice's
// `issuedOn`, an instant rendered on its project's clock — and the handler
// folds the days into the window's intervals through the domain, so which
// interval a day is in is decided in one place and never by a `date_trunc`.
// A day of an instant on its project's clock is an expression no index
// holds, so each such test is joined by a coarse bound on the instant itself
// — from a day before the window's first to two days after its last, wider
// than any timezone's offset — which the instant's index can prune by. Each
// read is a handful of grouped statements over the window and no page: the
// window is at most a year (`REPORT_WINDOW_MAX_DAYS`), and what grows with
// the data — routes, pickups, documents, unloads — is counted, never listed.
// Names sort in one collation, English's, whatever the server's locale.
import type { PickupReason, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"
import { PICKUP_REASONS } from "@waste/domain/execution/vocabulary"
import type { WeightReviewStatus } from "@waste/domain/finance/vocabulary"
import { intervalOf, intervalsOver, type DayInterval } from "@waste/domain/insight/intervals"
import { ON_TIME_GRACE_MINUTES, pickupStanding, rate, unloadStanding } from "@waste/domain/insight/readings"
import type { ReportInterval as Interval } from "@waste/domain/insight/vocabulary"
import type { ModuleKey } from "@waste/domain/access/modules"
import { OPEN_TICKET_STATUSES, TICKET_KINDS, type TicketKind, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import {
  REPORT_FIRST_DAY,
  REPORT_WINDOW_MAX_DAYS,
  RevenueReport,
  RevenueReportQuery,
  ServiceReport,
  ServiceReportQuery,
  TicketReport,
  TicketReportQuery,
  TonnageReport,
  TonnageReportQuery,
  type MissedReason,
  type PickupStandings,
  type PickupWeightRow,
  type ReportWindow,
  type RevenueInterval,
  type RevenueProduct,
  type RevenueTotals,
  type RouteCounts,
  type ServiceRates,
  type ServiceScheme,
  type TicketKindCounts,
  type TonnageRow,
} from "@waste/contracts/reports"
import type { Tx } from "@waste/db/client"
import { reviewStatus, weightReviewOf } from "@waste/db/query/weight-review"
import { product, wasteFraction } from "@waste/db/schema/catalogue"
import { pickup, proofOfService, route, unload } from "@waste/db/schema/execution"
import { billableEvent, invoice, invoiceLine } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import { unloadingStation } from "@waste/db/schema/places"
import { ticket } from "@waste/db/schema/resolution"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { and, count, countDistinct, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, lte, sql, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import { Hono, type Context, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { describeProblem, validate } from "../problem"
import type { ClockOptions } from "./scheme-groups"
import { describeJson } from "./shared"

const PERFORMANCE = "improve.performance"
const ANALYTICS = "improve.analytics"

/** What every report's 400 says beyond its own filters. */
const WINDOW_REFUSED = `a parameter is one the report does not read, \`from\` or \`to\` is missing, not a day or before ${REPORT_FIRST_DAY}, the window runs backwards or is longer than ${REPORT_WINDOW_MAX_DAYS} days, \`interval\` is not \`day\`, \`week\` or \`month\`, or \`projectId\` is not a project this account works in`

/** What a report's window and filters say in every description. */
const WINDOW_SENTENCE = `\`from\` and \`to\` are the window's first and last day, both inclusive, at most ${REPORT_WINDOW_MAX_DAYS} days, from ${REPORT_FIRST_DAY} on; \`interval\` (\`day\` when absent) cuts it into the series — days, ISO weeks from Monday, calendar months, the first and last clipped to the window. \`projectId\` narrows the report to one of the caller's projects, and absent it spans every project the caller works in; an account that works in none reads zeros. The query is strict: a parameter this report does not read is refused by name.`

const DESCRIBE_401 = describeProblem("No usable token (see WWW-Authenticate).")
const describe403 = (improve: ModuleKey, rows: ModuleKey) => describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${improve}\` and \`view\` on \`${rows}\`, the rows this report counts.`)

type WindowQuery = { projectId?: string; from: string; to: string; interval: Interval }

/** The window as the report read it, for its answer. */
const windowOf = (query: WindowQuery): ReportWindow => ({ projectId: query.projectId ?? null, from: query.from, to: query.to, interval: query.interval })

/** A project-scoped table's two fences, and the project the query names. */
type ProjectTable = { companyId: PgColumn; projectId: PgColumn }
function fenced(table: ProjectTable, principal: Principal, projectId: string | undefined): SQL {
  return and(eq(table.companyId, principal.companyId), inProjects(table.projectId, principal), projectId === undefined ? undefined : eq(table.projectId, projectId)) as SQL
}

/** The project a row is of, joined within the tenant, for its timezone. */
const projectOf = (table: ProjectTable) => and(eq(project.companyId, table.companyId), eq(project.id, table.projectId))

/** An instant as the day it falls on, on its project's clock; no parameter, so a statement can group by it. */
const dayOn = (instant: PgColumn | SQL): SQL<string> => sql<string>`(${instant} at time zone ${project.timezone})::date`

/** A day inside the window, both ends inclusive. */
const inWindow = (day: PgColumn | SQL, window: DayInterval): SQL => sql`${day} between ${window.from}::date and ${window.to}::date`

const DAY_MS = 86_400_000

/** An instant whose day on its project's clock is in the window: the exact test, and the coarse bound on the instant an index can prune by. */
function instantInWindow(instant: PgColumn, window: DayInterval): SQL {
  const earliest = new Date(Date.parse(`${window.from}T00:00:00Z`) - DAY_MS)
  const latest = new Date(Date.parse(`${window.to}T00:00:00Z`) + 2 * DAY_MS)
  return and(gte(instant, earliest), lt(instant, latest), inWindow(dayOn(instant), window)) as SQL
}

/** `count(*)` of the rows the condition holds for. */
const countWhere = (condition: SQL | undefined) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number)

/** A sum of whole numbers, as a number: Postgres answers `sum` as numeric text. */
const total = (value: PgColumn | SQL) => sql<number>`coalesce(sum(${value}), 0)::bigint`.mapWith(Number)

/** Names in one order wherever the API runs. */
const byName = new Intl.Collator("en").compare

// The service report's tallies.

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

/** The interval of the series a day is counted in. */
function inSeries<Tally>(series: Map<string, DayInterval & Tally>, day: string, window: DayInterval, interval: Interval): DayInterval & Tally {
  const found = series.get(intervalOf(day, window, interval).from)
  if (found === undefined) throw new Error(`no interval for ${day} in ${window.from}..${window.to}`)
  return found
}

/** The routes a report counts: operating in the window, a regeneration's cancellations left out, since the occurrence they stood for is gone. */
const routesOfWindow = (window: DayInterval): SQL => and(inWindow(route.operatingDate, window), eq(route.cancelledByGeneration, false)) as SQL

async function serviceReport(tx: Tx, principal: Principal, query: ServiceReportQuery): Promise<ServiceReport> {
  const { projectId, wasteFractionId, routeSchemeId } = query
  const window = { from: query.from, to: query.to }
  const routeWindow = and(routesOfWindow(window), routeSchemeId === undefined ? undefined : eq(route.routeSchemeId, routeSchemeId))
  // On time: started no later than the planned start on the project's clock on the operating date, plus the grace.
  const deadline = sql`((${route.operatingDate} + ${route.plannedStartTime}) at time zone ${project.timezone}) + ${sql.raw(`interval '${ON_TIME_GRACE_MINUTES} minutes'`)}`
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
        // A fraction's routes are the ones holding a pickup of it.
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
    .where(and(fenced(pickup, principal, projectId), routeWindow, wasteFractionId === undefined ? undefined : eq(pickup.wasteFractionId, wasteFractionId)))
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
    const status = group.status as PickupStatus
    const reason = group.reason as PickupReason | null
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
    // The schemes by name, then each project's ad-hoc routes.
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
    if ((group.status as TicketStatus) === "completed") tally.completed += group.n
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

const noDocuments = (currency: string): RevenueTotals => ({ currency, invoices: 0, creditNotes: 0, netMinor: 0, vatMinor: 0, grossMinor: 0 })

async function revenueReport(tx: Tx, principal: Principal, query: RevenueReportQuery): Promise<RevenueReport> {
  const { projectId } = query
  const window = { from: query.from, to: query.to }
  const documentGroups = await tx
    .select({
      currency: invoice.currency,
      kind: invoice.kind,
      issuedOn: invoice.issuedOn,
      n: count(),
      netMinor: total(invoice.netMinor),
      vatMinor: total(invoice.vatMinor),
      grossMinor: total(invoice.grossMinor),
    })
    .from(invoice)
    .where(and(fenced(invoice, principal, projectId), inWindow(invoice.issuedOn, window)))
    .groupBy(invoice.currency, invoice.kind, invoice.issuedOn)
  // A line counts its quantity against its product where it takes the service back — a credit note's line, or the line of a reversal — whatever its price, a free product's included.
  const signedQuantity = sql`case when ${invoiceLine.creditsLineId} is not null or ${billableEvent.kind} = 'reversal' then -${invoiceLine.quantity} else ${invoiceLine.quantity} end`
  const productGroups = await tx
    .select({ currency: invoice.currency, productId: product.id, name: product.name, quantity: total(signedQuantity), netMinor: total(invoiceLine.netMinor) })
    .from(invoiceLine)
    .innerJoin(invoice, and(eq(invoice.companyId, invoiceLine.companyId), eq(invoice.id, invoiceLine.invoiceId)))
    .innerJoin(product, and(eq(product.companyId, invoiceLine.companyId), eq(product.id, invoiceLine.productId)))
    .leftJoin(billableEvent, and(eq(billableEvent.companyId, invoiceLine.companyId), eq(billableEvent.id, invoiceLine.billableEventId)))
    .where(and(fenced(invoiceLine, principal, projectId), inWindow(invoice.issuedOn, window)))
    .groupBy(invoice.currency, product.id, product.name)

  const currencies = new Map<string, RevenueTotals>()
  const intervals = new Map<string, RevenueInterval>()
  const add = (tally: RevenueTotals, group: (typeof documentGroups)[number]) => {
    if (group.kind === "credit-note") tally.creditNotes += group.n
    else tally.invoices += group.n
    tally.netMinor += group.netMinor
    tally.vatMinor += group.vatMinor
    tally.grossMinor += group.grossMinor
  }
  for (const group of documentGroups) {
    const byCurrency = currencies.get(group.currency) ?? noDocuments(group.currency)
    currencies.set(group.currency, byCurrency)
    add(byCurrency, group)
    const span = intervalOf(group.issuedOn, window, query.interval)
    const key = `${span.from}|${group.currency}`
    const byInterval = intervals.get(key) ?? { ...span, ...noDocuments(group.currency) }
    intervals.set(key, byInterval)
    add(byInterval, group)
  }
  const products: RevenueProduct[] = productGroups
    .map((group) => ({ productId: group.productId, name: group.name, currency: group.currency, quantity: group.quantity, netMinor: group.netMinor }))
    .sort((a, b) => a.currency.localeCompare(b.currency) || b.netMinor - a.netMinor || byName(a.name, b.name))
  return {
    window: windowOf(query),
    currencies: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    intervals: [...intervals.values()].sort((a, b) => a.from.localeCompare(b.from) || a.currency.localeCompare(b.currency)),
    products,
  }
}

const noWeights = () => ({ netKg: 0, approvedKg: 0, capturedKg: 0, unloads: 0, rejectedKg: 0, rejectedUnloads: 0 })

async function tonnageReport(tx: Tx, principal: Principal, query: TonnageReportQuery): Promise<TonnageReport> {
  const { projectId, wasteFractionId, unloadingStationId } = query
  const window = { from: query.from, to: query.to }
  const occurred = dayOn(unload.occurredAt)
  const review = weightReviewOf(tx, principal.companyId, unload.id)
  const status = reviewStatus(review.decision)
  const unloadGroups = await tx
    .select({
      projectId: unload.projectId,
      wasteFractionId: unload.wasteFractionId,
      wasteFractionName: wasteFraction.name,
      unloadingStationId: unload.unloadingStationId,
      unloadingStationName: unloadingStation.name,
      day: occurred,
      status,
      netKg: total(unload.netKg),
      n: count(),
    })
    .from(unload)
    .innerJoin(project, projectOf(unload))
    .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, unload.companyId), eq(wasteFraction.id, unload.wasteFractionId)))
    .innerJoin(unloadingStation, and(eq(unloadingStation.companyId, unload.companyId), eq(unloadingStation.id, unload.unloadingStationId)))
    .leftJoinLateral(review, sql`true`)
    .where(
      and(
        fenced(unload, principal, projectId),
        instantInWindow(unload.occurredAt, window),
        wasteFractionId === undefined ? undefined : eq(unload.wasteFractionId, wasteFractionId),
        unloadingStationId === undefined ? undefined : eq(unload.unloadingStationId, unloadingStationId),
      ),
    )
    .groupBy(unload.projectId, unload.wasteFractionId, wasteFraction.name, unload.unloadingStationId, unloadingStation.name, occurred, status)
  // A pickup's weight counts where the pickup was collected, on its route's operating day as the service report counts the pickup, by its latest
  // reading: a weight proof appended later is the later word, as a review is. Only the window's routes' proofs are read.
  const latest = tx
    .selectDistinctOn([proofOfService.pickupId], {
      pickupId: proofOfService.pickupId,
      projectId: route.projectId,
      operatingDate: route.operatingDate,
      wasteFractionId: pickup.wasteFractionId,
      weightKg: proofOfService.weightKg,
    })
    .from(proofOfService)
    .innerJoin(pickup, and(eq(pickup.companyId, proofOfService.companyId), eq(pickup.id, proofOfService.pickupId)))
    .innerJoin(route, and(eq(route.companyId, proofOfService.companyId), eq(route.id, proofOfService.routeId)))
    .where(
      and(
        fenced(proofOfService, principal, projectId),
        eq(proofOfService.kind, "weight"),
        eq(pickup.status, "completed"),
        routesOfWindow(window),
        wasteFractionId === undefined ? undefined : eq(pickup.wasteFractionId, wasteFractionId),
      ),
    )
    .orderBy(proofOfService.pickupId, desc(proofOfService.id))
    .as("latest_weight")
  const pickupGroups = await tx
    .select({ projectId: latest.projectId, wasteFractionId: latest.wasteFractionId, wasteFractionName: wasteFraction.name, day: latest.operatingDate, weightKg: total(latest.weightKg), n: count() })
    .from(latest)
    .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, principal.companyId), eq(wasteFraction.id, latest.wasteFractionId)))
    .groupBy(latest.projectId, latest.wasteFractionId, wasteFraction.name, latest.operatingDate)

  const totals = { ...noWeights(), pickupWeightKg: 0, weighedPickups: 0 }
  const rows = new Map<string, TonnageRow>()
  for (const group of unloadGroups) {
    const standing = unloadStanding(group.status as WeightReviewStatus)
    // A corrected unload's weight is its correction's, counted on that row.
    if (standing === "superseded") continue
    const span = intervalOf(group.day, window, query.interval)
    const key = [span.from, group.projectId, group.wasteFractionId, group.unloadingStationId].join("|")
    const row = rows.get(key) ?? { ...span, projectId: group.projectId, wasteFractionId: group.wasteFractionId, wasteFractionName: group.wasteFractionName, unloadingStationId: group.unloadingStationId, unloadingStationName: group.unloadingStationName, ...noWeights() }
    rows.set(key, row)
    for (const tally of [row, totals]) {
      if (standing === "rejected") {
        tally.rejectedKg += group.netKg
        tally.rejectedUnloads += group.n
      } else {
        tally.netKg += group.netKg
        tally.unloads += group.n
        if (standing === "approved") tally.approvedKg += group.netKg
        else tally.capturedKg += group.netKg
      }
    }
  }
  const weights = new Map<string, PickupWeightRow>()
  for (const group of pickupGroups) {
    const span = intervalOf(group.day, window, query.interval)
    const key = [span.from, group.projectId, group.wasteFractionId].join("|")
    const row = weights.get(key) ?? { ...span, projectId: group.projectId, wasteFractionId: group.wasteFractionId, wasteFractionName: group.wasteFractionName, weightKg: 0, pickups: 0 }
    weights.set(key, row)
    row.weightKg += group.weightKg
    row.pickups += group.n
    totals.pickupWeightKg += group.weightKg
    totals.weighedPickups += group.n
  }
  return {
    window: windowOf(query),
    totals,
    unloads: [...rows.values()].sort(
      (a, b) => a.from.localeCompare(b.from) || a.projectId.localeCompare(b.projectId) || byName(a.wasteFractionName, b.wasteFractionName) || byName(a.unloadingStationName, b.unloadingStationName),
    ),
    pickupWeights: [...weights.values()].sort((a, b) => a.from.localeCompare(b.from) || a.projectId.localeCompare(b.projectId) || byName(a.wasteFractionName, b.wasteFractionName)),
  }
}

/** A report's handler: the project the query names held to the caller's, then the report read inside the request's transaction. */
function answer<Query extends WindowQuery, Report>(read: (tx: Tx, principal: Principal, query: Query) => Promise<Report>) {
  return async (c: Context<AuthEnv>, query: Query) => {
    const principal = c.get("principal")
    if (query.projectId !== undefined) requireProject(principal, query.projectId, "projectId", "query")
    return c.json(await read(c.get("tx"), principal, query))
  }
}

export function reportRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  const service = answer(serviceReport)
  const tickets = answer((tx, principal, query: TicketReportQuery) => ticketReport(tx, principal, query, now()))
  const revenue = answer(revenueReport)
  const tonnage = answer(tonnageReport)
  return new Hono<AuthEnv>()
    .get(
      "/reports/service",
      describeRoute({
        operationId: "getServiceReport",
        summary: "How the routes ran and their pickups were served",
        description: `The routes operating in the window — a regeneration's cancellations left out, since the occurrence they stood for is gone — by status, how many went out, and whether they went out on time: started no later than the planned start on the project's clock on the operating date plus ${ON_TIME_GRACE_MINUTES} minutes, a route with no planned start counted apart as unjudged. And their pickups by standing: completed, missed (skipped or failed, with the reasons), open (still planned) and withdrawn (taken off by a regeneration or removed by the dispatcher, counted in nothing else); \`due\` is completed, missed and open. The collection and missed rates are over the pickups with an outcome, the on-time rate over the routes judged; each is null where there was nothing to divide by. The same counts per interval of the series, every interval present, and per Route Scheme with a route in the window, the office's ad-hoc routes (no scheme) in a row of their own per project with \`routeSchemeId\` and \`name\` null. ${WINDOW_SENTENCE} \`wasteFractionId\` narrows the pickups to one fraction and the routes to the ones holding a pickup of it; \`routeSchemeId\` to one scheme's routes.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The service report.", ServiceReport),
          400: describeProblem(`The query does not parse: ${WINDOW_REFUSED}, or a filter is not an id.`),
          401: DESCRIBE_401,
          403: describe403(PERFORMANCE, "route-studio.routes"),
        },
      }),
      guard,
      requireGrant(PERFORMANCE, "view"),
      requireGrant("route-studio.routes", "view"),
      validate("query", ServiceReportQuery),
      (c) => service(c, c.req.valid("query")),
    )
    .get(
      "/reports/tickets",
      describeRoute({
        operationId: "getTicketReport",
        summary: "How the tickets were opened and closed",
        description: `The tickets opened over the window — made on one of its days, on the project's clock; the ticket list's own window reads \`occurredAt\` instead, when the issue happened — and closed over it, completed or rejected, with how many of the closed had a due time and how many were closed by it; and, whatever the window, the tickets open now (open, in progress, pending or on hold) with how many are past their due time and how many routes they name. \`asOf\` is the instant "now" was read at. By kind, the kinds with any, and per interval of the series, every interval present. ${WINDOW_SENTENCE}`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket report.", TicketReport),
          400: describeProblem(`The query does not parse: ${WINDOW_REFUSED}.`),
          401: DESCRIBE_401,
          403: describe403(PERFORMANCE, "operate.tickets"),
        },
      }),
      guard,
      requireGrant(PERFORMANCE, "view"),
      requireGrant("operate.tickets", "view"),
      validate("query", TicketReportQuery),
      (c) => tickets(c, c.req.valid("query")),
    )
    .get(
      "/reports/revenue",
      describeRoute({
        operationId: "getRevenueReport",
        summary: "What was invoiced",
        description: `The documents issued over the window — invoices and credit notes, by \`issuedOn\` — by currency, never summed across two: how many of each and their net, VAT and gross in minor units, a credit note's negative. The same per interval of the series and currency, an interval without a document absent, and per product and currency: the quantity, a line that takes the service back (a credit note's, a reversal's) counted against it, and the net, largest first. ${WINDOW_SENTENCE}`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The revenue report.", RevenueReport),
          400: describeProblem(`The query does not parse: ${WINDOW_REFUSED}.`),
          401: DESCRIBE_401,
          403: describe403(ANALYTICS, "commercial.invoices"),
        },
      }),
      guard,
      requireGrant(ANALYTICS, "view"),
      requireGrant("commercial.invoices", "view"),
      validate("query", RevenueReportQuery),
      (c) => revenue(c, c.req.valid("query")),
    )
    .get(
      "/reports/tonnage",
      describeRoute({
        operationId: "getTonnageReport",
        summary: "What was unloaded and weighed",
        description: `The unloads of the window — recorded at a station on one of its days, on the project's clock — by project, fraction, station and interval of the series, a combination without an unload absent: their net weight in whole kilograms by weight review, \`approvedKg\` and \`capturedKg\` (nobody has reviewed it yet) making up \`netKg\`, and a rejected unload's weight beside them and in no total; a corrected unload is not counted, its correction is. And the weights recorded at the pickups (the \`weight\` proof, a lifter's or a hand scale's reading, each pickup's latest) of the pickups collected on the window's routes, by project, fraction and the route's operating day's interval. ${WINDOW_SENTENCE} \`wasteFractionId\` narrows both to one fraction, \`unloadingStationId\` the unloads to one station.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The tonnage report.", TonnageReport),
          400: describeProblem(`The query does not parse: ${WINDOW_REFUSED}, or a filter is not an id.`),
          401: DESCRIBE_401,
          403: describe403(ANALYTICS, "route-studio.weights"),
        },
      }),
      guard,
      requireGrant(ANALYTICS, "view"),
      requireGrant("route-studio.weights", "view"),
      validate("query", TonnageReportQuery),
      (c) => tonnage(c, c.req.valid("query")),
    )
}
