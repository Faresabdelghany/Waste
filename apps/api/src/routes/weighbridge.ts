// A weighbridge's tickets (O27 of #290, row 8.8): `POST /weighbridge-tickets`
// is the ingest, vendor-neutral, a station's weighbridge posting the tickets
// it wrote; `GET /weighbridge-tickets` and `GET /weighbridge-tickets/:id` are
// the office's queue and its read; `POST /weighbridge-tickets/:id/match` and
// `/dismiss` are the office's two answers to a ticket that found no route.
//
// The ingest judges each ticket on its own, in the body's order, each in a
// savepoint, and answers one outcome per ticket — the bulk dispatch's pattern:
// a station not registered or an instant ahead of the clock is refused and
// not kept; a station's ticket number already known is a replay, answered
// with the ticket it is; anything else is kept, and matched where the domain's
// rule finds its route (`matchTicket`): the plate to a vehicle in the
// caller's projects, the vehicle's session spanning the instant (else its one
// active or completed route of the day, on its project's clock), the product
// to a fraction by key or by a waste code no other fraction has, and the
// station's acceptance of it. A matched ticket is written as its route's
// Unload — `source = integration`, no session, the weighbridge's weights and
// ticket number, recorded by the caller — under the route's lock, and
// `unload-recorded` is emitted with it, as the office's capture emits it.
//
// The ingest is no open door: the principal guard and `create` on
// `route-studio.weighbridge`, which the Integration Writer holds and nothing
// more of here; the body bounded before the token is read (413); a company's
// batches a minute bounded after it (429, `Retry-After`), per instance as the
// public door's allowance is; at most `WEIGHBRIDGE_BATCH_MAX` tickets, each
// field bounded by the contracts.
//
// A ticket's project is its vehicle's, or the route's it was matched to; one
// of a plate nobody in the caller's reach drives has none, and is read by any
// account of the company holding the grant — what it says is a plate, a
// station and a weight. Every statement carries the tenant, and the project
// fence where the ticket has a project.
import { Page } from "@waste/contracts/pagination"
import {
  WeighbridgeIngest,
  WeighbridgeTicket,
  WeighbridgeTicketBatch,
  WeighbridgeTicketDismiss,
  WeighbridgeTicketListQuery,
  WeighbridgeTicketMatch,
  type WeighbridgeTicketIn,
  type WeighbridgeTicketOutcome,
} from "@waste/contracts/weighbridge"
import type { Tx } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { route, session } from "@waste/db/schema/execution"
import { vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import { unloadingStation, unloadingStationFraction } from "@waste/db/schema/places"
import { weighbridgeTicket } from "@waste/db/schema/weighbridge"
import type { WeighbridgeTicketStatus, WeighbridgeUnmatchedReason } from "@waste/domain/execution/vocabulary"
import { fractionNamed, matchTicket, plateKey, WEIGHBRIDGE_BATCHES_PER_MINUTE, WEIGHBRIDGE_BODY_MAX_BYTES, type FractionCandidate } from "@waste/domain/execution/weighbridge"
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { describeRoute } from "hono-openapi"

import { Allowance } from "../auth/public-door"
import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { dayInTimezone } from "./days"
import { findRoute, noSuchRoute, unloadAnswered } from "./execution-shapes"
import { requireRoute, requireWasteFraction } from "./references"
import { requireRan } from "./routes"
import type { ClockOptions } from "./scheme-groups"
import { describeJson, IdParam, lockRow, OCCURRED_AT_SKEW_MS, stampsOf } from "./shared"
import { appendUnload, notTaken, stationTakes } from "./unload-writes"

const MODULE = "route-studio.weighbridge"

const TicketPage = Page(WeighbridgeTicket)

/** What the ingest may be handed, the bound and its allowance a test may lower. */
export type WeighbridgeOptions = ClockOptions & {
  /** Each company's batches a minute; a test injects a small allowance or a pinned clock. */
  allowance?: Allowance
  /** The body's bytes before the token is read; a test injects a small one. */
  maxBodyBytes?: number
}

const columns = {
  id: weighbridgeTicket.id,
  projectId: weighbridgeTicket.projectId,
  createdAt: weighbridgeTicket.createdAt,
  updatedAt: weighbridgeTicket.updatedAt,
  unloadingStationId: weighbridgeTicket.unloadingStationId,
  ticketNumber: weighbridgeTicket.ticketNumber,
  vehicleRegistration: weighbridgeTicket.vehicleRegistration,
  vehicleId: weighbridgeTicket.vehicleId,
  weighedAt: weighbridgeTicket.weighedAt,
  grossKg: weighbridgeTicket.grossKg,
  tareKg: weighbridgeTicket.tareKg,
  netKg: weighbridgeTicket.netKg,
  fractionKey: weighbridgeTicket.fractionKey,
  wasteCode: weighbridgeTicket.wasteCode,
  status: weighbridgeTicket.status,
  unmatchedReason: weighbridgeTicket.unmatchedReason,
  routeId: weighbridgeTicket.routeId,
  unloadId: weighbridgeTicket.unloadId,
  dismissedNote: weighbridgeTicket.dismissedNote,
  receivedBy: weighbridgeTicket.receivedBy,
}

type TicketRow = Pick<typeof weighbridgeTicket.$inferSelect, keyof typeof columns>

function ticketOf(row: TicketRow): WeighbridgeTicket {
  return {
    id: row.id,
    ...stampsOf(row),
    projectId: row.projectId,
    unloadingStationId: row.unloadingStationId,
    ticketNumber: row.ticketNumber,
    vehicleRegistration: row.vehicleRegistration,
    vehicleId: row.vehicleId,
    weighedAt: row.weighedAt.toISOString(),
    grossKg: row.grossKg,
    tareKg: row.tareKg,
    netKg: row.netKg,
    fractionKey: row.fractionKey,
    wasteCode: row.wasteCode,
    status: row.status as WeighbridgeTicketStatus,
    unmatchedReason: row.unmatchedReason as WeighbridgeUnmatchedReason | null,
    routeId: row.routeId,
    unloadId: row.unloadId,
    dismissedNote: row.dismissedNote,
    receivedBy: row.receivedBy,
  }
}

/** The tickets of this company the caller reaches: its projects', and those of no known vehicle. */
const ticketScope = (principal: Principal) =>
  and(eq(weighbridgeTicket.companyId, principal.companyId), or(isNull(weighbridgeTicket.projectId), inProjects(weighbridgeTicket.projectId, principal)))

const noSuchTicket = (id: string) => problem(404, { detail: `No weighbridge ticket ${id} in the projects this account works in` })

/** What a ticket that is not waiting for the office is told when matched or dismissed. */
export const notWaiting = (ticketNumber: string, status: string) => `Ticket ${ticketNumber} is ${status} already; only an unmatched ticket is matched or dismissed`

/** What a match onto a route of another project than the ticket's vehicle is told. */
export const OTHER_PROJECT = "The ticket's vehicle is in another project than this route"

async function findTicket(tx: Tx, principal: Principal, id: string): Promise<TicketRow | undefined> {
  const [row] = await tx
    .select(columns)
    .from(weighbridgeTicket)
    .where(and(ticketScope(principal), eq(weighbridgeTicket.id, id)))
    .limit(1)
  return row
}

/** What one batch reads once: the company's stations by code, its fractions, and the caller's vehicles by plate. */
type BatchContext = {
  stations: Map<string, { id: string; accepts: Set<string> }>
  fractions: FractionCandidate[]
  /** By plate key; a key two vehicles share names neither. */
  vehicles: Map<string, { id: string; projectId: string; timezone: string } | null>
}

async function batchContext(tx: Tx, principal: Principal, codes: readonly string[]): Promise<BatchContext> {
  const companyId = principal.companyId
  const [stations, accepted, fractions, vehicles] = await Promise.all([
    tx
      .select({ id: unloadingStation.id, code: unloadingStation.code })
      .from(unloadingStation)
      .where(and(eq(unloadingStation.companyId, companyId), inArray(unloadingStation.code, [...new Set(codes)]))),
    tx
      .select({ stationId: unloadingStationFraction.unloadingStationId, fractionId: unloadingStationFraction.wasteFractionId })
      .from(unloadingStationFraction)
      .innerJoin(unloadingStation, and(eq(unloadingStation.companyId, unloadingStationFraction.companyId), eq(unloadingStation.id, unloadingStationFraction.unloadingStationId)))
      .where(and(eq(unloadingStationFraction.companyId, companyId), inArray(unloadingStation.code, [...new Set(codes)]))),
    tx.select({ id: wasteFraction.id, key: wasteFraction.key, wasteCode: wasteFraction.wasteCode }).from(wasteFraction).where(eq(wasteFraction.companyId, companyId)),
    tx
      .select({ id: vehicle.id, projectId: vehicle.projectId, registration: vehicle.registration, timezone: project.timezone })
      .from(vehicle)
      .innerJoin(project, and(eq(project.companyId, vehicle.companyId), eq(project.id, vehicle.projectId)))
      .where(and(eq(vehicle.companyId, companyId), inProjects(vehicle.projectId, principal))),
  ])
  const accepts = new Map<string, Set<string>>()
  for (const row of accepted) accepts.set(row.stationId, (accepts.get(row.stationId) ?? new Set()).add(row.fractionId))
  const byPlate = new Map<string, { id: string; projectId: string; timezone: string } | null>()
  for (const row of vehicles) {
    const key = plateKey(row.registration)
    byPlate.set(key, byPlate.has(key) ? null : { id: row.id, projectId: row.projectId, timezone: row.timezone })
  }
  return {
    stations: new Map(stations.map((row) => [row.code, { id: row.id, accepts: accepts.get(row.id) ?? new Set() }])),
    fractions,
    vehicles: byPlate,
  }
}

/** The routes a vehicle's session spanned at an instant, and its routes that ran on the instant's day on its project's clock. */
async function routesOf(tx: Tx, companyId: string, truck: { id: string; projectId: string; timezone: string }, at: Date): Promise<{ sessionRouteIds: string[]; dayRouteIds: string[] }> {
  const [sessions, days] = await Promise.all([
    tx
      .select({ routeId: session.routeId })
      .from(session)
      .where(and(eq(session.companyId, companyId), eq(session.projectId, truck.projectId), eq(session.vehicleId, truck.id), lte(session.startedAt, at), or(isNull(session.endedAt), gte(session.endedAt, at)))),
    tx
      .select({ id: route.id })
      .from(route)
      .where(
        and(
          eq(route.companyId, companyId),
          eq(route.projectId, truck.projectId),
          eq(route.operatingDate, dayInTimezone(at, truck.timezone)),
          inArray(route.status, ["active", "completed"]),
          sql`coalesce(${route.actualVehicleId}, ${route.plannedVehicleId}) = ${truck.id}`,
        ),
      ),
  ])
  return { sessionRouteIds: sessions.map((row) => row.routeId), dayRouteIds: days.map((row) => row.id) }
}

/** Writes a matched ticket's Unload on its route under the route's lock, and emits `unload-recorded` with it; answers the Unload's id. */
async function writeUnload(tx: Tx, principal: Principal, ticket: { routeId: string; wasteFractionId: string; unloadingStationId: string; weighedAt: Date; grossKg: number | null; tareKg: number | null; netKg: number; ticketNumber: string }): Promise<{ unloadId: string; projectId: string }> {
  await lockRow(tx, route, { companyId: principal.companyId, id: ticket.routeId })
  const [ran] = await tx.select({ projectId: route.projectId }).from(route).where(and(eq(route.companyId, principal.companyId), eq(route.id, ticket.routeId)))
  if (ran === undefined) throw new Error(`route ${ticket.routeId} vanished under its lock`)
  const row = await appendUnload(tx, principal.companyId, {
    projectId: ran.projectId,
    routeId: ticket.routeId,
    unloadingStationId: ticket.unloadingStationId,
    wasteFractionId: ticket.wasteFractionId,
    occurredAt: ticket.weighedAt,
    recordedBy: principal.user.id,
    grossKg: ticket.grossKg,
    tareKg: ticket.tareKg,
    netKg: ticket.netKg,
    weighbridgeTicket: ticket.ticketNumber,
    note: null,
    refusalReason: null,
    refusalNote: null,
    source: "integration",
  })
  const answered = await unloadAnswered(tx, principal.companyId, row)
  await emit(tx, principal, { aggregate: "unload", aggregateId: row.id, kind: "unload-recorded", payload: answered, projectId: row.projectId, occurredAt: ticket.weighedAt })
  return { unloadId: row.id, projectId: row.projectId }
}

/** One ticket of a batch, judged and kept in its own savepoint. */
async function ingestOne(tx: Tx, principal: Principal, context: BatchContext, sent: WeighbridgeTicketIn, at: Date): Promise<WeighbridgeTicketOutcome> {
  const named = { stationCode: sent.stationCode, ticketNumber: sent.ticketNumber }
  const station = context.stations.get(sent.stationCode)
  if (station === undefined) return { ...named, outcome: "refused", reason: "unknown-station" }
  const weighedAt = new Date(sent.weighedAt)
  if (weighedAt.getTime() > at.getTime() + OCCURRED_AT_SKEW_MS) return { ...named, outcome: "refused", reason: "ahead-of-clock" }
  const known = async () => {
    const [row] = await tx
      .select({ id: weighbridgeTicket.id })
      .from(weighbridgeTicket)
      .where(and(eq(weighbridgeTicket.companyId, principal.companyId), eq(weighbridgeTicket.unloadingStationId, station.id), eq(weighbridgeTicket.ticketNumber, sent.ticketNumber)))
      .limit(1)
    return row
  }
  const replay = await known()
  if (replay !== undefined) return { ...named, outcome: "replayed", ticketId: replay.id }

  const truck = context.vehicles.get(plateKey(sent.vehicleRegistration)) ?? null
  const routes = truck === null ? { sessionRouteIds: [], dayRouteIds: [] } : await routesOf(tx, principal.companyId, truck, weighedAt)
  const wasteFractionId = fractionNamed({ fractionKey: sent.fractionKey ?? null, wasteCode: sent.wasteCode ?? null }, context.fractions)
  const decision = matchTicket({ vehicleId: truck?.id ?? null, ...routes, wasteFractionId, stationTakes: wasteFractionId !== null && station.accepts.has(wasteFractionId) })

  try {
    return await tx.transaction(async (savepoint) => {
      const id = newId()
      const kept = {
        id,
        companyId: principal.companyId,
        unloadingStationId: station.id,
        ticketNumber: sent.ticketNumber,
        vehicleRegistration: sent.vehicleRegistration,
        vehicleId: truck?.id ?? null,
        weighedAt,
        grossKg: sent.grossKg ?? null,
        tareKg: sent.tareKg ?? null,
        netKg: sent.netKg,
        fractionKey: sent.fractionKey ?? null,
        wasteCode: sent.wasteCode ?? null,
        receivedBy: principal.user.id,
      }
      if (decision.kind === "unmatched") {
        await savepoint.insert(weighbridgeTicket).values({ ...kept, projectId: truck?.projectId ?? null, status: "unmatched", unmatchedReason: decision.reason })
        return { ...named, outcome: "unmatched" as const, ticketId: id, reason: decision.reason }
      }
      const written = await writeUnload(savepoint, principal, { ...kept, routeId: decision.routeId, wasteFractionId: decision.wasteFractionId })
      await savepoint.insert(weighbridgeTicket).values({ ...kept, projectId: written.projectId, status: "matched", routeId: decision.routeId, unloadId: written.unloadId })
      return { ...named, outcome: "matched" as const, ticketId: id, unloadId: written.unloadId }
    })
  } catch (error) {
    // Two batches carrying one ticket meet the station's unique number: the second is the first's replay.
    const raced = (error as { code?: string; cause?: { code?: string } }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505"
    if (!raced) throw error
    const first = await known()
    if (first === undefined) throw error
    return { ...named, outcome: "replayed", ticketId: first.id }
  }
}

const viewProblems = {
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
}

const commandProblems = {
  400: describeProblem("The path does not hold an id, or the body is missing a field or names one the server owns."),
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\`.`),
  404: describeProblem("No weighbridge ticket with that id in the projects this account works in."),
  409: describeProblem("The ticket is matched or dismissed already."),
}

export function weighbridgeRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date(), allowance, maxBodyBytes = WEIGHBRIDGE_BODY_MAX_BYTES }: WeighbridgeOptions = {}) {
  const batches = allowance ?? new Allowance(WEIGHBRIDGE_BATCHES_PER_MINUTE, now)
  /** A company's batches a minute, after the guard has named the company. */
  const allowed: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const taken = batches.take(c.get("principal").companyId)
    if (!taken.allowed) throw problem(429, { detail: `Too many weighbridge batches from this company; send again in ${taken.retryAfterSeconds} s`, headers: { "Retry-After": String(taken.retryAfterSeconds) } })
    await next()
  }
  /** The body's size, before the token is read. */
  const bounded = bodyLimit({
    maxSize: maxBodyBytes,
    onError: () => {
      throw problem(413, { detail: `A batch of weighbridge tickets is at most ${maxBodyBytes} bytes; send it in smaller batches` })
    },
  })

  return new Hono<AuthEnv>()
    .post(
      "/weighbridge-tickets",
      describeRoute({
        operationId: "ingestWeighbridgeTickets",
        summary: "A weighbridge's tickets, matched to routes",
        description:
          "The ingest of a station's weighbridge (O27 of #290), vendor-neutral: one to 500 tickets, each the station's `stationCode` as registered, its own `ticketNumber`, the `vehicleRegistration` as read (spaces, dashes and case do not matter), `weighedAt`, `netKg` and, together or not at all, `grossKg` and `tareKg` (net is gross less tare), and the product as a `fractionKey` or a compact `wasteCode`. Each ticket is judged on its own, in the body's order, and answered in `outcomes`: `refused` and not kept where the station is not registered (`unknown-station`) or the instant runs more than five minutes ahead of the server's clock (`ahead-of-clock`); `replayed`, with the ticket it is, where the station's ticket number is known; else kept, and `matched` — written as its route's Unload, `source` integration, no session, the weighbridge's weights and ticket number, recorded by the caller, `unload-recorded` emitted with it — where the plate is a vehicle of a project the caller works in, the vehicle's session spans the instant (else it ran exactly one active or completed route on the instant's day on its project's clock), the product names exactly one fraction, and the station takes it; or `unmatched` with the first of `unknown-vehicle`, `no-route`, `several-routes`, `unknown-fraction` and `fraction-not-accepted` it failed on, for the office to match or dismiss. The body is at most 256 KiB (413, before the token is read) and a company sends at most 120 batches a minute (429 with `Retry-After`).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One outcome per ticket, in the body's order.", WeighbridgeIngest),
          400: describeProblem("The body is not a batch of one to 500 tickets, a ticket's field is malformed, or its weights do not add up."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
          413: describeProblem("The body is larger than 256 KiB."),
          429: describeProblem("The company has sent its batches for the minute; send again after `Retry-After` seconds."),
        },
      }),
      bounded,
      guard,
      requireGrant(MODULE, "create"),
      allowed,
      validate("json", WeighbridgeTicketBatch),
      async (c) => {
        const { tickets } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const at = now()
        const context = await batchContext(tx, principal, tickets.map((ticket) => ticket.stationCode))
        const outcomes: WeighbridgeTicketOutcome[] = []
        for (const ticket of tickets) outcomes.push(await ingestOne(tx, principal, context, ticket, at))
        return c.json({ outcomes } satisfies WeighbridgeIngest)
      },
    )
    .get(
      "/weighbridge-tickets",
      describeRoute({
        operationId: "listWeighbridgeTickets",
        summary: "The weighbridge's tickets",
        description:
          "One page of the weighbridge's tickets, oldest first: those of the projects the caller works in, and those of a plate no vehicle in reach drives, which have no project. `status` narrows the page — `unmatched` is the office's queue — and `projectId` to one of the caller's projects (naming another is refused). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of tickets.", TicketPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, or `projectId` is not a project this account works in."),
          ...viewProblems,
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", WeighbridgeTicketListQuery),
      async (c) => {
        const { limit, cursor, projectId, status } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(weighbridgeTicket)
          .where(
            and(
              ticketScope(principal),
              projectId === undefined ? undefined : eq(weighbridgeTicket.projectId, projectId),
              status === undefined ? undefined : eq(weighbridgeTicket.status, status),
              after === undefined ? undefined : gt(weighbridgeTicket.id, after),
            ),
          )
          .orderBy(asc(weighbridgeTicket.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(ticketOf), limit))
      },
    )
    .get(
      "/weighbridge-tickets/:id",
      describeRoute({
        operationId: "getWeighbridgeTicket",
        summary: "One weighbridge ticket",
        description: "One ticket: what the weighbridge said, where it stands, why it found no route, and the route and Unload it was written as once matched.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The ticket.", WeighbridgeTicket),
          400: describeProblem("The path does not hold an id."),
          ...viewProblems,
          404: describeProblem("No weighbridge ticket with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findTicket(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchTicket(id)
        return c.json(ticketOf(row))
      },
    )
    .post(
      "/weighbridge-tickets/:id/match",
      describeRoute({
        operationId: "matchWeighbridgeTicket",
        summary: "Match an unmatched ticket to a route by hand",
        description:
          "The office's answer to a ticket that found no route: the `routeId` its load came off, a route of a project the caller works in — the ticket's vehicle's, where the plate was one (400 at `routeId` otherwise) — that ran (`active` or `completed`, 409 otherwise), and the `wasteFractionId` it was, one the station takes (400 at the field, in the station's sentence). The ticket is written as the route's Unload, `source` integration, the weighbridge's weights and ticket number, recorded by the caller, and `unload-recorded` is emitted with it; the ticket is `matched`, keeping the reason it waited for. Only an unmatched ticket is matched (409).",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("The ticket as it now stands.", WeighbridgeTicket), ...commandProblems, 409: describeProblem("The ticket is matched or dismissed already, or the route has not run.") },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", WeighbridgeTicketMatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const { routeId, wasteFractionId } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, weighbridgeTicket, { companyId: principal.companyId, id })
        const current = await findTicket(tx, principal, id)
        if (current === undefined) throw noSuchTicket(id)
        if (current.status !== "unmatched") throw problem(409, { detail: notWaiting(current.ticketNumber, current.status) })
        await requireRoute(tx, { companyId: principal.companyId, projectId: projectIdsOf(principal) }, routeId)
        await requireWasteFraction(tx, principal.companyId, wasteFractionId)
        const target = await findRoute(tx, principal, routeId)
        if (target === undefined) throw noSuchRoute(routeId)
        if (current.vehicleId !== null && current.projectId !== target.projectId) throw invalidRequest("body", [{ path: "routeId", message: OTHER_PROJECT }])
        const takes = await stationTakes(tx, principal.companyId, current.unloadingStationId, wasteFractionId)
        if (!takes.takes) throw invalidRequest("body", [{ path: "wasteFractionId", message: notTaken(takes) }])
        requireRan(target)
        const written = await writeUnload(tx, principal, { ...current, routeId, wasteFractionId })
        const [row] = await tx
          .update(weighbridgeTicket)
          .set({ status: "matched", projectId: written.projectId, routeId, unloadId: written.unloadId })
          .where(and(eq(weighbridgeTicket.companyId, principal.companyId), eq(weighbridgeTicket.id, id)))
          .returning(columns)
        return c.json(ticketOf(row))
      },
    )
    .post(
      "/weighbridge-tickets/:id/dismiss",
      describeRoute({
        operationId: "dismissWeighbridgeTicket",
        summary: "Dismiss an unmatched ticket",
        description: "The office's answer to a ticket no route of ours carried — a visitor's trailer, a test weighing — with the `note` that says why. Nothing is written as an Unload. Only an unmatched ticket is dismissed (409).",
        security: BEARER_SECURITY,
        responses: { 200: describeJson("The ticket as it now stands.", WeighbridgeTicket), ...commandProblems },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", WeighbridgeTicketDismiss),
      async (c) => {
        const { id } = c.req.valid("param")
        const { note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, weighbridgeTicket, { companyId: principal.companyId, id })
        const current = await findTicket(tx, principal, id)
        if (current === undefined) throw noSuchTicket(id)
        if (current.status !== "unmatched") throw problem(409, { detail: notWaiting(current.ticketNumber, current.status) })
        const [row] = await tx
          .update(weighbridgeTicket)
          .set({ status: "dismissed", dismissedNote: note })
          .where(and(eq(weighbridgeTicket.companyId, principal.companyId), eq(weighbridgeTicket.id, id)))
          .returning(columns)
        return c.json(ticketOf(row))
      },
    )
}
