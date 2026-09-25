// Settlements (Issue #112, §3 "Settlements", §5): "the period calculation
// and record of amounts due to or from a service provider" (CONTEXT.md). The
// record is a row of `settlement` — an assignment's, over a period whose end
// is given, the `validity` set being the period, so `settlement_no_overlap`
// over the assignment holds one settlement of an assignment at a time — with
// a status its period cannot say (open, calculated, closed) and the stamps
// the status carries; the calculation is `settlement_line`, replaced whole on
// every `calculate`; and the history is `settlement_event`, a ledger row per
// `calculate`, `close` and `reopen` carrying the snapshot after it — the
// Vehicle Allocation's pattern (routes/vehicle-allocations.ts): the row is
// what the database holds, the events the ledger nobody rewrites, and every
// command that changes the row appends one in the same transaction, so the
// history is complete by construction.
//
// Seven routes over six paths under `commercial.settlements`: the list and
// the create, the read, the three commands, the history. `POST /settlements`
// (`create`) opens one on an assignment of a project the caller works in over
// a period — both days given, the end the first day out (the contracts'
// `A_PERIOD_ENDS`, `ENDS_AFTER_IT_STARTS`) — and `refuseOverlap` turns the
// constraint into "This assignment already has a settlement over part of
// that period". The period is not held inside the assignment's (#112 §7.16):
// a correction that lands in the month after an award ended is settled then.
//
// The calculation (`calculate`, `edit`), on `open` or `calculated`, replaces
// the lines whole: it selects every Billable Event of the project with a
// `service_date` in the period that is priced and not cancelled — reversals
// included, at their negative amounts, reaching their route through the event
// they undo — whose route's scheme's planning area is one of the assignment's
// area's and whose service date the assignment and the area were both valid
// on (§3's predicate as a join, the settlement's own assignment in place of
// the caller's provider), prices each with the provider price of the
// assignment for the event's product valid on the service date (`validOn`;
// the resolver is not needed, a provider price having no conditions) or
// leaves it unpriced, writes the lines, the row's `line_count`, `net_minor`
// and `calculated_at`, and appends a `calculated` event. A line's net is the
// fee times the quantity, negated on a reversal, the way the event's own
// amount is (`billable_event_amounts_shape`). `close` (`edit`), on
// `calculated`, is refused while any line is unpriced (409, "3 lines have no
// service provider price for their product; add the prices and calculate
// again", `refuseStranded` over them) and while any event of the period
// served under the assignment is not on a line (409, "2 events of the period
// are not in this calculation; calculate again" — an event recorded after the
// last calculation), then stamps `closed_at` and `closed_by`, appends a
// `closed` event with the snapshot, and emits `settlement-closed` with the
// `SettlementDetail` — the e-conomic export's door for a provider's
// accounting; the lines stand still from here, since nothing writes them on a
// closed settlement, which is the frozen snapshot the provider is told.
// `reopen` (`edit`) with a reason: `closed → open`, both stamps cleared, the
// lines kept until the next calculation, a `reopened` event carrying the
// reason — "Reopening requires permission, reason, and audit history".
//
// The machine is the domain's (`settlementTransition`,
// @waste/domain/finance/transitions): `stay` answers 200 without a write and
// without an event — `close` on a closed settlement, `reopen` on an open or a
// calculated one — and `refuse` its sentence as the 409, "Settlement NordRen
// ApS · 2026-07-01–2026-07-31 has not been calculated; calculate it first",
// "… is closed; reopen it first". A settlement is named by its provider and
// its period as a person reads one, the last day inside it and not the first
// day out. Every command takes `lockRow(settlement)` before it reads, so two
// commands on one settlement take turns and a calculation and a close never
// interleave.
//
// Who reaches what (#112 §3 "Who a provider is", §7.22). An office account
// reaches the settlements of the projects it works in, the tenant and
// `inProjects` like every project-scoped family. A Service Provider's account
// — Lars, the manager at NordRen, no projects — reaches its own: every
// statement is bounded by `reaches(principal)`, `assignment.service_provider_id
// = <the principal's provider>` for an account with a provider and
// `inProjects` for one with projects, never both widened, so the manager
// reads NordRen's settlements with their lines and totals — a line carries
// the provider price alone, never a customer's — and CityHaul's are a 404.
// slice 3 spells this once as `reachesAssignments` in auth/provider.ts for
// the four families a provider reads; until the integrator folds the two,
// `reaches` below is that rule over this table's join.
import { Page } from "@waste/contracts/pagination"
import { SettlementCalculate, SettlementClose, SettlementCreate, SettlementDetail, SettlementEvent, SettlementEventListQuery, SettlementListQuery, SettlementReopen, type Settlement, type SettlementLine } from "@waste/contracts/settlements"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { route } from "@waste/db/schema/execution"
import { billableEvent, serviceArea, serviceAreaAssignment, serviceAreaPlanningArea, serviceProviderPrice, settlement, settlementEvent, settlementLine } from "@waste/db/schema/finance"
import { project, serviceProvider } from "@waste/db/schema/organisation"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { settlementTransition, type SettlementCommand } from "@waste/domain/finance/transitions"
import type { SettlementEventKind, SettlementStatus } from "@waste/domain/finance/vocabulary"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, eq, gt, gte, isNull, lt, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { refuseStranded } from "./periods"
import { requireServiceAreaAssignment } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, instantOf, lockRow, refuseOverlap, stampsOf } from "./shared"

const MODULE = "commercial.settlements"

const SettlementPage = Page(SettlementDetail)
const EventPage = Page(SettlementEvent)

/** The sentence `settlement_no_overlap` answers with: one settlement of an assignment over a period. */
export const ONE_SETTLEMENT_AT_A_TIME = "This assignment already has a settlement over part of that period"

/** A close over a calculation with lines no provider price covers. */
export const unpricedLines = (rows: number): string =>
  rows === 1 ? "1 line has no service provider price for its product; add the price and calculate again" : `${rows} lines have no service provider price for their product; add the prices and calculate again`

/** A close over a calculation the period has outgrown: events served under the assignment that are on no line. */
export const eventsMissed = (rows: number): string => (rows === 1 ? "1 event of the period is not in this calculation; calculate again" : `${rows} events of the period are not in this calculation; calculate again`)

/** A settlement outside what the account reaches, or none: one sentence for the office's projects and the provider's own assignments alike. */
const noSuchSettlement = (id: string) => problem(404, { detail: `No settlement ${id} this account reaches` })

const columns = {
  id: settlement.id,
  projectId: settlement.projectId,
  serviceAreaAssignmentId: settlement.serviceAreaAssignmentId,
  status: settlement.status,
  currency: settlement.currency,
  calculatedAt: settlement.calculatedAt,
  closedAt: settlement.closedAt,
  closedBy: settlement.closedBy,
  lineCount: settlement.lineCount,
  netMinor: settlement.netMinor,
  validFrom: settlement.validFrom,
  validTo: settlement.validTo,
  createdAt: settlement.createdAt,
  updatedAt: settlement.updatedAt,
}

/** The settlement's columns and, through its assignment, whose it is: the provider's id for the scope and its name for the sentences. */
type Row = Pick<typeof settlement.$inferSelect, keyof typeof columns> & { serviceProviderId: string; providerLegalName: string }

/** How every sentence names a settlement: the provider and the period as a person reads it, `NordRen ApS · 2026-07-01–2026-07-31`, the last day inside and not the first day out. */
const labelOf = (row: Row): string => `${row.providerLegalName} · ${row.validFrom}–${addDays(periodEnd(row), -1)}`

/** The end every settlement has (`settlement_period_closed`): a null beside a settlement is a broken invariant, not a client's doing. */
function periodEnd(row: { id: string; validTo: string | null }): string {
  if (row.validTo === null) throw new Error(`settlement ${row.id} has no end to its period`)
  return row.validTo
}

/** The row on the wire. The status is text with a CHECK in the database and an enum here. */
function settlementOf(row: Row): Settlement {
  return {
    id: row.id,
    projectId: row.projectId,
    serviceAreaAssignmentId: row.serviceAreaAssignmentId,
    status: row.status as SettlementStatus,
    currency: row.currency,
    calculatedAt: instantOf(row.calculatedAt),
    closedAt: instantOf(row.closedAt),
    closedBy: row.closedBy,
    lineCount: row.lineCount,
    netMinor: row.netMinor,
    validFrom: row.validFrom,
    validTo: periodEnd(row),
    ...stampsOf(row),
  }
}

/**
 * What an account reaches (#112 §3): an account with a provider its own
 * assignments' settlements, an account with projects its projects', never
 * both widened. `inProjects` is `false` for an account with neither.
 */
const reaches = (principal: Principal): SQL => (principal.serviceProvider === null ? inProjects(settlement.projectId, principal) : eq(serviceAreaAssignment.serviceProviderId, principal.serviceProvider.id))

/** The settlements of this company the caller reaches: what every settlement statement is bounded by. */
const settlementScope = (principal: Principal): SQL | undefined => and(eq(settlement.companyId, principal.companyId), reaches(principal))

/** The one statement every settlement is read through: the row with its assignment's provider joined, for the scope and the sentences. */
function settlementsFrom(tx: Tx) {
  return tx
    .select({ ...columns, serviceProviderId: serviceAreaAssignment.serviceProviderId, providerLegalName: serviceProvider.legalName })
    .from(settlement)
    .innerJoin(serviceAreaAssignment, and(eq(serviceAreaAssignment.companyId, settlement.companyId), eq(serviceAreaAssignment.id, settlement.serviceAreaAssignmentId)))
    .innerJoin(serviceProvider, and(eq(serviceProvider.companyId, settlement.companyId), eq(serviceProvider.id, serviceAreaAssignment.serviceProviderId)))
}

/** One settlement of this company by id, inside what the caller reaches; undefined when it is neither. */
async function findSettlement(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await settlementsFrom(tx)
    .where(and(settlementScope(principal), eq(settlement.id, id)))
    .limit(1)
  return row
}

/** The settlement the path names, locked and read: the three commands hold rules the API holds — the machine, the two counts of `close` — so they take the row lock first and read afterwards (routes/shared.ts). */
async function lockedSettlement(tx: Tx, principal: Principal, id: string): Promise<Row> {
  await lockRow(tx, settlement, { companyId: principal.companyId, id })
  const current = await findSettlement(tx, principal, id)
  if (current === undefined) throw noSuchSettlement(id)
  return current
}

const lineColumns = {
  id: settlementLine.id,
  settlementId: settlementLine.settlementId,
  billableEventId: settlementLine.billableEventId,
  serviceProviderPriceId: settlementLine.serviceProviderPriceId,
  quantity: settlementLine.quantity,
  unitPriceMinor: settlementLine.unitPriceMinor,
  netMinor: settlementLine.netMinor,
  createdAt: settlementLine.createdAt,
  updatedAt: settlementLine.updatedAt,
}

type LineRow = Pick<typeof settlementLine.$inferSelect, keyof typeof lineColumns>

const lineOf = (row: LineRow): SettlementLine => ({
  id: row.id,
  settlementId: row.settlementId,
  billableEventId: row.billableEventId,
  serviceProviderPriceId: row.serviceProviderPriceId,
  quantity: row.quantity,
  unitPriceMinor: row.unitPriceMinor,
  netMinor: row.netMinor,
  ...stampsOf(row),
})

/** One settlement's lines, by event. */
async function linesOf(tx: Tx, companyId: string, settlementId: string): Promise<LineRow[]> {
  return await tx
    .select(lineColumns)
    .from(settlementLine)
    .where(and(eq(settlementLine.companyId, companyId), eq(settlementLine.settlementId, settlementId)))
    .orderBy(asc(settlementLine.billableEventId))
}

/** The settlement with its lines: what the read, the create and every command answer, so what a write says is what the next read says. */
async function detailOf(tx: Tx, companyId: string, row: Row): Promise<SettlementDetail> {
  const lines = await linesOf(tx, companyId, row.id)
  return { ...settlementOf(row), lines: lines.map(lineOf) }
}

/** A page's lines in one statement, grouped by settlement, so fifty settlements cost one read and not fifty. */
async function linesBySettlement(tx: Tx, companyId: string, ids: readonly string[]): Promise<Map<string, LineRow[]>> {
  const grouped = new Map<string, LineRow[]>(ids.map((id) => [id, []]))
  if (ids.length === 0) return grouped
  const rows = await tx
    .select(lineColumns)
    .from(settlementLine)
    .where(and(eq(settlementLine.companyId, companyId), sql`${settlementLine.settlementId} in ${sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`}`))
    .orderBy(asc(settlementLine.billableEventId))
  for (const row of rows) grouped.get(row.settlementId)?.push(row)
  return grouped
}

const eventColumns = {
  id: settlementEvent.id,
  recordedAt: settlementEvent.recordedAt,
  settlementId: settlementEvent.settlementId,
  kind: settlementEvent.kind,
  status: settlementEvent.status,
  lineCount: settlementEvent.lineCount,
  netMinor: settlementEvent.netMinor,
  reason: settlementEvent.reason,
  recordedBy: settlementEvent.recordedBy,
}

type EventRow = Pick<typeof settlementEvent.$inferSelect, keyof typeof eventColumns>

const eventOf = (row: EventRow): SettlementEvent => ({
  id: row.id,
  recordedAt: row.recordedAt.toISOString(),
  settlementId: row.settlementId,
  kind: row.kind as SettlementEventKind,
  status: row.status as SettlementStatus,
  lineCount: row.lineCount,
  netMinor: row.netMinor,
  reason: row.reason,
  recordedBy: row.recordedBy,
})

/** The history's row for a command that moved the settlement: the kind, the status and the totals after it, the reason of a reopening, who did it. */
async function appendEvent(tx: Tx, principal: Principal, row: Row, kind: SettlementEventKind, reason: string | null): Promise<void> {
  await tx.insert(settlementEvent).values({
    id: newId(),
    companyId: principal.companyId,
    projectId: row.projectId,
    settlementId: row.id,
    kind,
    status: row.status,
    lineCount: row.lineCount,
    netMinor: row.netMinor,
    reason,
    recordedBy: principal.user.id,
  })
}

/** What a command sets on the row beside the status. */
type Stamped = Partial<Pick<typeof settlement.$inferInsert, "calculatedAt" | "closedAt" | "closedBy" | "lineCount" | "netMinor">>

/** Moves the row to a status with what the command carries beside it, and answers it as written — the provider carried over from the read, since the assignment does not move. */
async function setStatus(tx: Tx, principal: Principal, current: Row, status: SettlementStatus, beside: Stamped): Promise<Row> {
  const [row] = await tx
    .update(settlement)
    .set({ status, ...beside })
    .where(and(eq(settlement.companyId, principal.companyId), eq(settlement.id, current.id)))
    .returning(columns)
  if (row === undefined) throw noSuchSettlement(current.id)
  return { ...row, serviceProviderId: current.serviceProviderId, providerLegalName: current.providerLegalName }
}

/** The machine's answer for a command on the row as read: the 409 in its words, `stay`, or the status to move to. */
function transitionOf(current: Row, command: SettlementCommand): { kind: "stay" } | { kind: "move"; to: SettlementStatus } {
  const transition = settlementTransition(current.status as SettlementStatus, command, labelOf(current))
  if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
  return transition
}

/** One event served under the settlement's assignment, with the provider price valid on its service date or none. */
type Served = { eventId: string; kind: string; quantity: number; priceId: string | null; unitPriceMinor: number | null }

/**
 * §3's predicate as a join, the settlement's own assignment in place of the
 * caller's provider: every Billable Event of the project with a service date
 * in the period, priced and not cancelled — a reversal included, reaching its
 * route through the event it undoes, since it names no pickup of its own —
 * whose route's scheme's planning area is one of the assignment's area's,
 * and whose service date the assignment and the area were both valid on. A
 * route whose scheme has no planning area serves nobody's award. Each event
 * comes with the one provider price of the assignment for its product valid
 * on the day (`service_provider_price_no_overlap` holds it to one), or none.
 * In id order, so the lines are minted in the order the events were.
 */
async function servedEvents(tx: Tx, companyId: string, current: Row): Promise<Served[]> {
  const original = alias(billableEvent, "original")
  const servedRouteId = sql`coalesce(${billableEvent.routeId}, ${original.routeId})`
  return await tx
    .select({
      eventId: billableEvent.id,
      kind: billableEvent.kind,
      quantity: billableEvent.quantity,
      priceId: serviceProviderPrice.id,
      unitPriceMinor: serviceProviderPrice.unitPriceMinor,
    })
    .from(billableEvent)
    .leftJoin(original, and(eq(original.companyId, billableEvent.companyId), eq(original.id, billableEvent.reversesEventId)))
    .innerJoin(route, and(eq(route.companyId, billableEvent.companyId), eq(route.id, servedRouteId)))
    .innerJoin(routeScheme, and(eq(routeScheme.companyId, route.companyId), eq(routeScheme.id, route.routeSchemeId)))
    .innerJoin(serviceAreaAssignment, and(eq(serviceAreaAssignment.companyId, billableEvent.companyId), eq(serviceAreaAssignment.id, current.serviceAreaAssignmentId)))
    .innerJoin(serviceArea, and(eq(serviceArea.companyId, serviceAreaAssignment.companyId), eq(serviceArea.id, serviceAreaAssignment.serviceAreaId)))
    .innerJoin(
      serviceAreaPlanningArea,
      and(eq(serviceAreaPlanningArea.companyId, serviceArea.companyId), eq(serviceAreaPlanningArea.serviceAreaId, serviceArea.id), eq(serviceAreaPlanningArea.planningAreaId, routeScheme.planningAreaId)),
    )
    .leftJoin(
      serviceProviderPrice,
      and(
        eq(serviceProviderPrice.companyId, billableEvent.companyId),
        eq(serviceProviderPrice.serviceAreaAssignmentId, serviceAreaAssignment.id),
        eq(serviceProviderPrice.productId, billableEvent.productId),
        validOn(serviceProviderPrice, billableEvent.serviceDate),
      ),
    )
    .where(
      and(
        eq(billableEvent.companyId, companyId),
        eq(billableEvent.projectId, current.projectId),
        gte(billableEvent.serviceDate, current.validFrom),
        lt(billableEvent.serviceDate, periodEnd(current)),
        isNull(billableEvent.blockReason),
        isNull(billableEvent.cancelledAt),
        validOn(serviceAreaAssignment, billableEvent.serviceDate),
        validOn(serviceArea, billableEvent.serviceDate),
      ),
    )
    .orderBy(asc(billableEvent.id))
}

/** A line's amount: the fee times the quantity, negated on a reversal, the way the event's own is; null where no price covers the product on the day. */
const lineNet = (event: Served): number | null => (event.unitPriceMinor === null ? null : (event.kind === "reversal" ? -1 : 1) * event.unitPriceMinor * event.quantity)

/** How many lines one insert carries: nine parameters a line, well under Postgres's ceiling of 65 535. */
const LINES_PER_INSERT = 1000

/**
 * The calculation: the lines replaced whole — delete-then-insert inside the
 * request's transaction, never a diff, the set mechanism — and the totals
 * summed over the priced lines.
 */
async function calculate(tx: Tx, principal: Principal, current: Row, at: Date): Promise<Row> {
  const served = await servedEvents(tx, principal.companyId, current)
  const lines = served.map((event) => ({
    id: newId(),
    companyId: principal.companyId,
    projectId: current.projectId,
    settlementId: current.id,
    billableEventId: event.eventId,
    serviceProviderPriceId: event.priceId,
    quantity: event.quantity,
    unitPriceMinor: event.unitPriceMinor,
    netMinor: lineNet(event),
  }))
  await tx.delete(settlementLine).where(and(eq(settlementLine.companyId, principal.companyId), eq(settlementLine.settlementId, current.id)))
  for (let start = 0; start < lines.length; start += LINES_PER_INSERT) {
    await tx.insert(settlementLine).values(lines.slice(start, start + LINES_PER_INSERT))
  }
  const netMinor = lines.reduce((sum, line) => sum + (line.netMinor ?? 0), 0)
  return await setStatus(tx, principal, current, "calculated", { calculatedAt: at, lineCount: lines.length, netMinor })
}

const commandProblems = {
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\`.`),
  404: describeProblem("No settlement with that id among those this account reaches."),
}

const REACH = "An office account reaches the settlements of the projects it works in; a service provider's account reaches the settlements of its own assignments and nothing else, so a settlement of another provider is one that does not exist here."
const LABEL = "A settlement is named by its provider and its period, the last day inside it: `Settlement NordRen ApS · 2026-07-01–2026-07-31`."

export function settlementRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/settlements",
      describeRoute({
        operationId: "listSettlements",
        summary: "The settlements the caller reaches",
        description:
          "One page of settlements with their lines, oldest first (ids are time-ordered). " +
          REACH +
          " `projectId` narrows the page to one project the caller works in, naming another being refused (400 on the query, and always for a provider's account, which works in none); `serviceAreaAssignmentId` to one assignment's, `serviceProviderId` to every assignment naming that provider, `status` to open, calculated or closed, and `validOn` to the settlements whose period covers that day. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of settlements, each with its lines.", SettlementPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", SettlementListQuery),
      async (c) => {
        const { limit, cursor, projectId, serviceAreaAssignmentId, serviceProviderId, status, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await settlementsFrom(tx)
          .where(
            and(
              settlementScope(principal),
              projectId === undefined ? undefined : eq(settlement.projectId, projectId),
              serviceAreaAssignmentId === undefined ? undefined : eq(settlement.serviceAreaAssignmentId, serviceAreaAssignmentId),
              serviceProviderId === undefined ? undefined : eq(serviceAreaAssignment.serviceProviderId, serviceProviderId),
              status === undefined ? undefined : eq(settlement.status, status),
              day === undefined ? undefined : validOn(settlement, day),
              after === undefined ? undefined : gt(settlement.id, after),
            ),
          )
          .orderBy(asc(settlement.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        const lines = await linesBySettlement(
          tx,
          principal.companyId,
          items.map((row) => row.id),
        )
        return c.json({ items: items.map((row) => ({ ...settlementOf(row), lines: (lines.get(row.id) ?? []).map(lineOf) })), nextCursor })
      },
    )
    .post(
      "/settlements",
      describeRoute({
        operationId: "createSettlement",
        summary: "Open a settlement",
        description:
          "Opens a settlement for a service area assignment over a period: `serviceAreaAssignmentId` an assignment of a project this account works in (400, `Not an assignment of this project`; a provider's account works in none and opens nothing), `validFrom` the first day of the period and `validTo` the first day after it, both given — a settlement settles a period, so its end is required (400 at `validTo`) and comes after its start. The settlement is the assignment's project's, in that project's currency, `open`, with no lines and no history yet; `calculate` writes both. The database holds one settlement of an assignment at a time, so a period touching another settlement of the same assignment is refused (409, `This assignment already has a settlement over part of that period`). The period is not held inside the assignment's: a correction that lands in the month after an award ended is settled then. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The settlement as it was opened, with no lines.", SettlementDetail),
          400: describeProblem("The body is missing a field, names a member the server owns, has no end or an end on or before its start, or names an assignment that is not one of a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
          409: describeProblem("This assignment already has a settlement over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", SettlementCreate),
      async (c) => {
        const { serviceAreaAssignmentId, validFrom, validTo } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const assignment = await requireServiceAreaAssignment(tx, { companyId: principal.companyId, projectId: projectIdsOf(principal) }, serviceAreaAssignmentId)
        const [owner] = await tx
          .select({ currency: project.currency })
          .from(project)
          .where(and(eq(project.companyId, principal.companyId), eq(project.id, assignment.projectId)))
          .limit(1)
        if (owner === undefined) throw new Error(`assignment ${assignment.id} is in project ${assignment.projectId}, which is not there`)
        const [row] = await refuseOverlap({ settlement_no_overlap: ONE_SETTLEMENT_AT_A_TIME }, () =>
          tx
            .insert(settlement)
            .values({
              id: newId(),
              companyId: principal.companyId,
              projectId: assignment.projectId,
              serviceAreaAssignmentId: assignment.id,
              status: "open",
              currency: owner.currency,
              validFrom,
              validTo,
            })
            .returning(columns),
        )
        const written = await findSettlement(tx, principal, row.id)
        if (written === undefined) throw new Error(`settlement ${row.id} was written and cannot be read back`)
        return created(c, "/settlements", { ...settlementOf(written), lines: [] })
      },
    )
    .get(
      "/settlements/:id",
      describeRoute({
        operationId: "getSettlement",
        summary: "One settlement with its lines",
        description:
          "One settlement the caller reaches, with its calculation: the lines by event, each the billable event settled, the provider price that priced it — null with the unit price and the net where none of the assignment's prices covered the product on the event's service date, which blocks `close` — the quantity and the net, negative on a reversal. " +
          REACH,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The settlement with its lines.", SettlementDetail),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: commandProblems[404],
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findSettlement(tx, principal, id)
        if (row === undefined) throw noSuchSettlement(id)
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .post(
      "/settlements/:id/calculate",
      describeRoute({
        operationId: "calculateSettlement",
        summary: "Calculate a settlement's lines",
        description:
          "The `calculate` command, on an open or a calculated settlement: replaces the lines whole. Selects every billable event of the project whose service date lies in the period, priced and not cancelled — reversals included, at their negative amounts — whose route's scheme's planning area is one of the assignment's service area's, and whose service date the assignment and the area were both valid on; prices each with the assignment's provider price for the event's product valid on that service date, or leaves it unpriced when none covers it; writes one line per event, the settlement's `lineCount`, `netMinor` (the priced lines summed) and `calculatedAt`, and appends a `calculated` event with the snapshot. A recalculation is a move like the first: the lines change and the history gets its row. The body is empty; a member in it is refused. A closed settlement is refused (409, `Settlement NordRen ApS · 2026-07-01–2026-07-31 is closed; reopen it first`). Runs under the settlement's row lock. " +
          LABEL,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The settlement, calculated, with its lines.", SettlementDetail),
          400: describeProblem("The path does not hold an id, or the body carries a member."),
          ...commandProblems,
          409: describeProblem("The settlement is closed; reopen it first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SettlementCalculate),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedSettlement(tx, principal, id)
        // `calculate` never stays: a recalculation is a move (the domain's machine).
        transitionOf(current, "calculate")
        const row = await calculate(tx, principal, current, now())
        await appendEvent(tx, principal, row, "calculated", null)
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .post(
      "/settlements/:id/close",
      describeRoute({
        operationId: "closeSettlement",
        summary: "Close a settlement",
        description:
          "The `close` command, on a calculated settlement: refused while any line has no provider price (409, `3 lines have no service provider price for their product; add the prices and calculate again`) and while any event of the period served under the assignment is on no line — one recorded after the last calculation (409, `2 events of the period are not in this calculation; calculate again`); then `closedAt` and `closedBy` are stamped, a `closed` event appended with the snapshot, and `settlement-closed` written to the outbox in the same transaction, carrying the settlement with its lines as answered. The lines stand still from here: nothing writes them on a closed settlement, and its totals are what the provider is told. An open settlement is refused (409, `Settlement NordRen ApS · 2026-07-01–2026-07-31 has not been calculated; calculate it first`); a closed one answers 200 as it stands, without a write, an event or an outbox row. The body is empty; a member in it is refused. Runs under the settlement's row lock. " +
          LABEL,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The settlement, closed, with its lines.", SettlementDetail),
          400: describeProblem("The path does not hold an id, or the body carries a member."),
          ...commandProblems,
          409: describeProblem("The settlement has not been calculated, a line has no provider price, or an event of the period is not in the calculation; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SettlementClose),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedSettlement(tx, principal, id)
        const transition = transitionOf(current, "close")
        if (transition.kind === "stay") return c.json(await detailOf(tx, principal.companyId, current))
        // The calculation's two gaps, the unpriced first: a price is what the office adds, a recalculation what it then runs.
        await refuseStranded(tx, settlementLine, and(eq(settlementLine.companyId, principal.companyId), eq(settlementLine.settlementId, current.id), isNull(settlementLine.serviceProviderPriceId)), unpricedLines)
        const [served, lines] = await Promise.all([servedEvents(tx, principal.companyId, current), linesOf(tx, principal.companyId, current.id)])
        const onALine = new Set(lines.map((line) => line.billableEventId))
        const missed = served.filter((event) => !onALine.has(event.eventId)).length
        if (missed > 0) throw problem(409, { detail: eventsMissed(missed) })
        const at = now()
        const row = await setStatus(tx, principal, current, "closed", { closedAt: at, closedBy: principal.user.id })
        await appendEvent(tx, principal, row, "closed", null)
        const answered = await detailOf(tx, principal.companyId, row)
        await emit(tx, principal, { aggregate: "settlement", aggregateId: row.id, kind: "settlement-closed", payload: answered, projectId: row.projectId, occurredAt: at })
        return c.json(answered)
      },
    )
    .post(
      "/settlements/:id/reopen",
      describeRoute({
        operationId: "reopenSettlement",
        summary: "Reopen a closed settlement",
        description:
          "The `reopen` command, with a reason: a closed settlement becomes `open`, both stamps cleared, its lines kept until the next calculation, and a `reopened` event appended carrying the reason — reopening requires permission, a reason and an audit history, and a later correction to a period the provider was told is this and then a recalculation. An open or a calculated settlement answers 200 as it stands, without a write or an event. Runs under the settlement's row lock. " +
          LABEL,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The settlement, open, with the lines it kept.", SettlementDetail),
          400: describeProblem("The path does not hold an id, or the body has no reason or carries a member the command does not take."),
          ...commandProblems,
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", SettlementReopen),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedSettlement(tx, principal, id)
        const transition = transitionOf(current, "reopen")
        if (transition.kind === "stay") return c.json(await detailOf(tx, principal.companyId, current))
        const row = await setStatus(tx, principal, current, "open", { calculatedAt: null, closedAt: null, closedBy: null })
        await appendEvent(tx, principal, row, "reopened", reason)
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .get(
      "/settlements/:id/events",
      describeRoute({
        operationId: "listSettlementEvents",
        summary: "One settlement's history",
        description:
          "One page of the settlement's events, oldest first — a cursor over time-ordered ids is a cursor over recording order — each carrying what was done (`calculated`, `closed`, `reopened`), the status and the totals after it, the reason of a reopening, and who did it; `kind` narrows the page to one. The ledger is append-only: nothing here is ever updated or removed. " +
          REACH +
          " Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the settlement's events, oldest first.", EventPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, the cursor is not one this API wrote, or `kind` is not one of the three."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: commandProblems[404],
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", SettlementEventListQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor, kind } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findSettlement(tx, principal, id)) === undefined) throw noSuchSettlement(id)
        const rows = await tx
          .select(eventColumns)
          .from(settlementEvent)
          .where(
            and(
              eq(settlementEvent.companyId, principal.companyId),
              eq(settlementEvent.settlementId, id),
              kind === undefined ? undefined : eq(settlementEvent.kind, kind),
              after === undefined ? undefined : gt(settlementEvent.id, after),
            ),
          )
          .orderBy(asc(settlementEvent.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(eventOf), nextCursor })
      },
    )
}
