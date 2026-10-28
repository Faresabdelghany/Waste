// The dated Route as the dispatcher reads and moves it (Issue #104, slice 3;
// ADR-0002, ADR-0004): `GET /routes` lists them, `GET /routes/:id` reads one
// with its pickups, sessions and unloads, `POST /routes` makes the office's
// ad-hoc route (#111), and six commands move a route —
// `assign` (the Planned Assignment, its service provider too since O5 of
// #290), `dispatch` (`planned → ready`, one route or, through
// `POST /routes/dispatch`, a day or a selection, each in its own savepoint),
// `reschedule` (the operating day and the start, a day the project's
// calendar rests on taken only knowingly), `release-hold` (the
// office's hold handed back, #226), `cancel` (a reason code and the free
// reason) and the order of its stops
// (`PUT /routes/:id/pickup-order`) — while `GET /routes/:id/commands`
// is the log of what the device said, rejections included. No patch: a
// route is written by generation (#97 B) or made by the office, and no
// delete, since a route is cancelled and a record standing behind pickups is
// not removed.
//
// The ad-hoc route (#111) is the office's own: a route with no scheme and no
// group (`route_scheme_shape`), on one of the caller's projects and a day
// that is its operating date and its service date both, numbered from the
// company's counter one at a time (`nextNumber`, under the company's row
// lock), `planned`, with the depot, the station and the Planned Assignment's
// vehicle and driver the body names held as `assign` holds them. No
// generation run reads it, so it is never held: `assign` and `reschedule`
// move it without a hold, and `release-hold` refuses it. Its stops are the
// office's too, added through `POST /routes/:id/pickups` (routes/pickups.ts).
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
// The hold (#209, routes/route-holds.ts): `assign` and `reschedule` that
// change a `planned` route stamp `heldAt` with the command's instant, so the
// next generation run keeps the day, the start and the Planned Assignment the
// office gave it rather than copying the scheme's back; one that changes
// nothing holds nothing, and on a `ready` route they hold nothing, since a
// dispatched route is frozen against regeneration already. `dispatch` and
// `cancel` clear it in the same write: a hold is a planned route's
// (`route_hold_shape`).
//
// Every command runs under the route's row lock, taken before the read, so
// two commands on one route take turns; and every command that changes what
// another context hears about writes its outbox event in the same
// transaction (outbox.ts), the payload being the route as this module
// answers it. The grant is `route-studio.routes` throughout, `view` to read
// and `edit` to command. Every command carries the tenant and `inProjects`;
// the reads — the list, a route's read and its device log — carry the tenant
// and the reach (`routeReach`, auth/provider.ts): the office's projects, or,
// for a Service Provider's account, the routes its provider serves on their
// operating date (#291 slice 23). A provider crews the routes it runs and
// commands nothing else of them (#291 slice 23b): `assign` and `dispatch`
// read the route through the reach, and from a provider's account `assign`
// names only its own vehicles, trailers and drivers — never the depot or the
// station, the office's — and `dispatch` sends a route only to its own
// crew. Every other command finds no row for it — the family's 404, the way
// a settlement's commands answer it.
import { DriverCommandReceipt } from "@waste/contracts/driver-commands"
import { Page, PageRequest } from "@waste/contracts/pagination"
import { PickupOrderSet, RouteAssign, RouteCancel, RouteCreate, RouteDetail, RouteDispatchMany, RouteDispatchResults, RouteListItem, RouteListQuery, RouteReleaseHold, RouteReschedule, type Route, type RouteDispatchResult } from "@waste/contracts/routes"
import type { Tx } from "@waste/db/client"
import { collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { driverCommand, pickup, route, session } from "@waste/db/schema/execution"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import { unloadingStation, unloadingStationFraction } from "@waste/db/schema/places"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { notInService, THE_OPERATING_DATE } from "@waste/domain/execution/commands"
import { confirmNonWorkingDay, operatingDayReading, type OperatingDayReading } from "@waste/domain/execution/operating-day"
import { activeAnd, doesNotChange, hasNotRun, openPickupsClose, orderIsOpen, routeCancellation, routeTransition } from "@waste/domain/execution/transitions"
import type { OfficeCancelReasonCode, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"
import type { HolidayPolicy } from "@waste/domain/planning/vocabulary"
import { holidayListOf } from "@waste/domain/planning/generation"
import { licenceRefusal, licenceSentence } from "@waste/domain/resources/licence"
import type { ServiceDay } from "@waste/domain/route-schemes/recurrence"
import type { VehicleStatus } from "@waste/domain/resources/vocabulary"
import { count } from "@waste/domain/text"
import type { RoutingIdentity } from "@waste/routing/provider"
import { and, asc, count as countRows, eq, gt, gte, inArray, isNull, lte } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireProject } from "../auth/projects"
import { providerIdOf, providerNameOf } from "../auth/provider"
import { allows, requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, ProblemError, validate } from "../problem"
import { detailOf, findReachedRoute, findRoute, labelOf, noSuchRoute, pickupColumns, pickupOf, pickupsOfRoute, receiptColumns, receiptOf, routeColumns, routeReach, routeScope, routesOf, type RouteRow } from "./execution-shapes"
import { findDriver, findVehicle, projectToday, vehicleLabel, type DriverRow, type OwnedBy, type VehicleRow } from "./fleet-lookups"
import { activePlansByRoute, ensurePlan } from "./plan-shapes"
import { NO_SHIFT, NO_WORKLOAD, shiftsByRoute, workloadsByRoute } from "./workload"
import { QueueMissing, type JobSender } from "@waste/db/jobs"
import { NOT_AN_UNLOADING_STATION, requireDepot, requireServiceProvider, requireUnloadingStation, type Scope } from "./references"
import { findScheme, MODULE as SCHEMES_MODULE, type ClockOptions } from "./scheme-groups"
import { askGeneration } from "./generation"
import { handBackWindow } from "./route-holds"
import { created, describeCreated, describeJson, IdParam, lockRow, lockRows, nextNumber, stamp, timeOf } from "./shared"
import { refuseUnavailableDriver } from "./statuses"
import { oneDay, refuseCrewAway, refuseDispatchAway } from "./availability-rules"
import { refuseAllocatedElsewhere, refuseDoubleBooked } from "./crew-day"
import { refuseMisfit, routeFitStops } from "./fleet-fit"

const MODULE = "route-studio.routes"

const RoutePage = Page(RouteListItem)
const ReceiptPage = Page(DriverCommandReceipt)

/** What a hand-back of a planned route the office did not move is told (#226). */
export const notHeld = (label: string): string => `Route ${label} is not held; it follows its scheme`

/** What a hand-back of the office's ad-hoc route is told (#111): no run reads it, so nothing ever held it. */
export const adHocNeverHeld = (label: string): string => `Route ${label} has no scheme; the office's own route is never held`

/** What a hand-back of a route past `planned` is told: a hold is a planned route's (\`route_hold_shape\`). */
export const onlyPlannedHeld = (label: string, status: string): string => `Route ${label} is ${status}; only a planned route is held`

/** What a dispatch of a route nobody is assigned to is told: the driver door's scope is the assignment, so a route without one reaches no device. */
export const noPlannedDriver = (label: string): string => `Route ${label} has no planned driver; assign one first`

/** What an assign clearing the driver of a `ready` route is told: the same rule from the other side — a dispatched route without a driver would reach no device and nobody could start it. */
export const dispatchedNeedsADriver = (label: string): string => `Route ${label} is dispatched; assign another driver or cancel it`

/** The consequence each office command spells when the route is already running (the domain's `activeAnd`). */
const ASSIGNMENT_IS_THE_SESSIONS = "the session's driver and vehicle are its actual assignment"
export const ORDER_IS_FROZEN = "its order is frozen"
const DAY_IS_FIXED = "the day it runs is fixed"

/** What a route moved off the day its bulky collections were booked for is told (O11 of #290). */
export const bulkyKeepsTheDay = (route: string, stops: number): string =>
  `Route ${route} carries ${stops === 1 ? "a bulky collection" : `${stops} bulky collections`} booked for its day; take ${stops === 1 ? "its stop" : "their stops"} off before the route moves`

/** Refuses a move of a route that carries a planned bulky collection: the customer booked its day. */
async function refuseBulkyMoved(tx: Tx, scope: Scope, current: RouteRow): Promise<void> {
  const [row] = await tx
    .select({ stops: countRows() })
    .from(pickup)
    .where(and(eq(pickup.companyId, scope.companyId), eq(pickup.routeId, current.id), eq(pickup.service, "bulky"), eq(pickup.status, "planned")))
  if ((row?.stops ?? 0) > 0) throw problem(409, { detail: bulkyKeepsTheDay(labelOf(current), row.stops) })
}

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
 * Exported for the Plan endpoints (routes/plans.ts), whose optimise is a
 * command over the route.
 */
export async function lockedRoute(tx: Tx, principal: Principal, id: string): Promise<RouteRow> {
  await lockRow(tx, route, { companyId: principal.companyId, id })
  const current = await findRoute(tx, principal, id)
  if (current === undefined) throw noSuchRoute(id)
  return current
}

/**
 * The route `assign` or `dispatch` names, locked and read through the reach
 * (#291 slice 23b): a route of the office's projects for an office account,
 * as `lockedRoute` reads it, and for a Service Provider's account a route its
 * provider runs — the two commands a provider crews its routes with.
 */
async function lockedCrewedRoute(tx: Tx, principal: Principal, id: string): Promise<RouteRow> {
  await lockRow(tx, route, { companyId: principal.companyId, id })
  const current = await findReachedRoute(tx, principal, id)
  if (current === undefined) throw noSuchRoute(id)
  return current
}

/** The provider a provider's account crews with, or undefined for an office account: what `assign`'s and `dispatch`'s fleet is held to. */
function crewOf(principal: Principal): OwnedBy | undefined {
  const serviceProviderId = providerIdOf(principal)
  return serviceProviderId === null ? undefined : { serviceProviderId, provider: providerNameOf(principal) }
}

/** What a provider's `assign` naming the depot or the station is told: those are the office's to set. */
export const officeSetsIt = (what: "depot" | "unloading station", provider: string): string => `The office sets a route's ${what}; ${provider} assigns its own vehicle, trailer and driver`

/** What a provider's `assign` naming another provider, or none, as the route's planned provider is told. */
export const plansForItself = (provider: string): string => `${provider} names itself as a route's planned provider, and no other`

/** What a provider's `dispatch` of a route crewed by anyone else's fleet is told. */
export const notYourCrew = (label: string, what: "driver" | "vehicle" | "trailer", provider: string): string => `Route ${label}'s planned ${what} is not ${provider}'s; assign one of yours first`

/** What a provider's `dispatch` of a route with no truck is told: its crew is a driver and a vehicle of its own. */
export const noPlannedVehicle = (label: string, provider: string): string => `Route ${label} has no planned vehicle; assign one of ${provider}'s first`

/**
 * A provider's `dispatch` sends a route only to its own crew (#291 slice
 * 23b): a planned driver and a planned vehicle of its provider's, and the
 * trailer where the route names one, or the command is refused (409) naming
 * the first that is not — a route the provider cleared the office's truck
 * from goes out with one of its own or not at all. One statement per table
 * over the route's own planned ids; the planned driver is there already, as
 * every dispatch demands.
 */
async function requireOwnCrew(tx: Tx, companyId: string, current: RouteRow, crew: OwnedBy): Promise<void> {
  const label = labelOf(current)
  if (current.plannedVehicleId === null) throw problem(409, { detail: noPlannedVehicle(label, crew.provider) })
  if (current.plannedDriverId !== null) {
    const [planned] = await tx
      .select({ serviceProviderId: driver.serviceProviderId })
      .from(driver)
      .where(and(eq(driver.companyId, companyId), eq(driver.id, current.plannedDriverId)))
      .limit(1)
    if (planned?.serviceProviderId !== crew.serviceProviderId) throw problem(409, { detail: notYourCrew(label, "driver", crew.provider) })
  }
  const vehicles = [
    { id: current.plannedVehicleId, what: "vehicle" as const },
    { id: current.plannedTrailerId, what: "trailer" as const },
  ].filter((named): named is { id: string; what: "vehicle" | "trailer" } => named.id !== null)
  if (vehicles.length === 0) return
  const owners = await tx
    .select({ id: vehicle.id, serviceProviderId: vehicle.serviceProviderId })
    .from(vehicle)
    .where(
      and(
        eq(vehicle.companyId, companyId),
        inArray(
          vehicle.id,
          vehicles.map((named) => named.id),
        ),
      ),
    )
  for (const named of vehicles) {
    if (owners.find((owner) => owner.id === named.id)?.serviceProviderId !== crew.serviceProviderId) throw problem(409, { detail: notYourCrew(label, named.what, crew.provider) })
  }
}

/**
 * An office command that is refused once the route runs (§7.20): `planned`
 * and `ready` pass, `active` is a 409 saying what is frozen, and a terminal
 * route does not change. Exported for the pickup module's `remove`, which is
 * the same rule from the stop's side.
 */
export function requireNotStarted(current: RouteRow, consequence: string): void {
  if (orderIsOpen(current.status as RouteStatus)) return
  const label = labelOf(current)
  switch (current.status) {
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

/**
 * The hold an office command puts on the route it moves (#209): a `planned`
 * route, which the next generation run would otherwise refresh, is held from
 * the command's instant when the command changed something; one that changed
 * nothing leaves the route as it was, held or not. A `ready` route is frozen
 * against regeneration already and holds nothing, which `route_hold_shape`
 * demands besides; nor does the office's ad-hoc route (#111), which no run
 * reads.
 */
const holdOf = (current: RouteRow, moved: boolean, at: Date): { heldAt?: Date } => (current.status === "planned" && current.routeSchemeId !== null && moved ? { heldAt: at } : {})

/** What a hold says on the wire, spelled once for `assign` and `reschedule`. */
const HOLDS =
  "On a `planned` route a command that changes something stamps `heldAt` with its instant: the route is held, and the next generation run keeps its operating date, its planned start and its Planned Assignment — vehicle, driver, provider, trailer, depot and unloading station — as the office left them, still refreshing its pickups and its note, until `release-hold` hands it back, `dispatch` or `cancel` clears the hold, or an edit of the scheme or of the route's collection group releases it: one that moves the start, the depot, the station, the vehicle, the driver or the provider, or that takes the route's own service day away. A command that changes nothing holds nothing, and on a `ready` route, frozen against regeneration already, the command holds nothing either; nor on the office's ad-hoc route, which no generation run reads."

/** The Planned Assignment as a write leaves it: the body's fields over the stored ones, a null given clearing. */
type Assignment = Pick<RouteRow, "plannedVehicleId" | "plannedDriverId" | "plannedTrailerId" | "plannedServiceProviderId" | "depotId" | "unloadingStationId">

/** A route as a command and the outbox carry it: the detail without what hangs off it. */
function routeOfDetail(detail: RouteDetail): Route {
  const { pickups: _pickups, session: _session, sessions: _sessions, unloads: _unloads, activePlan: _activePlan, workload: _workload, shift: _shift, ...answered } = detail
  return answered
}

/**
 * The `dispatch` command on one route, under its row lock: what
 * `POST /routes/:id/dispatch` answers, and what `POST /routes/dispatch`
 * judges each route of a day or a selection by, in a savepoint of its own.
 * `planned` becomes `ready` with `dispatchedAt` and the hold cleared, and
 * `route-dispatched` is written; a `ready` route stays as it is; the
 * machine's refusal, and a route with no planned driver, are the 409.
 */
async function dispatchRoute(tx: Tx, principal: Principal, id: string, at: Date): Promise<RouteDetail> {
  // Through the reach (#291 slice 23b): a provider dispatches a route its provider runs, to its own crew alone.
  const current = await lockedCrewedRoute(tx, principal, id)
  const transition = routeTransition(current.status as RouteStatus, "dispatch", labelOf(current))
  if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
  if (transition.kind === "stay") return await detailOf(tx, principal.companyId, current)
  if (current.plannedDriverId === null) throw problem(409, { detail: noPlannedDriver(labelOf(current)) })
  const crew = crewOf(principal)
  if (crew !== undefined) await requireOwnCrew(tx, principal.companyId, current, crew)
  // The crew it goes out with is there on its day (O6 of #290): a period recorded after the assign stops the dispatch, each route of a bulk one its own.
  await refuseDispatchAway(tx, { companyId: principal.companyId, projectId: current.projectId }, { vehicleId: current.plannedVehicleId, trailerId: current.plannedTrailerId, driverId: current.plannedDriverId }, current.operatingDate)
  const [row] = await tx
    .update(route)
    .set({ status: transition.to, dispatchedAt: at, heldAt: null })
    .where(and(routeReach(tx, principal), eq(route.id, id)))
    .returning(routeColumns)
  if (row === undefined) throw noSuchRoute(id)
  const detail = await detailOf(tx, principal.companyId, row)
  await emit(tx, principal, { aggregate: "route", aggregateId: row.id, kind: "route-dispatched", payload: routeOfDetail(detail), projectId: row.projectId, occurredAt: at })
  return detail
}

/** A route's own refusal in a bulk dispatch: the status and the sentence its dispatch answers — a 404 for a route not here, a 409 for one its state refuses — or undefined for anything else, which fails the request. */
function refusalOf(error: unknown): { status: 404 | 409; detail: string } | undefined {
  if (!(error instanceof ProblemError)) return undefined
  const { status, detail } = error.body
  return (status === 404 || status === 409) && detail !== undefined ? { status, detail } : undefined
}

/**
 * What `day` is to the route by its project's calendar (O5 of #290): the
 * project's weekend, its holiday list's holiday on that day where it names
 * a list, and, for a generated route, its scheme's holiday policy and
 * service days, read through the domain's one rule (execution/operating-day).
 */
async function operatingDayOf(tx: Tx, scope: Scope, current: RouteRow, day: string): Promise<OperatingDayReading> {
  const [calendar] = await tx
    .select({ weekend: project.weekend, holidayList: project.holidayList })
    .from(project)
    .where(and(eq(project.companyId, scope.companyId), eq(project.id, scope.projectId)))
    .limit(1)
  if (calendar === undefined) throw noSuchRoute(current.id)
  const holidays =
    calendar.holidayList === null
      ? []
      : await tx
          .select({ day: collectionCalendarHoliday.day, name: collectionCalendarHoliday.name })
          .from(collectionCalendarHoliday)
          .where(and(eq(collectionCalendarHoliday.companyId, scope.companyId), eq(collectionCalendarHoliday.projectId, scope.projectId), eq(collectionCalendarHoliday.day, day)))
  const [scheme] =
    current.routeSchemeId === null
      ? []
      : await tx
          .select({ holidayPolicy: routeScheme.holidayPolicy, serviceDays: routeScheme.serviceDays })
          .from(routeScheme)
          .where(and(eq(routeScheme.companyId, scope.companyId), eq(routeScheme.id, current.routeSchemeId)))
          .limit(1)
  return operatingDayReading(
    { weekend: calendar.weekend as ServiceDay[], holidays: holidayListOf(holidays, calendar.holidayList) },
    day,
    scheme === undefined ? null : { holidayPolicy: scheme.holidayPolicy as HolidayPolicy, serviceDays: scheme.serviceDays as ServiceDay[] },
  )
}

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
  "The vehicle is a powered vehicle of the route's project, the trailer a trailer of it, the driver one of its drivers, the service provider one of this company's, the depot one of its depots, and the unloading station one of this company's that accepts at least one of the waste fractions the route's pickups carry (a route with no pickups yet names any station) — each refused (400) at its field. Where the route ends up naming both a driver and a vehicle, the driver holds the licence class the vehicle requires on the operating date, refused at `driverId` with the reason. Then, after every such 400, the statuses of what the body named afresh: a vehicle or a trailer that is not active — retired, unavailable or in maintenance, the rule a route's start holds — and an inactive or a suspended driver are refused (409) naming the row and its status, while a stored one the body did not move is not asked."

const commandProblems = (action: "view" | "edit" | "crew") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action === "view" ? "view" : "edit"}\` on \`${MODULE}\`.`),
  404: describeProblem(
    action === "edit"
      ? "No route with that id in the projects this account works in: a Service Provider's account reads the routes it runs and crews them through `assign` and `dispatch` alone."
      : "No route with that id in the projects this account works in, or, for a Service Provider's account, none its provider runs.",
  ),
})

/** What a provider's `assign` is held to, spelled once for its description. */
const PROVIDER_ASSIGN =
  "A Service Provider's account assigns on a route its provider runs (as `GET /routes` reaches it), and changes it to its own fleet alone: a vehicle and a trailer its provider owns and a driver it employs, of the route's project — another is refused (400) at its field, `Not a vehicle of NordRen ApS` — and never the depot or the unloading station, which are the office's to set, nor another provider as the route's planned provider (400 at the field); a field it restates as the route stands changes nothing and is not refused."

/** What an ad-hoc route is made with: its day, the depot, the station and the Planned Assignment's vehicle and driver the body names, its note, and, for a split (O23 of #290), the start and the provider of the route it came from. */
type AdHocRoute = { operatingDate: string; plannedVehicleId: string | null; plannedDriverId: string | null; depotId: string | null; unloadingStationId: string | null; note: string | null; plannedStartTime?: string | null; plannedServiceProviderId?: string | null; acceptSameDay?: boolean }

/**
 * The office's ad-hoc route (#111), made on a project's day and numbered from
 * the company's counter: the depot, the station, the vehicle and the driver
 * judged as `POST /routes` judges them — each a 400 at its field, the pair's
 * licence on the day, then the statuses and the periods away as 409s — and
 * `route-reassigned` written where it names a driver or a vehicle. What
 * `POST /routes` makes, and what a split moves its stops onto
 * (routes/stop-moves.ts, O23 of #290), whose depot and station are the ones
 * the route split already stands on and so are not asked again.
 */
export async function createAdHocRoute(tx: Tx, principal: Principal, scope: Scope, values: AdHocRoute, at: Date, { endsKnown = false }: { endsKnown?: boolean } = {}): Promise<RouteRow> {
  const named = { plannedVehicleId: values.plannedVehicleId, plannedDriverId: values.plannedDriverId, depotId: values.depotId, unloadingStationId: values.unloadingStationId }

  // The 400s in body order: the depot, the station, the vehicle and the driver the project's or the company's, then the pair's licence on the day, as `assign` judges it.
  if (!endsKnown) {
    await requireDepot(tx, scope, named.depotId)
    await requireUnloadingStation(tx, principal.companyId, named.unloadingStationId)
  }
  const vehicle = named.plannedVehicleId === null ? null : await findVehicle(tx, scope, named.plannedVehicleId, "powered-vehicle", "vehicleId")
  const driver = named.plannedDriverId === null ? null : await findDriver(tx, scope, named.plannedDriverId, "driverId")
  await requireLicenceOn(tx, scope, named, values.operatingDate, "driverId", { vehicle: vehicle ?? undefined, driver: driver ?? undefined })

  // The statuses last, 409s after every 400; then whether the crew named is there on the day (O6 of #290).
  if (vehicle !== null) refuseVehicleNotActive(vehicle.status, vehicleLabel(vehicle))
  if (driver !== null) refuseUnavailableDriver(driver.status, driver.name, "a route")
  await refuseCrewAway(tx, scope, { vehicleId: named.plannedVehicleId, driverId: named.plannedDriverId }, oneDay(values.operatingDate), "a route")
  // Then the day's allocations of the crew (O7 of #290); the other routes of the day once the route is there to weigh, below.
  await refuseAllocatedElsewhere(tx, scope, { vehicleId: named.plannedVehicleId, driverId: named.plannedDriverId, trailerId: null }, values.operatingDate)

  const number = await nextNumber(tx, principal.companyId, "nextRouteNumber")
  const [row] = await tx
    .insert(route)
    .values({
      id: newId(),
      ...scope,
      routeSchemeId: null,
      collectionGroupId: null,
      serviceDate: values.operatingDate,
      operatingDate: values.operatingDate,
      status: "planned",
      note: values.note,
      number,
      plannedStartTime: values.plannedStartTime ?? null,
      plannedServiceProviderId: values.plannedServiceProviderId ?? null,
      ...named,
    })
    .returning(routeColumns)
  // The crew on another route of the day (O7 of #290): a new route has no measured Plan, so beside another it is taken only with `acceptSameDay`; a refusal takes the row back with the request.
  await refuseDoubleBooked(tx, scope, row, { vehicle: true, driver: true, trailer: false }, values.acceptSameDay === true)
  if (row.plannedDriverId !== null || row.plannedVehicleId !== null) {
    const detail = await detailOf(tx, principal.companyId, row)
    await emit(tx, principal, { aggregate: "route", aggregateId: row.id, kind: "route-reassigned", payload: routeOfDetail(detail), projectId: row.projectId, occurredAt: at })
  }
  return row
}

/**
 * The office's cancel of a route its machine lets go (`routeTransition`'s
 * `move`; the caller has judged the transition): the reason code and the
 * free reason, `cancelledAt` and the hold cleared, every planned stop closed
 * as the domain's `openPickupsClose` says, an open session ended, and
 * `route-cancelled` then one `pickup-skipped` per stop closed written. What
 * `POST /routes/:id/cancel` does, and what a merge does to the route it
 * empties (routes/stop-moves.ts, O23 of #290).
 */
export async function cancelLockedRoute(tx: Tx, principal: Principal, current: RouteRow, to: RouteStatus, cancel: { reasonCode: OfficeCancelReasonCode; reason: string }, at: Date): Promise<RouteDetail> {
  const [row] = await tx
    .update(route)
    .set({ status: to, note: cancel.reason, cancelReasonCode: cancel.reasonCode, cancelledAt: at, heldAt: null })
    .where(and(routeScope(principal), eq(route.id, current.id)))
    .returning(routeColumns)
  if (row === undefined) throw noSuchRoute(current.id)
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
  await emit(tx, principal, { aggregate: "route", aggregateId: row.id, kind: "route-cancelled", payload: routeOfDetail(detail), projectId: row.projectId, occurredAt: at })
  for (const stop of closed) {
    await emit(tx, principal, { aggregate: "pickup", aggregateId: stop.id, kind: "pickup-skipped", payload: pickupOf(stop), projectId: stop.projectId, occurredAt: at })
  }
  return detail
}

export function routeRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date(), routing, jobs }: ClockOptions & { routing: RoutingIdentity; jobs: JobSender }) {
  return new Hono<AuthEnv>()
    .get(
      "/routes",
      describeRoute({
        operationId: "listRoutes",
        summary: "The dated routes of the caller's projects",
        description:
          "One page of routes, oldest first (ids are time-ordered), from the projects the caller works in — or, for a Service Provider's account, which works in none, the routes its provider runs: a route whose scheme plans inside a planning area of a Service Area assigned to the provider, the assignment and the area both in force on the route's operating date; the office's ad-hoc route and a route of a scheme with no planning area are no provider's. `projectId` narrows it to one of the caller's projects; naming another, or any from a provider's account, is refused. `routeSchemeId` and `collectionGroupId` answer what a scheme or a group generated — the office's ad-hoc route (#111) carries both null, and is answered by neither — `from` and `to` the routes operating over a window of days (both inclusive, `to` on or after `from`), `serviceDate` the routes of one recurrence day, `status` one of the five, and `plannedDriverId` and `plannedVehicleId` a driver's or a vehicle's day. Every row carries its `progress`, counted from its pickups and never stored, and its active Plan's reading (`activePlan`, null while the generated order stands unmeasured), the one a map drawn over the page reads each route's measurement from (#173). Hand `nextCursor` back as `cursor` for the next page.",
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
              routeReach(tx, principal),
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
        const [listed, plans, workloads] = await Promise.all([routesOf(tx, principal.companyId, items), activePlansByRoute(tx, principal.companyId, items), workloadsByRoute(tx, principal.companyId, items)])
        const shifts = await shiftsByRoute(tx, principal.companyId, items, workloads)
        const page: RouteListItem[] = listed.map((item) => ({ ...item, activePlan: plans.get(item.id) ?? null, workload: workloads.get(item.id) ?? NO_WORKLOAD, shift: shifts.get(item.id) ?? NO_SHIFT }))
        return c.json({ items: page, nextCursor })
      },
    )
    .post(
      "/routes",
      describeRoute({
        operationId: "createRoute",
        summary: "Make an ad-hoc route",
        description:
          "The office's ad-hoc route (#111): a route with no scheme and no group — `routeSchemeId` and `collectionGroupId` null — on one of the caller's projects, running on `operatingDate`, which is its `serviceDate` too, `planned`, numbered from the company's route counter (`RC-1100`), with the depot, the unloading station, the planned vehicle and the planned driver where the body names them and the note it gives. No generation run reads it: it is never refreshed, cancelled or held, its stops are the ones `POST /routes/{id}/pickups` adds, and from here every command of a generated route moves it, `release-hold` excepted. The vehicle is a powered vehicle of the project, the driver one of its drivers, the depot one of its depots and the station one of this company's — each refused (400) at its field — and where the body names both a driver and a vehicle, the driver holds the licence class the vehicle requires on the operating date, refused at `driverId` with the reason; then, after every 400, a vehicle that is not active and an inactive or a suspended driver are refused (409) naming the row and its status, as `assign` refuses them, and then a vehicle out of use or a driver absent on the operating date (O6 of #290), naming the period. Then the day beyond the route (O7 of #290): a live allocation (`planned` or `confirmed`) whose window meets the operating date on the project's clock and reserves one of the route's crew with another of it — the vehicle with another driver, the driver with another vehicle — is refused (409, `WH-24 is allocated Mon 5 Oct 06:00–14:00 with Freja Holm; plan the route with the allocation's crew, or change the allocation first`); and the crew on another of the project's routes of the day that is planned, ready or active is judged by the two routes' spans — a new route has no measured Plan, so its span is not known —, each its start and its work as the route read weighs it (`shift`): a known overlap is refused (409) whatever the body says, spans apart are taken, and a span not known — no start, or no measured Plan — is refused (409, `… confirm the same day to plan WH-24 on both`) until the body says `acceptSameDay: true`, which never takes back a known overlap; the flag alone moves nothing. The `route-reassigned` event is written in the same transaction when the body names a driver or a vehicle, carrying the route as answered here, as `assign` writes it when either moves.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The route, planned, with no stops yet.", RouteDetail),
          400: describeProblem("The body is missing the project or the day, names a member the command does not take, names a project this account does not work in, or names a vehicle, driver, depot or station the rules above refuse — each at the field that is wrong."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`create\` on \`${MODULE}\`.`),
          409: describeProblem("A vehicle the body names is not active or is out of use on the day, or a driver it names is inactive, suspended or absent on the day, is allocated that day with another crew, or is on another route of the day at once or without `acceptSameDay`; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", RouteCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId, "projectId")
        const scope: Scope = { companyId: principal.companyId, projectId: body.projectId }
        const row = await createAdHocRoute(tx, principal, scope, { operatingDate: body.operatingDate, plannedVehicleId: body.vehicleId ?? null, plannedDriverId: body.driverId ?? null, depotId: body.depotId ?? null, unloadingStationId: body.unloadingStationId ?? null, note: body.note ?? null, acceptSameDay: body.acceptSameDay === true }, now())
        return created(c, "/routes", await detailOf(tx, principal.companyId, row))
      },
    )
    .get(
      "/routes/:id",
      describeRoute({
        operationId: "getRoute",
        summary: "One route with its pickups, sessions and unloads",
        description:
          "One route of a project the caller works in, or one a Service Provider's account runs (as `GET /routes` reaches it), as it now stands: the route with its `progress`, its pickups by position, the open session or null, every session oldest first, and its unloads oldest first. A route of another company, or one outside that reach, is a route that does not exist here. What the device said is `GET /routes/{id}/commands`.",
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
        const row = await findReachedRoute(tx, principal, id)
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
          "The `assign` command: moves the planned vehicle, driver, trailer, service provider, depot or unloading station of a route that has not started, any of them cleared with null; at least one field must be given. Under the route's row lock. A `planned` route stays `planned` and a `ready` one stays `ready` — a route already running is refused (409): the session's driver and vehicle are its actual assignment, and a swap mid-route is a Ticket's outcome later; a completed or cancelled route does not change. A `ready` route keeps a driver: it was dispatched to one, and a dispatched route without a driver would reach no device, so clearing `driverId` on it is refused (409, `Route RC-1042 is dispatched; assign another driver or cancel it`) where moving it to another driver is not. " +
          ASSIGN_RULES +
          " A vehicle or trailer out of use, or a driver absent, on the operating date (O6 of #290) is refused (409) naming the period, after the statuses and for what the body names afresh alone. Then the day beyond the route (O7 of #290): a live allocation (`planned` or `confirmed`) whose window meets the operating date on the project's clock and reserves one of the route's crew, where the body moves the vehicle, the driver or the trailer, with another of it — the vehicle with another driver or trailer, the driver or the trailer with another vehicle — is refused (409, `WH-24 is allocated Mon 5 Oct 06:00–14:00 with Freja Holm; plan the route with the allocation's crew, or change the allocation first`); and the crew on another of the project's routes of the day that is planned, ready or active named afresh is judged by the two routes' spans, each its start and its work as the route read weighs it (`shift`): a known overlap is refused (409) whatever the body says, spans apart are taken, and a span not known — no start, or no measured Plan — is refused (409, `… confirm the same day to plan WH-24 on both`) until the body says `acceptSameDay: true`, which never takes back a known overlap; the flag alone moves nothing. A vehicle named afresh serves the route's open stops that load waste (O7 of #290), or is refused (409) in the first rule it breaks: a fraction none of its compartments carries (a vehicle whose compartments name none carries any; `WH-24 has no compartment for Glass, which 3 stops of route RC-1042 collect`), a container its type does not lift (a type the compatibility set names nothing for lifts any), a stop expected to weigh more than one trip takes of its fraction — the capacity of the compartments carrying it, within the vehicle's payload. A route heavier than one payload is not refused: its Plan unloads on the way, and `workload.overCapacityKg` says how far over. " +
          PROVIDER_ASSIGN +
          " " +
          HOLDS +
          " The `route-reassigned` event is written in the same transaction when the driver, the vehicle or the service provider moved, carrying the route as answered here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route as it now stands.", RouteDetail),
          400: describeProblem(
            "The path does not hold an id, or the body changes nothing, names a member the command does not take, or names a vehicle, trailer, driver, service provider, depot or station the rules above refuse — each at the field that is wrong.",
          ),
          ...commandProblems("crew"),
          409: describeProblem("The route is active, completed or cancelled, the body clears the driver of a ready route, or a vehicle or trailer named afresh is not active or is out of use on the operating date, or a driver named afresh is inactive, suspended or absent on it, the crew is allocated that day with another, a crew member named afresh is on another route of the day at once or without `acceptSameDay`, or a vehicle named afresh cannot serve the route's open stops; the detail says which."),
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
        const current = await lockedCrewedRoute(tx, principal, id)
        requireNotStarted(current, ASSIGNMENT_IS_THE_SESSIONS)
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        const crew = crewOf(principal)
        // The assignment the command leaves behind: the body's fields where given, the stored ones where not; a null given clears.
        const after: Assignment = {
          plannedVehicleId: body.vehicleId === undefined ? current.plannedVehicleId : body.vehicleId,
          plannedDriverId: body.driverId === undefined ? current.plannedDriverId : body.driverId,
          plannedTrailerId: body.trailerId === undefined ? current.plannedTrailerId : body.trailerId,
          plannedServiceProviderId: body.serviceProviderId === undefined ? current.plannedServiceProviderId : body.serviceProviderId,
          depotId: body.depotId === undefined ? current.depotId : body.depotId,
          unloadingStationId: body.unloadingStationId === undefined ? current.unloadingStationId : body.unloadingStationId,
        }
        const moved = { vehicle: body.vehicleId !== undefined, driver: body.driverId !== undefined, trailer: body.trailerId !== undefined, provider: body.serviceProviderId !== undefined, depot: body.depotId !== undefined, station: body.unloadingStationId !== undefined }
        // The route's own state, judged with `requireNotStarted` before the body's references: a dispatched route keeps a driver (dispatch demanded one), so clearing it is refused where moving it is not.
        if (current.status === "ready" && moved.driver && after.plannedDriverId === null) throw problem(409, { detail: dispatchedNeedsADriver(labelOf(current)) })

        // A provider's account names its own fleet and nothing of the office's: a depot or a station it would change is refused at its field, together; a field it restates as it stands names nothing new.
        const changes = {
          vehicle: after.plannedVehicleId !== current.plannedVehicleId,
          driver: after.plannedDriverId !== current.plannedDriverId,
          trailer: after.plannedTrailerId !== current.plannedTrailerId,
          provider: after.plannedServiceProviderId !== current.plannedServiceProviderId,
          depot: after.depotId !== current.depotId,
          station: after.unloadingStationId !== current.unloadingStationId,
        }
        // The route's planned provider, too, it changes to itself alone.
        const elsewhere = crew !== undefined && changes.provider && after.plannedServiceProviderId !== crew.serviceProviderId
        if (crew !== undefined && (elsewhere || changes.depot || changes.station)) {
          throw invalidRequest("body", [
            ...(elsewhere ? [{ path: "serviceProviderId", message: plansForItself(crew.provider) }] : []),
            ...(changes.depot ? [{ path: "depotId", message: officeSetsIt("depot", crew.provider) }] : []),
            ...(changes.station ? [{ path: "unloadingStationId", message: officeSetsIt("unloading station", crew.provider) }] : []),
          ])
        }
        // From a provider's account, a row it changes the route to is its own.
        const ownedIf = (changed: boolean) => (changed ? crew : undefined)

        // The 400s in body order: what is named afresh is the project's and of its kind — and, from a provider's account, its own — then the pair's licence on the operating date — over the rows just read where the body named them — then the places.
        const vehicle = moved.vehicle && after.plannedVehicleId !== null ? await findVehicle(tx, scope, after.plannedVehicleId, "powered-vehicle", "vehicleId", ownedIf(changes.vehicle)) : null
        const driver = moved.driver && after.plannedDriverId !== null ? await findDriver(tx, scope, after.plannedDriverId, "driverId", ownedIf(changes.driver)) : null
        const trailer = moved.trailer && after.plannedTrailerId !== null ? await findVehicle(tx, scope, after.plannedTrailerId, "trailer", "trailerId", ownedIf(changes.trailer)) : null
        if (moved.vehicle || moved.driver) await requireLicenceOn(tx, scope, after, current.operatingDate, "driverId", { vehicle: vehicle ?? undefined, driver: driver ?? undefined })
        if (moved.provider && after.plannedServiceProviderId !== null) await requireServiceProvider(tx, principal.companyId, after.plannedServiceProviderId, "serviceProviderId")
        if (moved.depot) await requireDepot(tx, scope, after.depotId)
        if (moved.station && after.unloadingStationId !== null) await requireStationAccepting(tx, principal.companyId, current.id, after.unloadingStationId)

        // The statuses last, 409s after every 400: what the body named afresh is in service, then there on the operating date (O6 of #290).
        if (vehicle !== null) refuseVehicleNotActive(vehicle.status, vehicleLabel(vehicle))
        if (trailer !== null) refuseVehicleNotActive(trailer.status, vehicleLabel(trailer), "trailer")
        if (driver !== null) refuseUnavailableDriver(driver.status, driver.name, "a route")
        await refuseCrewAway(tx, scope, { vehicleId: vehicle?.id, trailerId: trailer?.id, driverId: driver?.id }, oneDay(current.operatingDate), "a route")
        // Then the day beyond the route (O7 of #290): an allocation reserving the crew with another, and the crew named afresh on another route at once.
        if (changes.vehicle || changes.driver || changes.trailer) {
          await refuseAllocatedElsewhere(tx, scope, { vehicleId: after.plannedVehicleId, driverId: after.plannedDriverId, trailerId: after.plannedTrailerId }, current.operatingDate)
        }
        await refuseDoubleBooked(tx, scope, { ...current, ...after }, { vehicle: changes.vehicle, driver: changes.driver, trailer: changes.trailer }, body.acceptSameDay === true)
        // A vehicle named afresh serves the route's open stops (O7 of #290): their fractions, their containers, one trip's weight of each.
        if (vehicle !== null) await refuseMisfit(tx, principal.companyId, vehicle.id, await routeFitStops(tx, principal.companyId, current.id), `route ${labelOf(current)}`)

        const at = now()
        const changed = (Object.keys(after) as Array<keyof Assignment>).some((key) => after[key] !== current[key])
        const [row] = await tx
          .update(route)
          .set({ ...after, ...holdOf(current, changed, at) })
          .where(and(routeReach(tx, principal), eq(route.id, id)))
          .returning(routeColumns)
        if (row === undefined) throw noSuchRoute(id)
        const detail = await detailOf(tx, principal.companyId, row)
        if (row.plannedDriverId !== current.plannedDriverId || row.plannedVehicleId !== current.plannedVehicleId || row.plannedServiceProviderId !== current.plannedServiceProviderId) {
          await emit(tx, principal, { aggregate: "route", aggregateId: row.id, kind: "route-reassigned", payload: routeOfDetail(detail), projectId: row.projectId, occurredAt: at })
        }
        return c.json(detail)
      },
    )
    .post(
      "/routes/dispatch",
      describeRoute({
        operationId: "dispatchRoutes",
        summary: "Dispatch a day of routes, or a selection",
        description:
          "The `dispatch` command over many routes at once (O5 of #290): the body names one to fifty routes — a day's, or a selection of them; a larger day goes in several requests, since each route is a savepoint of the request's transaction — and each is judged exactly as `POST /routes/{id}/dispatch` judges it, in a savepoint of its own under its own row lock: `planned` becomes `ready` with `dispatchedAt` stamped and its hold cleared, and `route-dispatched` is written for it; a route already `ready` is answered as it stands; a route with no planned driver, one whose planned crew is away on its day (O6 of #290: a driver absent, a vehicle or trailer out of use), an active, completed or cancelled one, and an id that is not a route of the caller's projects — for a Service Provider's account, a route its provider does not run, or one crewed by anyone else's fleet — are refused, each on its own, and leave the others to go ahead. The answer is one result per id, in the body's order: `dispatched` with the route as it now stands, or `refused` with the status (404 or 409) and the sentence its own dispatch would have answered. The routes are locked first, in one statement in id order whatever the body's — the order a generation run locks a scheme's routes in — so a bulk dispatch and a run, or two bulk dispatches, over the same routes never wait on each other's second row. 200 whenever the body is well-formed, however many were refused.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One result per route, in the body's order: dispatched with the route, or refused with the status and why.", RouteDispatchResults),
          400: describeProblem("The body names no route, more than fifty, one twice, or a member the command does not take."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("json", RouteDispatchMany),
      async (c) => {
        const { routeIds } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const at = now()
        const results = new Map<string, RouteDispatchResult>()
        // Every named route locked first, in one statement in id order (`lockRows`), the order a generation run locks its scheme's routes in too, so neither waits on the other's second row;
        // then each judged in its own savepoint, so a refusal rolls back that route alone.
        await lockRows(tx, route, principal.companyId, routeIds)
        for (const id of [...routeIds].sort()) {
          try {
            const detail = await tx.transaction((savepoint) => dispatchRoute(savepoint, principal, id, at))
            results.set(id, { routeId: id, outcome: "dispatched", route: routeOfDetail(detail) })
          } catch (error) {
            const refusal = refusalOf(error)
            if (refusal === undefined) throw error
            results.set(id, { routeId: id, outcome: "refused", ...refusal })
          }
        }
        return c.json({ results: routeIds.map((id) => results.get(id) as RouteDispatchResult) })
      },
    )
    .post(
      "/routes/:id/dispatch",
      describeRoute({
        operationId: "dispatchRoute",
        summary: "Dispatch a route to its driver",
        description:
          "The `dispatch` command: `planned` becomes `ready`, `dispatchedAt` is stamped, and the route is frozen against regeneration (#97's rule) and reaches its driver's device; a hold `assign` or `reschedule` put on it (`heldAt`) is cleared, since the route is now frozen whole. A route without a planned driver is refused (409): the driver door's scope is the assignment, so a route without one reaches nobody — assign one first. A planned driver absent, or a planned vehicle or trailer out of use, on the operating date (O6 of #290) — a period recorded after the assign — is refused (409) naming the period: the route goes out with a crew that is there. A Service Provider's account dispatches a route its provider runs (as `GET /routes` reaches it) to its own crew alone: a planned driver and a planned vehicle of its provider's, and the trailer where named, or the command is refused (409, `Route RC-1042's planned driver is not NordRen ApS's; assign one of yours first`). A route already `ready` answers 200 as it stands, without a write; an active one is refused, and a completed or cancelled one does not change. Takes no body. Under the route's row lock; the `route-dispatched` event is written in the same transaction, carrying the route as answered here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route, dispatched.", RouteDetail),
          400: describeProblem("The path does not hold an id."),
          ...commandProblems("crew"),
          409: describeProblem("The route has no planned driver, its planned driver is absent or its planned vehicle or trailer out of use on the operating date, it is already active, or it is completed or cancelled, or — from a provider's account — its planned driver, vehicle or trailer is not the provider's; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        return c.json(await dispatchRoute(c.get("tx"), c.get("principal"), id, now()))
      },
    )
    .post(
      "/routes/:id/reschedule",
      describeRoute({
        operationId: "rescheduleRoute",
        summary: "Move the day a route runs, or its start",
        description:
          "The `reschedule` command: moves `operatingDate`, the day the route runs, or `plannedStartTime`, a time on the project's clock (null clears it); at least one must be given. The `serviceDate` never moves: with the scheme and the group it is the route's identity (ADR-0002). A route that has started is refused (409): the day it runs is fixed; a completed or cancelled one does not change. Where the route names both a planned driver and a planned vehicle, moving the day judges the driver's licence again on the new operating date, refused at `operatingDate` with the reason. A planned vehicle or trailer out of use, or a planned driver absent, on the new day (O6 of #290) is refused (409) naming the period, and the override below never takes that back. Then the new day is judged against the project's calendar (O5 of #290), the rule generation keeps: a holiday on the project's list is a day the route does not run on unless its scheme collects on holidays, and a day of the project's weekend unless its scheme serves that weekday — for the office's ad-hoc route, which has no scheme, every holiday and weekend day. Then the day beyond the route on a new day or start (O7 of #290): a live allocation (`planned` or `confirmed`) whose window meets a new operating date on the project's clock and reserves one of the route's crew with another of it — the vehicle with another driver or trailer, the driver or the trailer with another vehicle — is refused (409, `WH-24 is allocated Mon 5 Oct 06:00–14:00 with Freja Holm; plan the route with the allocation's crew, or change the allocation first`); and the crew on another of the project's routes of the day that is planned, ready or active is judged by the two routes' spans, each its start and its work as the route read weighs it (`shift`): a known overlap is refused (409) whatever the body says, spans apart are taken, and a span not known — no start, or no measured Plan — is refused (409, `… confirm the same day to plan WH-24 on both`) until the body says `acceptSameDay: true`, which never takes back a known overlap; the flag alone moves nothing. A route carrying a planned bulky collection (O11 of #290) does not move off its day, which the customer booked (409, naming how many; take their stops off first). A move onto such a day is refused (409, `Sat 10 Oct is a Saturday of the project's weekend; confirm the move to run route RC-1042 on a non-working day`) until the body says `acceptNonWorkingDay: true`; the flag alone moves nothing, and a move onto a working day ignores it. " +
          HOLDS +
          " Under the route's row lock.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route as it now stands.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body changes nothing, names a member the command does not take, or moves the day to one the planned driver may not take the planned vehicle on."),
          ...commandProblems("edit"),
          409: describeProblem("The route is active, completed or cancelled, the crew it names is away on the new day, allocated that day with another crew, or on another route of the day at once or without `acceptSameDay`, or the body moves it onto a holiday or a weekend day it does not run on without saying so; the detail says which."),
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
        // A new day asks whether the crew the route names is there on it (O6 of #290), as the licence is judged again.
        if (operatingDate !== current.operatingDate) {
          await refuseCrewAway(tx, scope, { vehicleId: current.plannedVehicleId, trailerId: current.plannedTrailerId, driverId: current.plannedDriverId }, oneDay(operatingDate), "a route")
        }
        // The day beyond the route on its new day or start (O7 of #290): the crew's allocations on a new day, and its other routes of the day, whose spans a new start moves too.
        const plannedStartTime = body.plannedStartTime === undefined ? current.plannedStartTime : body.plannedStartTime
        // The stored start is Postgres's `HH:MM:SS`, the body's the wire's `HH:MM`.
        const startMoved = body.plannedStartTime !== undefined && body.plannedStartTime !== (current.plannedStartTime === null ? null : timeOf(current.plannedStartTime))
        if (operatingDate !== current.operatingDate) {
          await refuseAllocatedElsewhere(tx, scope, { vehicleId: current.plannedVehicleId, driverId: current.plannedDriverId, trailerId: current.plannedTrailerId }, operatingDate)
        }
        if (operatingDate !== current.operatingDate || startMoved) {
          await refuseDoubleBooked(tx, scope, { ...current, operatingDate, plannedStartTime }, { vehicle: true, driver: true, trailer: true }, body.acceptSameDay === true)
        }
        // A bulky collection is booked for its route's day (O11 of #290): the route does not move off it while one is planned on it.
        if (operatingDate !== current.operatingDate) await refuseBulkyMoved(tx, scope, current)
        // The 409 that needs the body, after its 400s: a day the route does not run on by its calendar is taken knowingly or not at all.
        if (operatingDate !== current.operatingDate && body.acceptNonWorkingDay !== true) {
          const reading = await operatingDayOf(tx, scope, current, operatingDate)
          if (reading.kind !== "working") throw problem(409, { detail: confirmNonWorkingDay(labelOf(current), operatingDate, reading) })
        }
        const [row] = await tx
          .update(route)
          .set({ operatingDate, plannedStartTime, ...holdOf(current, operatingDate !== current.operatingDate || startMoved, now()) })
          .where(and(routeScope(principal), eq(route.id, id)))
          .returning(routeColumns)
        if (row === undefined) throw noSuchRoute(id)
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .post(
      "/routes/:id/release-hold",
      describeRoute({
        operationId: "releaseRouteHold",
        summary: "Hand a held route back to its scheme",
        description:
          "The `release-hold` command (#226): clears the hold `assign` or `reschedule` put on a `planned` route (`heldAt`), so the route follows its scheme again, and in the same transaction asks a generation run of the route's scheme from the project's today — or the scheme's first day, if later — through the route's service date, so the run's drift stamp is today's as any Generate's would be (a service date already past, or beyond the walk's 366 days, alone), which brings back the scheme's operating date, planned start and Planned Assignment — the operating date alone kept where the route carries a planned bulky collection, booked for its day (O11 of #347). The run is asked as the scheme's Generate asks one, under the scheme's key: where a run of the scheme is already queued or in flight, that run absorbs the request, and one that does not reach the day, or that read the route before the hand-back, leaves it to the next run — the nightly plan-ahead or the next Generate. A run of the scheme is the schemes module's to ask (`edit` on `route-studio.schemes`, as Generate): for a caller without it, for a draft scheme, which generates nothing, and where no worker has made the queue yet, no run is asked and the route is still handed back, the next run bringing it back. The answer is the route as it now stands, its hold cleared, before any run has brought it back. A planned route that is not held is refused (409), and so is a route past `planned`, which is never held, and the office's ad-hoc route, which has no scheme to hand it back to (#111). Takes no body. Under the route's row lock; no event is written, as for `reschedule`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route, its hold cleared; a run of its scheme over its service date is asked.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body names a member: the command takes none."),
          ...commandProblems("edit"),
          409: describeProblem("The route is planned and not held, is past `planned` (ready, active, completed or cancelled), where no hold stands, or is the office's ad-hoc route, which is never held."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", RouteReleaseHold),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        const schemeId = current.routeSchemeId
        if (schemeId === null) throw problem(409, { detail: adHocNeverHeld(labelOf(current)) })
        if (current.status !== "planned") throw problem(409, { detail: onlyPlannedHeld(labelOf(current), current.status) })
        if (current.heldAt === null) throw problem(409, { detail: notHeld(labelOf(current)) })
        const [row] = await tx.update(route).set({ heldAt: null }).where(and(routeScope(principal), eq(route.id, id))).returning(routeColumns)
        if (row === undefined) throw noSuchRoute(id)
        // The scheme's day, start and assignment come back with a run over the route's service date: asked here where the caller may
        // ask a run of the scheme (Generate's grant), never awaited, and never a refusal of the hand-back.
        const scheme = allows(principal.grants, SCHEMES_MODULE, "edit") ? await findScheme(tx, principal, schemeId) : undefined
        if (scheme !== undefined && scheme.status === "validated") {
          try {
            const today = await projectToday(tx, { companyId: principal.companyId, projectId: row.projectId }, now)()
            await askGeneration(tx, principal, jobs.send, scheme, handBackWindow({ today, schemeFrom: scheme.validFrom, serviceDate: row.serviceDate }))
          } catch (error) {
            // No worker has made the queue yet: the hold is cleared all the same, and the next run brings the route back.
            if (!(error instanceof QueueMissing)) throw error
          }
        }
        return c.json(await detailOf(tx, principal.companyId, row))
      },
    )
    .post(
      "/routes/:id/cancel",
      describeRoute({
        operationId: "cancelRoute",
        summary: "Cancel a route",
        description:
          "The `cancel` command: a `planned`, `ready` or `active` route becomes `cancelled` with the body's reason code as its `cancelReasonCode` — one of the office's eight (O5 of #290; `regeneration` is a generation run's to write) — the free reason as its `note`, and `cancelledAt` stamped; every `planned` pickup of it is closed as `skipped` with the reason `route-cancelled` and its `outcomeAt`, since nobody will attempt it, and an open session is ended, since the route is no longer being driven. A pickup with an outcome already keeps it. A hold on the route (`heldAt`) is cleared, since a hold is a planned route's; generation's own cancel of a route the scheme no longer runs clears it the same way, so a route generation cancelled and later brings back returns to its scheme's day, start and Planned Assignment, not to what the office had held. A completed route does not change (409); one already cancelled answers 200 as it stands, without a write. Under the route's row lock; the `route-cancelled` event and one `pickup-skipped` per pickup closed are written in the same transaction.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route, cancelled, with its pickups as the cancellation left them.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body has no reason code of the office's, no reason, or carries a member the command does not take."),
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
        const { reasonCode, reason } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        const transition = routeTransition(current.status as RouteStatus, "cancel", labelOf(current))
        if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
        if (transition.kind === "stay") return c.json(await detailOf(tx, principal.companyId, current))
        return c.json(await cancelLockedRoute(tx, principal, current, transition.to, { reasonCode, reason }, now()))
      },
    )
    .put(
      "/routes/:id/pickup-order",
      describeRoute({
        operationId: "putRoutePickupOrder",
        summary: "Reorder a route's stops",
        description:
          "The dispatcher's order becomes a `manual` Plan (#170, decided on #124): the body names every `planned` pickup of the route exactly once, in the order they will be visited, and that sequence is written as a Plan, made the route's active one, and sent for measurement — the fake or the provider answers its legs and totals on the worker, never on this request. `pickup.position`, the generated baseline, is never rewritten (ADR-0002), so the next generation run cannot undo the dispatcher; the route's read orders by `sequence`, the active Plan's word. An identical order already measured is re-activated and consumes no provider call; one still measuring is answered as it stands. One left out, or one named that is not an open pickup of this route, is refused (400 at `pickupIds`) counting both. A route that has started is refused (409): the sequence is frozen once a session has started (ADR-0002); a completed or cancelled one does not change. Under the route's row lock; the route's `updatedAt` moves, since the order is part of the route on the wire.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route with its pickups in the new order, the manual Plan active and measuring.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body is missing `pickupIds`, names a member it does not own, names a pickup twice, or is not exactly the route's open pickups."),
          ...commandProblems("edit"),
          409: describeProblem("The route is active, completed or cancelled."),
          503: describeProblem("No worker has started on this database yet, so the routing queue is not there to send the order's measurement to; nothing was written."),
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
        // The order becomes a manual Plan, active from creation, its measurement enqueued under the Plan-id
        // singleton (routes/plan-shapes.ts) — the in-place rewrite of pickup.position is retired (#124's clobber).
        await ensurePlan(tx, principal, row, { solver: "manual", orderedPickupIds: pickupIds }, { routing, jobs })
        const [activated] = await tx
          .select(routeColumns)
          .from(route)
          .where(and(routeScope(principal), eq(route.id, id)))
          .limit(1)
        return c.json(await detailOf(tx, principal.companyId, activated ?? row))
      },
    )
    .get(
      "/routes/:id/commands",
      describeRoute({
        operationId: "listRouteCommands",
        summary: "What the device said on a route",
        description:
          "One page of the route's command receipts, oldest first — a cursor over time-ordered ids is a cursor over the order the commands were received in — each carrying the command as the device sent it, verbatim, and what became of it: `applied`, or `rejected` with the problem the server answered. The dispatcher's log of what the device said, rejections included; nothing here is ever updated or removed. A route of another company, or one outside the caller's reach — its projects, or the routes a Service Provider's account runs, as `GET /routes` reaches them — is a route that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
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
        if ((await findReachedRoute(tx, principal, id)) === undefined) throw noSuchRoute(id)
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
