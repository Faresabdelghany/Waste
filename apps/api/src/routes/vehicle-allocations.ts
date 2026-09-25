// Vehicle allocations (Issue #101, slice 6; ADR-0005 over instants): the
// current reservation of a vehicle, and the history of everything done to it.
// `GET /vehicle-allocations` lists them, `POST /vehicle-allocations` is the
// `allocate` command, `GET /vehicle-allocations/:id` reads one, and the three
// commands `POST …/:id/change`, `…/confirm` and `…/release` move it;
// `GET …/:id/events` is its history, oldest first. There is no PATCH and no
// delete: an allocation is never edited by a form, and a released one keeps
// its row and its history.
//
// Two tables, one function that writes both (#101 §5). `vehicle_allocation`
// is the row the database's three partial exclusion constraints hold — one
// live reservation of a vehicle, of a driver, of a trailer at a time, released
// rows ignored — and `vehicle_allocation_event` is the append-only ledger the
// API role may not update or delete: every command that changes the row
// appends one event in the same transaction, carrying the action, the status
// after it, the snapshot the allocation then reserved and who did it, so the
// history is complete by construction. A command that finds the row already
// in the state it asks for — confirm on a confirmed one, release on a released
// one — answers 200 without a write and without an event, as `deactivate`
// does for a user. A released allocation changes no more (409): the window is
// freed, and what is wanted next is a new allocation.
//
// The rules a reservation is held to, spelled once in `holdReservation` for
// the create and the change alike, since a change composes the row it leaves
// behind from the body and the stored row and holds that: the window is
// ordered (the contracts hold a body carrying both bounds, this the merged
// pair, in the contracts' words); the vehicle is a `powered-vehicle` of the
// project and not retired; the trailer, where named, a `trailer` of it — the
// kind is what keeps an allocation's two vehicle columns apart, and the one
// case the kinds cannot see, a trailer standing as another live allocation's
// `vehicle_id` over the window (a row an import wrote, since the API never
// writes one), is a 400 on `trailerId` here (#101 §6.21); the driver, where
// named, one of the project's who holds the class the vehicle requires on the
// window's last day — `plannedTo` rendered as a day in the project's timezone
// (routes/days.ts), the day the reservation ends and the driver is still meant
// to be driving — refused on `driverId` with the domain's sentence; the depot
// the project's and the fraction the company's. Then the write, under
// `refuseOverlap` with one sentence per constraint saying whose window it was.
//
// `?overlappingFrom=&overlappingTo=` is the read Planning's Issue #11 check
// makes: the allocations whose window touches one, `tstzrange && tstzrange`,
// both half-open, so a reservation ending exactly when the window starts does
// not touch it. Every statement carries the tenant and `inProjects`
// (auth/projects.ts); the grant is `fleet.vehicle-planning` throughout,
// `view` to read, `create` to allocate, `edit` for the three commands.
import {
  VehicleAllocation,
  VehicleAllocationChange,
  VehicleAllocationConfirm,
  VehicleAllocationCreate,
  VehicleAllocationEvent,
  VehicleAllocationListQuery,
  VehicleAllocationRelease,
  WINDOW_ENDS_AFTER_IT_STARTS,
  windowOrdered,
} from "@waste/contracts/allocations"
import { Page, PageRequest } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { vehicleAllocation, vehicleAllocationEvent } from "@waste/db/schema/allocations"
import { licenceRefusal, licenceSentence } from "@waste/domain/resources/licence"
import type { AllocationAction, AllocationStatus } from "@waste/domain/resources/vocabulary"
import { and, asc, eq, gt, ne, sql, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { dayInTimezone } from "./days"
import { findDriver, findVehicle, projectTimezone, requireDepot, vehicleLabel, type DriverRow, type Scope, type VehicleRow } from "./fleet-lookups"
import { requireWasteFraction } from "./references"
import { describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"

/** The grant every route here runs under: the planner's, not the fleet's. */
const MODULE = "fleet.vehicle-planning"

const AllocationPage = Page(VehicleAllocation)
const EventPage = Page(VehicleAllocationEvent)

/** The three partial exclusion constraints of `vehicle_allocation`, each ignoring released rows, and the sentence for each. */
const VEHICLE_RESERVED = "vehicle_allocation_vehicle_no_overlap"
const DRIVER_RESERVED = "vehicle_allocation_driver_no_overlap"
const TRAILER_RESERVED = "vehicle_allocation_trailer_no_overlap"
const alreadyAllocated = (who: string): string => `${who} is already allocated over part of that window`

/** What a command on a released allocation is told: the window is freed, and what is wanted is a new one. */
const RELEASED_DOES_NOT_CHANGE = "Released allocations do not change; allocate anew"

/** What a body naming a retired vehicle is told, at `vehicleId`. */
const isRetired = (label: string): string => `${label} is retired`

/** What a body naming a trailer that another live allocation reserves as its vehicle is told, at `trailerId`. */
const trailerIsAVehicle = (label: string): string => `${label} is the vehicle of another allocation over part of that window`

const noSuchAllocation = (id: string) => problem(404, { detail: `No vehicle allocation ${id} in the projects this account works in` })

const columns = {
  id: vehicleAllocation.id,
  projectId: vehicleAllocation.projectId,
  vehicleId: vehicleAllocation.vehicleId,
  driverId: vehicleAllocation.driverId,
  trailerId: vehicleAllocation.trailerId,
  depotId: vehicleAllocation.depotId,
  wasteFractionId: vehicleAllocation.wasteFractionId,
  requiredCapacityKg: vehicleAllocation.requiredCapacityKg,
  plannedFrom: vehicleAllocation.plannedFrom,
  plannedTo: vehicleAllocation.plannedTo,
  status: vehicleAllocation.status,
  note: vehicleAllocation.note,
  createdAt: vehicleAllocation.createdAt,
  updatedAt: vehicleAllocation.updatedAt,
}

type Row = Pick<typeof vehicleAllocation.$inferSelect, keyof typeof columns>

const eventColumns = {
  id: vehicleAllocationEvent.id,
  recordedAt: vehicleAllocationEvent.recordedAt,
  projectId: vehicleAllocationEvent.projectId,
  vehicleAllocationId: vehicleAllocationEvent.vehicleAllocationId,
  action: vehicleAllocationEvent.action,
  status: vehicleAllocationEvent.status,
  vehicleId: vehicleAllocationEvent.vehicleId,
  driverId: vehicleAllocationEvent.driverId,
  trailerId: vehicleAllocationEvent.trailerId,
  depotId: vehicleAllocationEvent.depotId,
  plannedFrom: vehicleAllocationEvent.plannedFrom,
  plannedTo: vehicleAllocationEvent.plannedTo,
  reason: vehicleAllocationEvent.reason,
  recordedBy: vehicleAllocationEvent.recordedBy,
}

type EventRow = Pick<typeof vehicleAllocationEvent.$inferSelect, keyof typeof eventColumns>

/** The row on the wire; the window's instants as ISO strings, the status as its enum, since the column is text with a CHECK. */
function allocationOf(row: Row): VehicleAllocation {
  return {
    id: row.id,
    projectId: row.projectId,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    trailerId: row.trailerId,
    depotId: row.depotId,
    wasteFractionId: row.wasteFractionId,
    requiredCapacityKg: row.requiredCapacityKg,
    plannedFrom: row.plannedFrom.toISOString(),
    plannedTo: row.plannedTo.toISOString(),
    status: row.status as AllocationStatus,
    note: row.note,
    ...stampsOf(row),
  }
}

/** One event on the wire. */
function eventOf(row: EventRow): VehicleAllocationEvent {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    vehicleAllocationId: row.vehicleAllocationId,
    action: row.action as AllocationAction,
    status: row.status as AllocationStatus,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    trailerId: row.trailerId,
    depotId: row.depotId,
    plannedFrom: row.plannedFrom.toISOString(),
    plannedTo: row.plannedTo.toISOString(),
    reason: row.reason,
    recordedBy: row.recordedBy,
  }
}

/** The rows of this company, in the projects the caller works in: what every allocation statement is bounded by. */
const allocationScope = (principal: Principal): SQL | undefined =>
  and(eq(vehicleAllocation.companyId, principal.companyId), inProjects(vehicleAllocation.projectId, principal))

/** One allocation of this company by id, inside the caller's projects; undefined when it is neither. */
async function findAllocation(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(vehicleAllocation)
    .where(and(allocationScope(principal), eq(vehicleAllocation.id, id)))
    .limit(1)
  return row
}

/**
 * The `where` fragment matching the rows whose window touches the one given:
 * `tstzrange && tstzrange`, both half-open, the read the exclusion
 * constraints make and the one `?overlappingFrom=&overlappingTo=` asks for.
 * The bounds arrive as RFC 3339 strings and are cast in the database.
 */
const touches = (from: string, to: string): SQL =>
  sql`tstzrange(${vehicleAllocation.plannedFrom}, ${vehicleAllocation.plannedTo}, '[)') && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[)')`

/** What an allocation reserves, as a body says it or as a change leaves it: the row without the server's part and the status. */
type Reservation = {
  vehicleId: string
  driverId: string | null
  trailerId: string | null
  depotId: string | null
  wasteFractionId: string | null
  requiredCapacityKg: number | null
  plannedFrom: string
  plannedTo: string
  note: string | null
}

/** The rows a reservation names, read while it was held, for the sentences the write may need. */
type Reserved = { vehicle: VehicleRow; driver: DriverRow | null; trailer: VehicleRow | null }

/**
 * Every rule of §4 over one reservation, in the order a body reads: the
 * window ordered; the vehicle a powered vehicle of the project and not
 * retired; the trailer a trailer of it, and not the vehicle of another live
 * allocation over the window (`except` the row being changed); the driver one
 * of the project's who holds the vehicle's class on the day the window ends,
 * on the project's clock; the depot the project's; the fraction the
 * company's. Each refusal is a 400 at the field that carried it. The rows read
 * on the way are handed back for the overlap sentences.
 */
async function holdReservation(tx: Tx, scope: Scope, reservation: Reservation, except?: string): Promise<Reserved> {
  if (!windowOrdered(reservation)) throw invalidRequest("body", [{ path: "plannedTo", message: WINDOW_ENDS_AFTER_IT_STARTS }])

  const vehicle = await findVehicle(tx, scope, reservation.vehicleId, "powered-vehicle", "vehicleId")
  if (vehicle.status === "retired") throw invalidRequest("body", [{ path: "vehicleId", message: isRetired(vehicleLabel(vehicle)) }])

  const trailer = reservation.trailerId === null ? null : await findVehicle(tx, scope, reservation.trailerId, "trailer", "trailerId")
  if (trailer !== null) {
    const [clash] = await tx
      .select({ id: vehicleAllocation.id })
      .from(vehicleAllocation)
      .where(
        and(
          eq(vehicleAllocation.companyId, scope.companyId),
          eq(vehicleAllocation.vehicleId, trailer.id),
          ne(vehicleAllocation.status, "released"),
          touches(reservation.plannedFrom, reservation.plannedTo),
          except === undefined ? undefined : ne(vehicleAllocation.id, except),
        ),
      )
      .limit(1)
    if (clash !== undefined) throw invalidRequest("body", [{ path: "trailerId", message: trailerIsAVehicle(vehicleLabel(trailer)) }])
  }

  const driver = reservation.driverId === null ? null : await findDriver(tx, scope, reservation.driverId)
  if (driver !== null) {
    // The window's end, as a day where the driver is: the licence rule takes a day and refuses an instant.
    const timezone = await projectTimezone(tx, scope.companyId, scope.projectId)
    const refusal = licenceRefusal(driver, vehicle.requiredLicenceClass, dayInTimezone(new Date(reservation.plannedTo), timezone))
    if (refusal !== undefined) {
      throw invalidRequest("body", [{ path: "driverId", message: licenceSentence(refusal, { driver: driver.name, vehicle: vehicleLabel(vehicle) }) }])
    }
  }

  await requireDepot(tx, scope, reservation.depotId)
  await requireWasteFraction(tx, scope.companyId, reservation.wasteFractionId)
  return { vehicle, driver, trailer }
}

/** One sentence per constraint the write may hit, naming whose window it was. */
const overlapSentences = (reserved: Reserved): Record<string, string> => ({
  [VEHICLE_RESERVED]: alreadyAllocated(vehicleLabel(reserved.vehicle)),
  ...(reserved.driver === null ? {} : { [DRIVER_RESERVED]: alreadyAllocated(reserved.driver.name) }),
  ...(reserved.trailer === null ? {} : { [TRAILER_RESERVED]: alreadyAllocated(vehicleLabel(reserved.trailer)) }),
})

/** The reservation's window as the column takes it. */
const windowOf = (reservation: Reservation) => ({ plannedFrom: new Date(reservation.plannedFrom), plannedTo: new Date(reservation.plannedTo) })

/**
 * The one place an event is appended: after every write to the row, in the
 * same transaction, carrying the row as the write left it, the action, the
 * reason and the caller's account. No route updates `vehicle_allocation`
 * without coming through here, which is what makes the history complete.
 */
async function appendEvent(tx: Tx, principal: Principal, row: Row, action: AllocationAction, reason: string | null): Promise<void> {
  await tx.insert(vehicleAllocationEvent).values({
    id: newId(),
    companyId: principal.companyId,
    projectId: row.projectId,
    vehicleAllocationId: row.id,
    action,
    status: row.status,
    vehicleId: row.vehicleId,
    driverId: row.driverId,
    trailerId: row.trailerId,
    depotId: row.depotId,
    plannedFrom: row.plannedFrom,
    plannedTo: row.plannedTo,
    reason,
    recordedBy: principal.user.id,
  })
}

/**
 * The allocation the path names, locked and read: the three commands hold
 * rules the API rather than the database holds — the status, the licence, the
 * trailer's other role — so they take the row lock first and read afterwards
 * (routes/shared.ts), and two commands on one allocation take turns.
 */
async function lockedAllocation(tx: Tx, principal: Principal, id: string): Promise<Row> {
  await lockRow(tx, vehicleAllocation, { companyId: principal.companyId, id })
  const current = await findAllocation(tx, principal, id)
  if (current === undefined) throw noSuchAllocation(id)
  return current
}

/** Moves the row to a status, and answers it as written. */
async function setStatus(tx: Tx, principal: Principal, id: string, status: AllocationStatus): Promise<Row> {
  const [row] = await tx
    .update(vehicleAllocation)
    .set({ status })
    .where(and(allocationScope(principal), eq(vehicleAllocation.id, id)))
    .returning(columns)
  if (row === undefined) throw noSuchAllocation(id)
  return row
}

const RESERVATION_RULES =
  "The vehicle is a powered vehicle of that project and not retired; the trailer, where given, a trailer of it, and not the vehicle of another live allocation over the window; the driver, where given, a driver of that project who holds the licence class the vehicle requires on the day the window ends, rendered in the project's timezone — refused at `driverId` with the reason (no class on record, a class too low, a licence expiring before the window ends); the depot one of that project's, the waste fraction this company's. The window is two instants and the end comes after the start."

export function vehicleAllocationRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/vehicle-allocations",
      describeRoute({
        operationId: "listVehicleAllocations",
        summary: "The vehicle allocations the caller's projects hold",
        description:
          "One page of vehicle allocations, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `vehicleId`, `driverId` and `trailerId` answer what one vehicle, driver or trailer is reserved for, `status` the planned, the confirmed or the released ones. `overlappingFrom` and `overlappingTo`, given together, answer the allocations whose window touches that one — both windows half-open, so a reservation ending exactly when the window starts does not touch it — which is the read a planner makes before assigning a collection group's vehicle to a day. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of vehicle allocations.", AllocationPage),
          400: describeProblem(
            "The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, one end of the overlapping window is given without the other or after it, or `projectId` is not a project this account works in.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `fleet.vehicle-planning`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", VehicleAllocationListQuery),
      async (c) => {
        const { limit, cursor, projectId, vehicleId, driverId, trailerId, status, overlappingFrom, overlappingTo } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(vehicleAllocation)
          .where(
            and(
              allocationScope(principal),
              projectId === undefined ? undefined : eq(vehicleAllocation.projectId, projectId),
              vehicleId === undefined ? undefined : eq(vehicleAllocation.vehicleId, vehicleId),
              driverId === undefined ? undefined : eq(vehicleAllocation.driverId, driverId),
              trailerId === undefined ? undefined : eq(vehicleAllocation.trailerId, trailerId),
              status === undefined ? undefined : eq(vehicleAllocation.status, status),
              overlappingFrom === undefined || overlappingTo === undefined ? undefined : touches(overlappingFrom, overlappingTo),
              after === undefined ? undefined : gt(vehicleAllocation.id, after),
            ),
          )
          .orderBy(asc(vehicleAllocation.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(allocationOf), nextCursor })
      },
    )
    .post(
      "/vehicle-allocations",
      describeRoute({
        operationId: "allocateVehicle",
        summary: "Allocate a vehicle over a window",
        description:
          "The `allocate` command: reserves a vehicle, and with it a driver, a trailer and a depot where given, over a window on the clock, in one project the caller works in. " +
          RESERVATION_RULES +
          " The database holds one live reservation of a vehicle, of a driver and of a trailer at a time, so a window touching another live allocation's is refused (409) saying whose it was; a released allocation reserves nothing. `status` is `planned` unless the body says `confirmed`; `released` is a command of its own. The `allocate` event is appended in the same transaction, carrying the snapshot; an allocation names no route and no collection group. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The allocation as it was written.", VehicleAllocation),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, ends on or before the instant it starts, asks to be created `released`, names a vehicle that is not a powered vehicle of that project or is retired, a trailer that is not a trailer of it or is another live allocation's vehicle over the window, a driver who is not that project's or may not take the vehicle on the window's last day, a depot that is not that project's, or a waste fraction that is not this company's — each at the field that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `fleet.vehicle-planning`."),
          409: describeProblem("The vehicle, the driver or the trailer is already allocated over part of that window; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", VehicleAllocationCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const scope: Scope = { companyId: principal.companyId, projectId: values.projectId }
        const reservation: Reservation = {
          vehicleId: values.vehicleId,
          driverId: values.driverId ?? null,
          trailerId: values.trailerId ?? null,
          depotId: values.depotId ?? null,
          wasteFractionId: values.wasteFractionId ?? null,
          requiredCapacityKg: values.requiredCapacityKg ?? null,
          plannedFrom: values.plannedFrom,
          plannedTo: values.plannedTo,
          note: values.note ?? null,
        }
        const reserved = await holdReservation(tx, scope, reservation)
        const [row] = await refuseOverlap(overlapSentences(reserved), () =>
          tx
            .insert(vehicleAllocation)
            .values({ ...reservation, ...windowOf(reservation), id: newId(), companyId: principal.companyId, projectId: values.projectId, status: values.status })
            .returning(columns),
        )
        await appendEvent(tx, principal, row, "allocate", null)
        return c.json(allocationOf(row), 201)
      },
    )
    .get(
      "/vehicle-allocations/:id",
      describeRoute({
        operationId: "getVehicleAllocation",
        summary: "One vehicle allocation",
        description:
          "One allocation of a project the caller works in, as it now stands. An allocation of another company, or of a project this account does not work in, is an allocation that does not exist here. Its history is `GET /vehicle-allocations/{id}/events`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The allocation.", VehicleAllocation),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `fleet.vehicle-planning`."),
          404: describeProblem("No vehicle allocation with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findAllocation(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchAllocation(id)
        return c.json(allocationOf(row))
      },
    )
    .post(
      "/vehicle-allocations/:id/change",
      describeRoute({
        operationId: "changeVehicleAllocation",
        summary: "Change what an allocation reserves",
        description:
          "The `change` command: moves the vehicle, the driver, the trailer, the depot, the fraction, the capacity, the window or the note of one allocation, with a reason; at least one field beside the reason must be given, and a null clears a nullable one. The row the change leaves behind — the body's fields over the stored ones — is held to every rule of the create: " +
          RESERVATION_RULES +
          " A window touching another live allocation's is refused (409) saying whose it was. A released allocation does not change (409): the window is freed, and what is wanted is a new allocation. Runs under the allocation's row lock, and appends the `change` event with the snapshot and the reason in the same transaction; the status does not move.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The allocation as it now stands.", VehicleAllocation),
          400: describeProblem(
            "The path does not hold an id, or the body changes nothing beside the reason, has no reason, names a member the caller does not own (the project and the status included), leaves the window ending on or before its start, or names a vehicle, trailer, driver, depot or fraction the create would refuse — each at the field that is wrong.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `fleet.vehicle-planning`."),
          404: describeProblem("No vehicle allocation with that id in the projects this account works in."),
          409: describeProblem("The allocation is released, or the vehicle, the driver or the trailer is already allocated over part of the new window; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", VehicleAllocationChange),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason, ...moved } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedAllocation(tx, principal, id)
        if (current.status === "released") throw problem(409, { detail: RELEASED_DOES_NOT_CHANGE })
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        // The row the change leaves behind: the body's fields where given, the stored ones where not; a null given clears.
        const reservation: Reservation = {
          vehicleId: moved.vehicleId ?? current.vehicleId,
          driverId: moved.driverId === undefined ? current.driverId : moved.driverId,
          trailerId: moved.trailerId === undefined ? current.trailerId : moved.trailerId,
          depotId: moved.depotId === undefined ? current.depotId : moved.depotId,
          wasteFractionId: moved.wasteFractionId === undefined ? current.wasteFractionId : moved.wasteFractionId,
          requiredCapacityKg: moved.requiredCapacityKg === undefined ? current.requiredCapacityKg : moved.requiredCapacityKg,
          plannedFrom: moved.plannedFrom ?? current.plannedFrom.toISOString(),
          plannedTo: moved.plannedTo ?? current.plannedTo.toISOString(),
          note: moved.note === undefined ? current.note : moved.note,
        }
        const reserved = await holdReservation(tx, scope, reservation, id)
        const [row] = await refuseOverlap(overlapSentences(reserved), () =>
          tx
            .update(vehicleAllocation)
            .set({ ...reservation, ...windowOf(reservation) })
            .where(and(allocationScope(principal), eq(vehicleAllocation.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchAllocation(id)
        await appendEvent(tx, principal, row, "change", reason)
        return c.json(allocationOf(row))
      },
    )
    .post(
      "/vehicle-allocations/:id/confirm",
      describeRoute({
        operationId: "confirmVehicleAllocation",
        summary: "Confirm an allocation",
        description:
          "The `confirm` command: `planned` becomes `confirmed`, which is what blocks another planner's check where a planned one only warns. The body is empty; a member in it is refused. An allocation already confirmed answers 200 as it stands, without a write and without an event; a released one is refused (409). Runs under the allocation's row lock, and appends the `confirm` event with the snapshot in the same transaction.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The allocation, confirmed.", VehicleAllocation),
          400: describeProblem("The path does not hold an id, or the body carries a member."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `fleet.vehicle-planning`."),
          404: describeProblem("No vehicle allocation with that id in the projects this account works in."),
          409: describeProblem("The allocation is released; released allocations do not change."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", VehicleAllocationConfirm),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedAllocation(tx, principal, id)
        if (current.status === "released") throw problem(409, { detail: RELEASED_DOES_NOT_CHANGE })
        if (current.status === "confirmed") return c.json(allocationOf(current))
        const row = await setStatus(tx, principal, id, "confirmed")
        await appendEvent(tx, principal, row, "confirm", null)
        return c.json(allocationOf(row))
      },
    )
    .post(
      "/vehicle-allocations/:id/release",
      describeRoute({
        operationId: "releaseVehicleAllocation",
        summary: "Release an allocation",
        description:
          "The `release` command: the allocation becomes `released`, with a reason, and its window is freed — the database's constraints ignore released rows, so the vehicle, the driver and the trailer may be allocated over it again. The row and its history stay; a released allocation does not change and is not confirmed. An allocation already released answers 200 as it stands, without a write and without an event. Runs under the allocation's row lock, and appends the `release` event with the snapshot and the reason in the same transaction.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The allocation, released.", VehicleAllocation),
          400: describeProblem("The path does not hold an id, or the body has no reason or carries a member the command does not take."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `fleet.vehicle-planning`."),
          404: describeProblem("No vehicle allocation with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", VehicleAllocationRelease),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedAllocation(tx, principal, id)
        if (current.status === "released") return c.json(allocationOf(current))
        const row = await setStatus(tx, principal, id, "released")
        await appendEvent(tx, principal, row, "release", reason)
        return c.json(allocationOf(row))
      },
    )
    .get(
      "/vehicle-allocations/:id/events",
      describeRoute({
        operationId: "listVehicleAllocationEvents",
        summary: "One allocation's history",
        description:
          "One page of the allocation's events, oldest first — a cursor over time-ordered ids is a cursor over recording order — each carrying the action (`allocate`, `change`, `confirm`, `release`), the status after it, the snapshot the allocation then reserved (vehicle, driver, trailer, depot, window), the reason where the command took one, and who did it. The ledger is append-only: nothing here is ever updated or removed. An allocation of another company, or of a project this account does not work in, is an allocation that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the allocation's events, oldest first.", EventPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `fleet.vehicle-planning`."),
          404: describeProblem("No vehicle allocation with that id in the projects this account works in."),
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
        if ((await findAllocation(tx, principal, id)) === undefined) throw noSuchAllocation(id)
        const rows = await tx
          .select(eventColumns)
          .from(vehicleAllocationEvent)
          .where(
            and(
              eq(vehicleAllocationEvent.companyId, principal.companyId),
              eq(vehicleAllocationEvent.vehicleAllocationId, id),
              after === undefined ? undefined : gt(vehicleAllocationEvent.id, after),
            ),
          )
          .orderBy(asc(vehicleAllocationEvent.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(eventOf), nextCursor })
      },
    )
}
