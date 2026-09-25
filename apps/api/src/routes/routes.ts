// The dated Route as the dispatcher reads and moves it (Issue #104, slice 3;
// ADR-0002, ADR-0004): `GET /routes` lists them, `GET /routes/:id` reads one
// with its pickups, sessions and unloads, and five commands move it —
// `assign` (the Planned Assignment), `dispatch` (`planned → ready`),
// `reschedule` (the operating day and the start), `cancel` and the order of
// its stops (`PUT /routes/:id/pickup-order`) — while `GET /routes/:id/commands`
// is the log of what the device said, rejections included. No create and no
// patch: a route is written by generation (#97 B) and no delete, since a
// route is cancelled and a record standing behind pickups is not removed.
//
// Every status change goes through the domain's `routeTransition`
// (@waste/domain/execution/transitions), which answers the next status, a
// "stay" for a command already done — dispatching a ready route, cancelling a
// cancelled one, each a 200 without a write like `confirm` on an allocation —
// or the refusal's sentence, which is the 409. The rules the office holds
// beyond the machine are each a sentence here: dispatch needs a planned
// driver (§7.18: the driver door's scope is the assignment, so a route
// without a driver reaches no device) and assign may not clear the driver of
// a `ready` route, the same rule from the other side; assign, reschedule and
// the order are refused once a route is `active` (§7.20: ADR-0002 freezes the sequence at
// session start, and the assignment is then the session's); cancel closes
// every open pickup as `skipped · route-cancelled` through the domain's
// `openPickupsClose` and ends an open session, since a cancelled route is
// not being driven.
//
// The Planned Assignment is held the way an allocation's reservation is
// (routes/vehicle-allocations.ts): the fields the body moves, and what
// depends on them, in body order — the vehicle a powered vehicle of the
// route's project, the trailer a trailer of it, the driver one of its drivers
// who holds the class the vehicle requires on the operating date (a day
// already, so nothing is rendered; refused at `driverId` in the licence
// rule's words), the depot the project's, the station the company's and
// accepting at least one of the route's waste fractions (a route with no
// pickups yet names any station) — each a 400 at its field; then, after
// every 400, the statuses of what was named afresh (routes/statuses.ts): a
// retired vehicle or trailer, an inactive or suspended driver is a 409 naming
// the row, since the id is right and the row is there. A stored row the body
// did not move is not asked its status (#79's rule).
//
// Every command runs under the route's row lock, taken before the read, so
// two commands on one route take turns; and every command that changes what
// another context hears about writes its outbox event in the same
// transaction (outbox.ts), the payload being the route as this module
// answers it. The grant is `route-studio.routes` throughout, `view` to read
// and `edit` to command; every statement carries the tenant and `inProjects`.
import { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import { Page, PageRequest } from "@waste/contracts/pagination"
import { PickupOrderSet, Route, RouteAssign, RouteCancel, RouteDetail, RouteListQuery, RouteReschedule } from "@waste/contracts/routes"
import type { Tx } from "@waste/db/client"
import { driverCommand, pickup, route, session } from "@waste/db/schema/execution"
import { unloadingStation, unloadingStationFraction } from "@waste/db/schema/places"
import { notInService, THE_OPERATING_DATE } from "@waste/domain/execution/commands"
import { activeAnd, doesNotChange, hasNotRun, openPickupsClose, routeCancellation, routeTransition } from "@waste/domain/execution/transitions"
import type { PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"
import { licenceRefusal, licenceSentence } from "@waste/domain/resources/licence"
import type { VehicleStatus } from "@waste/domain/resources/vocabulary"
import { count } from "@waste/domain/text"
import { and, asc, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { detailOf, findRoute, labelOf, noSuchRoute, pickupColumns, pickupOf, pickupsOfRoute, receiptColumns, receiptOf, routeColumns, routeScope, routesOf, type RouteRow } from "./execution-shapes"
import { findDriver, findVehicle, vehicleLabel, type DriverRow, type VehicleRow } from "./fleet-lookups"
import { NOT_AN_UNLOADING_STATION, requireDepot, type Scope } from "./references"
import type { ClockOptions } from "./scheme-groups"
import { describeJson, IdParam, lockRow, stamp } from "./shared"
import { refuseUnavailableDriver } from "./statuses"

const MODULE = "route-studio.routes"

const RoutePage = Page(Route)
const ReceiptPage = Page(DriverCommandReceipt)

/** What a dispatch of a route nobody is assigned to is told: the driver door's scope is the assignment, so a route without one reaches no device. */
export const noPlannedDriver = (label: string): string => `Route ${label} has no planned driver; assign one first`

/** What an assign clearing the driver of a `ready` route is told: the same rule from the other side — a dispatched route without a driver would reach no device and nobody could start it. */
export const dispatchedNeedsADriver = (label: string): string => `Route ${label} is dispatched; assign another driver or cancel it`

/** The consequence each office command spells when the route is already running (the domain's `activeAnd`). */
const ASSIGNMENT_IS_THE_SESSIONS = "the session's driver and vehicle are its actual assignment"
const ORDER_IS_FROZEN = "its order is frozen"
const DAY_IS_FIXED = "the day it runs is fixed"

/** What a body naming a station that takes none of what the route collects is told, at `unloadingStationId`. */
export const acceptsNone = (station: string): string => `${station} accepts none of this route's waste fractions`

/**
 * A vehicle or a trailer named afresh is `active`; any other status is a 409
 * naming the row and the status, after every 400 — the rule `start-route`
 * holds (#104 §3) read from the office's side, in the domain's words
 * (`notInService`): a route goes out with a vehicle in service, so
 * `unavailable` and `maintenance` are refused here where an allocation,
 * planned for next month, takes them (routes/statuses.ts).
 */
function refuseVehicleNotActive(status: VehicleStatus, label: string, as: "vehicle" | "trailer" = "vehicle"): void {
  if (status === "active") return
  throw problem(409, { detail: notInService(label, status, as) })
}

/** What an order that is not exactly the route's open pickups is told, at `pickupIds`: how many it left out, and how many it named that are not open pickups of this route. */
export const orderMismatch = (missing: number, strangers: number): string =>
  `The order names every open pickup of the route once: ${count(missing, "open pickup")} left out, ${count(strangers, "id")} not an open pickup of this route`

/**
 * The route the path names, locked and read: every command holds a rule the
 * API rather than the database holds — the status, the licence, the order —
 * so it takes the row lock first and reads afterwards (routes/shared.ts).
 */
async function lockedRoute(tx: Tx, principal: Principal, id: string): Promise<RouteRow> {
  await lockRow(tx, route, { companyId: principal.companyId, id })
  const current = await findRoute(tx, principal, id)
  if (current === undefined) throw noSuchRoute(id)
  return current
}

/**
 * An office command that is refused once the route runs (§7.20): `planned`
 * and `ready` pass, `active` is a 409 saying what is frozen, and a terminal
 * route does not change. Exported for the pickup module's `remove`, which is
 * the same rule from the stop's side.
 */
export function requireNotStarted(current: RouteRow, consequence: string): void {
  const label = labelOf(current)
  switch (current.status) {
    case "planned":
    case "ready":
      return
    case "active":
      throw problem(409, { detail: activeAnd(label, consequence) })
    case "completed":
    case "cancelled":
      throw problem(409, { detail: doesNotChange(label, current.status) })
    default:
      throw new Error(`route ${current.id} carries a status the vocabulary does not know: ${current.status}`)
  }
}

/**
 * An office command made on a route that ran: `active` and `completed` pass,
 * a route that has not is a 409 ("Route RC-1042 has not run"), and a
 * cancelled one does not change. The rule a pickup's `correct-outcome`
 * (routes/pickups.ts) and the office's unload capture (routes/unloads.ts)
 * both hold, spelled once beside its opposite above.
 */
export function requireRan(current: RouteRow): void {
  const label = labelOf(current)
  switch (current.status) {
    case "active":
    case "completed":
      return
    case "planned":
    case "ready":
      throw problem(409, { detail: hasNotRun(label) })
    case "cancelled":
      throw problem(409, { detail: doesNotChange(label, "cancelled") })
    default:
      throw new Error(`route ${current.id} carries a status the vocabulary does not know: ${current.status}`)
  }
}

/**
 * The station a body names: one of the company's (400 at the field), and
 * accepting at least one of the waste fractions the route's pickups carry
 * (400 naming the station); a route with no pickups yet collects nothing a
 * station could refuse, so any station of the company will do.
 */
async function requireStationAccepting(tx: Tx, companyId: string, routeId: string, stationId: string): Promise<void> {
  const [station] = await tx
    .select({ id: unloadingStation.id, name: unloadingStation.name })
    .from(unloadingStation)
    .where(and(eq(unloadingStation.companyId, companyId), eq(unloadingStation.id, stationId)))
    .limit(1)
  if (station === undefined) throw invalidRequest("body", [{ path: "unloadingStationId", message: NOT_AN_UNLOADING_STATION }])
  const fractions = await tx
    .selectDistinct({ id: pickup.wasteFractionId })
    .from(pickup)
    .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId)))
  if (fractions.length === 0) return
  const [accepts] = await tx
    .select({ id: unloadingStationFraction.id })
    .from(unloadingStationFraction)
    .where(
      and(
        eq(unloadingStationFraction.companyId, companyId),
        eq(unloadingStationFraction.unloadingStationId, stationId),
        inArray(
          unloadingStationFraction.wasteFractionId,
          fractions.map((fraction) => fraction.id),
        ),
      ),
    )
    .limit(1)
  if (accepts === undefined) throw invalidRequest("body", [{ path: "unloadingStationId", message: acceptsNone(station.name) }])
}

/** The Planned Assignment as a write leaves it: the body's fields over the stored ones, a null given clearing. */
type Assignment = Pick<RouteRow, "plannedVehicleId" | "plannedDriverId" | "plannedTrailerId" | "depotId" | "unloadingStationId">

/**
 * The licence rule over a route's planned pair on a day: a driver who may not
 * take the vehicle on that day is a 400 at `path` in the domain's words, the
 * day being the operating date and so named in the sentence. Nothing is
 * asked when the route names one of the two or neither. The rows are read
 * for their class, label, licence and name — or taken from `read`, where the
 * caller already has them (assign reads what the body named afresh) — and
 * their status is not asked here: what is named afresh is gated by the caller.
 */
async function requireLicenceOn(tx: Tx, scope: Scope, pair: { plannedVehicleId: string | null; plannedDriverId: string | null }, day: string, path: string, read: { vehicle?: VehicleRow; driver?: DriverRow } = {}): Promise<void> {
  if (pair.plannedVehicleId === null || pair.plannedDriverId === null) return
  const truck = read.vehicle ?? (await findVehicle(tx, scope, pair.plannedVehicleId, "powered-vehicle", "vehicleId"))
  const who = read.driver ?? (await findDriver(tx, scope, pair.plannedDriverId, "driverId"))
  const refusal = licenceRefusal(who, truck.requiredLicenceClass, day)
  if (refusal !== undefined) throw invalidRequest("body", [{ path, message: licenceSentence(refusal, { driver: who.name, vehicle: vehicleLabel(truck) }, THE_OPERATING_DATE) }])
}

const ASSIGN_RULES =
  "The vehicle is a powered vehicle of the route's project, the trailer a trailer of it, the driver one of its drivers, the depot one of its depots, and the unloading station one of this company's that accepts at least one of the waste fractions the route's pickups carry (a route with no pickups yet names any station) — each refused (400) at its field. Where the route ends up naming both a driver and a vehicle, the driver holds the licence class the vehicle requires on the operating date, refused at `driverId` with the reason. Then, after every such 400, the statuses of what the body named afresh: a vehicle or a trailer that is not active — retired, unavailable or in maintenance, the rule a route's start holds — and an inactive or a suspended driver are refused (409) naming the row and its status, while a stored one the body did not move is not asked."

const commandProblems = (action: "view" | "edit") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
  404: describeProblem("No route with that id in the projects this account works in."),
})

export function routeRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/routes",
      describeRoute({
        operationId: "listRoutes",
        summary: "The dated routes of the caller's projects",
        description:
          "One page of routes, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page until step 7 bounds the list by the planned service provider. `projectId` narrows it to one of those projects; naming another is refused. `routeSchemeId` and `collectionGroupId` answer what a scheme or a group generated, `from` and `to` the routes operating over a window of days (both inclusive, `to` on or after `from`), `serviceDate` the routes of one recurrence day, `status` one of the five, and `plannedDriverId` and `plannedVehicleId` a driver's or a vehicle's day. Every row carries its `progress`, counted from its pickups and never stored. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of routes.", RoutePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", RouteListQuery),
      async (c) => {
        const { limit, cursor, projectId, routeSchemeId, collectionGroupId, from, to, serviceDate, status, plannedDriverId, plannedVehicleId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(routeColumns)
          .from(route)
          .where(
            and(
              routeScope(principal),
              projectId === undefined ? undefined : eq(route.projectId, projectId),
              routeSchemeId === undefined ? undefined : eq(route.routeSchemeId, routeSchemeId),
              collectionGroupId === undefined ? undefined : eq(route.collectionGroupId, collectionGroupId),
              from === undefined ? undefined : gte(route.operatingDate, from),
              to === undefined ? undefined : lte(route.operatingDate, to),
              serviceDate === undefined ? undefined : eq(route.serviceDate, serviceDate),
              status === undefined ? undefined : eq(route.status, status),
              plannedDriverId === undefined ? undefined : eq(route.plannedDriverId, plannedDriverId),
              plannedVehicleId === undefined ? undefined : eq(route.plannedVehicleId, plannedVehicleId),
              after === undefined ? undefined : gt(route.id, after),
            ),
          )
          .orderBy(asc(route.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page is not one whose progress is counted.
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: await routesOf(tx, principal.companyId, items), nextCursor })
      },
    )
    .get(
      "/routes/:id",
      describeRoute({
        operationId: "getRoute",
        summary: "One route with its pickups, sessions and unloads",
        description:
          "One route of a project the caller works in, as it now stands: the route with its `progress`, its pickups by position, the open session or null, every session oldest first, and its unloads oldest first. A route of another company, or of a project this account does not work in, is a route that does not exist here. What the device said is `GET /routes/{id}/commands`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route and what hangs off it.", RouteDetail),
          400: describeProblem("The path does not hold an id."),
          ...commandProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findRoute(tx, principal, id)
        if (row === undefined) throw noSuchRoute(id)
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .post(
      "/routes/:id/assign",
      describeRoute({
        operationId: "assignRoute",
        summary: "Move a route's Planned Assignment",
        description:
          "The `assign` command: moves the planned vehicle, driver, trailer, depot or unloading station of a route that has not started, any of them cleared with null; at least one field must be given. Under the route's row lock. A `planned` route stays `planned` and a `ready` one stays `ready` — a route already running is refused (409): the session's driver and vehicle are its actual assignment, and a swap mid-route is a Ticket's outcome later; a completed or cancelled route does not change. A `ready` route keeps a driver: it was dispatched to one, and a dispatched route without a driver would reach no device, so clearing `driverId` on it is refused (409, `Route RC-1042 is dispatched; assign another driver or cancel it`) where moving it to another driver is not. " +
          ASSIGN_RULES +
          " The `route-reassigned` event is written in the same transaction when the driver or the vehicle moved, carrying the route as answered here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route as it now stands.", RouteDetail),
          400: describeProblem(
            "The path does not hold an id, or the body changes nothing, names a member the command does not take, or names a vehicle, trailer, driver, depot or station the rules above refuse — each at the field that is wrong.",
          ),
          ...commandProblems("edit"),
          409: describeProblem("The route is active, completed or cancelled, the body clears the driver of a ready route, or a vehicle or trailer named afresh is not active or a driver named afresh is inactive or suspended; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", RouteAssign),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        requireNotStarted(current, ASSIGNMENT_IS_THE_SESSIONS)
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        // The assignment the command leaves behind: the body's fields where given, the stored ones where not; a null given clears.
        const after: Assignment = {
          plannedVehicleId: body.vehicleId === undefined ? current.plannedVehicleId : body.vehicleId,
          plannedDriverId: body.driverId === undefined ? current.plannedDriverId : body.driverId,
          plannedTrailerId: body.trailerId === undefined ? current.plannedTrailerId : body.trailerId,
          depotId: body.depotId === undefined ? current.depotId : body.depotId,
          unloadingStationId: body.unloadingStationId === undefined ? current.unloadingStationId : body.unloadingStationId,
        }
        const moved = { vehicle: body.vehicleId !== undefined, driver: body.driverId !== undefined, trailer: body.trailerId !== undefined, depot: body.depotId !== undefined, station: body.unloadingStationId !== undefined }
        // The route's own state, judged with `requireNotStarted` before the body's references: a dispatched route keeps a driver (dispatch demanded one), so clearing it is refused where moving it is not.
        if (current.status === "ready" && moved.driver && after.plannedDriverId === null) throw problem(409, { detail: dispatchedNeedsADriver(labelOf(current)) })

        // The 400s in body order: what is named afresh is the project's and of its kind, then the pair's licence on the operating date — over the rows just read where the body named them — then the places.
        const vehicle = moved.vehicle && after.plannedVehicleId !== null ? await findVehicle(tx, scope, after.plannedVehicleId, "powered-vehicle", "vehicleId") : null
        const driver = moved.driver && after.plannedDriverId !== null ? await findDriver(tx, scope, after.plannedDriverId, "driverId") : null
        const trailer = moved.trailer && after.plannedTrailerId !== null ? await findVehicle(tx, scope, after.plannedTrailerId, "trailer", "trailerId") : null
        if (moved.vehicle || moved.driver) await requireLicenceOn(tx, scope, after, current.operatingDate, "driverId", { vehicle: vehicle ?? undefined, driver: driver ?? undefined })
        if (moved.depot) await requireDepot(tx, scope, after.depotId)
        if (moved.station && after.unloadingStationId !== null) await requireStationAccepting(tx, principal.companyId, current.id, after.unloadingStationId)

        // The statuses last, 409s after every 400: what the body named afresh is in service.
        if (vehicle !== null) refuseVehicleNotActive(vehicle.status, vehicleLabel(vehicle))
        if (trailer !== null) refuseVehicleNotActive(trailer.status, vehicleLabel(trailer), "trailer")
        if (driver !== null) refuseUnavailableDriver(driver.status, driver.name, "a route")

        const [row] = await tx
          .update(route)
          .set(after)
          .where(and(routeScope(principal), eq(route.id, id)))
          .returning(routeColumns)
        if (row === undefined) throw noSuchRoute(id)
        const detail = await detailOf(tx, principal.companyId, row)
        if (row.plannedDriverId !== current.plannedDriverId || row.plannedVehicleId !== current.plannedVehicleId) {
          const { pickups: _pickups, session: _session, sessions: _sessions, unloads: _unloads, ...answered } = detail
          await emit(tx, principal, { aggregate: "route", aggregateId: row.id, kind: "route-reassigned", payload: answered, projectId: row.projectId, occurredAt: now() })
        }
        return c.json(detail)
      },
    )
    .post(
      "/routes/:id/dispatch",
      describeRoute({
        operationId: "dispatchRoute",
        summary: "Dispatch a route to its driver",
        description:
          "The `dispatch` command: `planned` becomes `ready`, `dispatchedAt` is stamped, and the route is frozen against regeneration (#97's rule) and reaches its driver's device. A route without a planned driver is refused (409): the driver door's scope is the assignment, so a route without one reaches nobody — assign one first. A route already `ready` answers 200 as it stands, without a write; an active one is refused, and a completed or cancelled one does not change. Takes no body. Under the route's row lock; the `route-dispatched` event is written in the same transaction, carrying the route as answered here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route, dispatched.", RouteDetail),
          400: describeProblem("The path does not hold an id."),
          ...commandProblems("edit"),
          409: describeProblem("The route has no planned driver, is already active, or is completed or cancelled; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        const transition = routeTransition(current.status as RouteStatus, "dispatch", labelOf(current))
        if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
        if (transition.kind === "stay") return c.json(await detailOf(tx, principal.companyId, current))
        if (current.plannedDriverId === null) throw problem(409, { detail: noPlannedDriver(labelOf(current)) })
        const at = now()
        const [row] = await tx
          .update(route)
          .set({ status: transition.to, dispatchedAt: at })
          .where(and(routeScope(principal), eq(route.id, id)))
          .returning(routeColumns)
        if (row === undefined) throw noSuchRoute(id)
        const detail = await detailOf(tx, principal.companyId, row)
        const { pickups: _pickups, session: _session, sessions: _sessions, unloads: _unloads, ...answered } = detail
        await emit(tx, principal, { aggregate: "route", aggregateId: row.id, kind: "route-dispatched", payload: answered, projectId: row.projectId, occurredAt: at })
        return c.json(detail)
      },
    )
    .post(
      "/routes/:id/reschedule",
      describeRoute({
        operationId: "rescheduleRoute",
        summary: "Move the day a route runs, or its start",
        description:
          "The `reschedule` command: moves `operatingDate`, the day the route runs, or `plannedStartTime`, a time on the project's clock (null clears it); at least one must be given. The `serviceDate` never moves: with the scheme and the group it is the route's identity (ADR-0002). A route that has started is refused (409): the day it runs is fixed; a completed or cancelled one does not change. Where the route names both a planned driver and a planned vehicle, moving the day judges the driver's licence again on the new operating date, refused at `operatingDate` with the reason. Under the route's row lock.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route as it now stands.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body changes nothing, names a member the command does not take, or moves the day to one the planned driver may not take the planned vehicle on."),
          ...commandProblems("edit"),
          409: describeProblem("The route is active, completed or cancelled."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", RouteReschedule),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        requireNotStarted(current, DAY_IS_FIXED)
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        const operatingDate = body.operatingDate ?? current.operatingDate
        if (body.operatingDate !== undefined) await requireLicenceOn(tx, scope, current, operatingDate, "operatingDate")
        const [row] = await tx
          .update(route)
          .set({ operatingDate, plannedStartTime: body.plannedStartTime === undefined ? current.plannedStartTime : body.plannedStartTime })
          .where(and(routeScope(principal), eq(route.id, id)))
          .returning(routeColumns)
        if (row === undefined) throw noSuchRoute(id)
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .post(
      "/routes/:id/cancel",
      describeRoute({
        operationId: "cancelRoute",
        summary: "Cancel a route",
        description:
          "The `cancel` command: a `planned`, `ready` or `active` route becomes `cancelled` with the reason as its `note` and `cancelledAt` stamped; every `planned` pickup of it is closed as `skipped` with the reason `route-cancelled` and its `outcomeAt`, since nobody will attempt it, and an open session is ended, since the route is no longer being driven. A pickup with an outcome already keeps it. A completed route does not change (409); one already cancelled answers 200 as it stands, without a write. Under the route's row lock; the `route-cancelled` event and one `pickup-skipped` per pickup closed are written in the same transaction.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route, cancelled, with its pickups as the cancellation left them.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body has no reason or carries a member the command does not take."),
          ...commandProblems("edit"),
          409: describeProblem("The route is completed and does not change."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", RouteCancel),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        const transition = routeTransition(current.status as RouteStatus, "cancel", labelOf(current))
        if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
        if (transition.kind === "stay") return c.json(await detailOf(tx, principal.companyId, current))
        const at = now()
        const [row] = await tx
          .update(route)
          .set({ status: transition.to, note: reason, cancelledAt: at })
          .where(and(routeScope(principal), eq(route.id, id)))
          .returning(routeColumns)
        if (row === undefined) throw noSuchRoute(id)
        // The domain says what cancelling does beyond the status — which pickups close and what they become, and whether a session is running to end — and the statements write it. The status is text with a CHECK in the database and the vocabulary's here.
        const cancellation = routeCancellation(current.status as RouteStatus)
        const stops = (await pickupsOfRoute(tx, principal.companyId, row.id)).map((stop) => ({ id: stop.id, status: stop.status as PickupStatus }))
        const closing = openPickupsClose(stops, cancellation.closing.reason)
        const closed =
          closing.pickups.length === 0
            ? []
            : await tx
                .update(pickup)
                .set({ status: closing.outcome.status, reason: closing.outcome.reason, outcomeAt: at })
                .where(
                  and(
                    eq(pickup.companyId, principal.companyId),
                    eq(pickup.routeId, row.id),
                    inArray(
                      pickup.id,
                      closing.pickups.map((open) => open.id),
                    ),
                  ),
                )
                .returning(pickupColumns)
        if (cancellation.endsSession) {
          await tx
            .update(session)
            .set({ endedAt: at })
            .where(and(eq(session.companyId, principal.companyId), eq(session.routeId, row.id), isNull(session.endedAt)))
        }
        const detail = await detailOf(tx, principal.companyId, row)
        const { pickups: _pickups, session: _session, sessions: _sessions, unloads: _unloads, ...answered } = detail
        await emit(tx, principal, { aggregate: "route", aggregateId: row.id, kind: "route-cancelled", payload: answered, projectId: row.projectId, occurredAt: at })
        for (const stop of closed) {
          await emit(tx, principal, { aggregate: "pickup", aggregateId: stop.id, kind: "pickup-skipped", payload: pickupOf(stop), projectId: stop.projectId, occurredAt: at })
        }
        return c.json(detail)
      },
    )
    .put(
      "/routes/:id/pickup-order",
      describeRoute({
        operationId: "putRoutePickupOrder",
        summary: "Reorder a route's stops",
        description:
          "Replaces the order of the route's open pickups with the one in the body: positions are rewritten 1..n in body order, and a pickup already decided keeps the position it had. The body names every `planned` pickup of the route exactly once — one left out, or one named that is not an open pickup of this route, is refused (400 at `pickupIds`) counting both. A route that has started is refused (409): the sequence is frozen once a session has started (ADR-0002); a completed or cancelled one does not change. Under the route's row lock; the route's `updatedAt` moves, since the order is part of the route on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route with its pickups in the new order.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body is missing `pickupIds`, names a member it does not own, names a pickup twice, or is not exactly the route's open pickups."),
          ...commandProblems("edit"),
          409: describeProblem("The route is active, completed or cancelled."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PickupOrderSet),
      async (c) => {
        const { id } = c.req.valid("param")
        const { pickupIds } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        requireNotStarted(current, ORDER_IS_FROZEN)
        const open = new Set((await pickupsOfRoute(tx, principal.companyId, current.id)).filter((stop) => stop.status === "planned").map((stop) => stop.id))
        const named = new Set(pickupIds)
        const missing = [...open].filter((stopId) => !named.has(stopId)).length
        const strangers = pickupIds.filter((stopId) => !open.has(stopId)).length
        if (missing > 0 || strangers > 0) throw invalidRequest("body", [{ path: "pickupIds", message: orderMismatch(missing, strangers) }])
        const [row] = await tx
          .update(route)
          .set(stamp())
          .where(and(routeScope(principal), eq(route.id, id)))
          .returning(routeColumns)
        if (row === undefined) throw noSuchRoute(id)
        // One statement for the whole order: the body's ids with their ordinal, joined onto the route's pickups.
        const ordered = sql`unnest(array[${sql.join(
          pickupIds.map((stopId) => sql`${stopId}`),
          sql`, `,
        )}]::uuid[]) with ordinality as ordered(id, position)`
        await tx.execute(
          sql`update ${pickup} set ${sql.identifier("position")} = ordered.position::int, ${sql.identifier("updated_at")} = now() from ${ordered} where ${pickup.companyId} = ${principal.companyId} and ${pickup.routeId} = ${row.id} and ${pickup.id} = ordered.id`,
        )
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .get(
      "/routes/:id/commands",
      describeRoute({
        operationId: "listRouteCommands",
        summary: "What the device said on a route",
        description:
          "One page of the route's command receipts, oldest first — a cursor over time-ordered ids is a cursor over the order the commands were received in — each carrying the command as the device sent it, verbatim, and what became of it: `applied`, or `rejected` with the problem the server answered. The dispatcher's log of what the device said, rejections included; nothing here is ever updated or removed. A route of another company, or of a project this account does not work in, is a route that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the route's command receipts, oldest first.", ReceiptPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          ...commandProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", PageRequest),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findRoute(tx, principal, id)) === undefined) throw noSuchRoute(id)
        const rows = await tx
          .select(receiptColumns)
          .from(driverCommand)
          .where(and(eq(driverCommand.companyId, principal.companyId), eq(driverCommand.routeId, id), after === undefined ? undefined : gt(driverCommand.id, after)))
          .orderBy(asc(driverCommand.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(receiptOf), limit))
      },
    )
}
