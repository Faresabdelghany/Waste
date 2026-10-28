// Moving stops between routes, splitting a route and merging two (O23 of
// #290, #358). Three commands on the route the stops leave or the route kept:
//
// - `POST /routes/:id/move-stops` moves open stops of the route onto another
//   route of its project;
// - `POST /routes/:id/split` moves open stops of the route onto a new ad-hoc
//   route of its day (#111), with the route's depot, station, start and
//   provider and the vehicle and the driver the body names, where it names
//   them;
// - `POST /routes/:id/merge` moves every open stop of the route the body
//   names onto this one, and cancels that route with the `merged` code.
//
// A stop never changes its route: its proofs, a ticket's booking and the keys
// that name it carry the route beside it (`proof_of_service`'s and
// `ticket`'s composite keys). A move is the stop taken off where it stood —
// `skipped · removed-by-dispatcher`, its note naming where it went, and
// `pickup-skipped` written, as `remove` does (`takeOffStop`) — and the
// office's own stop of the same work put on the other route, judged there as
// Add stop judges one (`addOfficeStop`, routes/pickups.ts): the container's
// placement or the address on that route's service date, a bulky booking for
// its day, a ledger work order's bookings and holds, the same work booked
// twice. A stop booked to answer an open ticket takes the ticket with it: the
// new stop is booked for it, the ticket's comment and the booking ledger
// saying so. That is what makes a move survive the next generation run with
// no hold of its own: a refresh never brings back a stop the dispatcher took
// off, and never skips, moves or doubles the office's (#111;
// @waste/domain/execution/stop-moves). The stop added names the one it was
// moved from (`moved_from_pickup_id`, migration 0055), which Finance reads it
// as: a scheduled collection moved is still billed as one.
//
// Both routes are locked in id order, the order a generation run and a bulk
// dispatch lock routes in, before either is read; both must not have started
// (`requireNotStarted`, the rule Add stop and remove hold), so a dispatched
// route's driver sees the change through the reads the driver door already
// answers, and its active Plan, which names a stop no longer open or misses
// one, reads stale until the night's sweep measures it again (#124 §2), as
// after Add stop and remove. An emptying does not move onto a route that
// empties the container already (409): the two would be one collection told
// twice. The stops go over in the order they stand on the route, each after
// the other route's last position; the dispatcher's order puts them
// elsewhere. Every move is the whole request's: a stop refused rolls back
// the move. Both routes' `updatedAt` moves, their stops being part of them on
// the wire.
//
// The grants are both families': `route-studio.pickups` `edit` for the
// stops, and `route-studio.routes` `create` for a split's new route or `edit`
// for the route a merge cancels. A Service Provider's account commands none
// of them: the routes are read through the office's `routeScope`, so they
// are the family's 404.
import { RouteDetail, RouteMerge, RouteMoveStops, RouteSplit } from "@waste/contracts/routes"
import type { PickupAdd } from "@waste/contracts/pickups"
import type { Tx } from "@waste/db/client"
import { container } from "@waste/db/schema/containers"
import { route } from "@waste/db/schema/execution"
import { ticket } from "@waste/db/schema/resolution"
import { ANOTHER_ROUTE, emptiedAlready, emptiedThereAlready, leavesNoStop, mergedInto, movedTo, movingInOrder, NOT_A_ROUTE_OF_THE_PROJECT, notOpenStopsOf, openStopsInOrder, splitLeavesNone, strangersAmong, type MovingStop } from "@waste/domain/execution/stop-moves"
import { routeTransition } from "@waste/domain/execution/transitions"
import type { OfficeStopService, PickupService, PickupStatus, RouteStatus } from "@waste/domain/execution/vocabulary"
import { OPEN_TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"
import { and, eq, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { detailOf, findRoute, labelOf, noSuchRoute, pickupsOfRoute, routeScope, type PickupRow, type RouteRow } from "./execution-shapes"
import { pickupFitStops, refuseMisfit } from "./fleet-fit"
import { addOfficeStop, takeOffStop } from "./pickups"
import type { Scope } from "./references"
import { cancelLockedRoute, createAdHocRoute, lockedRoute, ORDER_IS_FROZEN, requireNotStarted } from "./routes"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRows, stamp } from "./shared"

const PICKUPS = "route-studio.pickups"
const ROUTES = "route-studio.routes"

const asMoving = (row: PickupRow): MovingStop => ({ id: row.id, position: row.position, status: row.status as PickupStatus, containerId: row.containerId, service: row.service as PickupService })

/**
 * The route path and body name together, both locked in id order and read:
 * the path's own route is the family's 404, while the other is the body's
 * field — the route itself, or one outside the caller's projects or of
 * another project, a 400 at it, since a stop stays in its project.
 */
async function lockedPair(tx: Tx, principal: Principal, id: string, otherId: string): Promise<{ current: RouteRow; other: RouteRow | undefined }> {
  await lockRows(tx, route, principal.companyId, [id, otherId])
  const current = await findRoute(tx, principal, id)
  if (current === undefined) throw noSuchRoute(id)
  if (otherId === id) return { current, other: undefined }
  const other = await findRoute(tx, principal, otherId)
  return { current, other: other !== undefined && other.projectId === current.projectId ? other : undefined }
}

/** The other route a body names, once the path's route has passed its own state: the route itself or one that is not of its project is a 400 at the field. */
function requireOther(current: RouteRow, otherId: string, other: RouteRow | undefined, field: "toRouteId" | "routeId"): RouteRow {
  if (otherId === current.id) throw invalidRequest("body", [{ path: field, message: ANOTHER_ROUTE }])
  if (other === undefined) throw invalidRequest("body", [{ path: field, message: NOT_A_ROUTE_OF_THE_PROJECT }])
  return other
}

/** The open stops of the route the body names, refused (400 at `pickupIds`) where any id is not one, counted. */
function requireOpenStops(named: readonly string[], stops: readonly PickupRow[], current: RouteRow): void {
  const strangers = strangersAmong(named, stops.map(asMoving))
  if (strangers.length > 0) throw invalidRequest("body", [{ path: "pickupIds", message: notOpenStopsOf(strangers.length, labelOf(current)) }])
}

/** The Add stop a moved stop is on the route it joins: the same work, at the same container or address, with what its service books and the note the driver reads, and the open ticket it answers. */
function addedAs(row: PickupRow, ticketId: string | undefined): PickupAdd {
  const service = row.service as OfficeStopService
  const answers = ticketId === undefined ? {} : { ticketId }
  const note = { note: row.note }
  if (service === "bulky") return { service, bulkyBookingId: row.bulkyBookingId, ...note }
  if (row.containerId === null) return { service, propertyId: row.propertyId, sharedCollectionPointId: row.sharedCollectionPointId, wasteFractionId: row.wasteFractionId, ...note, ...answers }
  switch (service) {
    case "deliver":
      return { service, containerId: row.containerId, subscriptionId: row.subscriptionId, wasteFractionId: row.wasteFractionId, ...note, ...answers }
    case "remove":
    case "swap":
      return { service, containerId: row.containerId, warehouseId: row.warehouseId, replacementContainerId: row.replacementContainerId, ...note, ...answers }
    default:
      return { service, containerId: row.containerId, ...note, ...answers }
  }
}

/** The open tickets booked to answer these stops, by stop: each goes with its stop. */
async function ticketsBookedTo(tx: Tx, principal: Principal, stopIds: readonly string[]): Promise<Map<string, string>> {
  if (stopIds.length === 0) return new Map()
  const rows = await tx
    .select({ id: ticket.id, pickupId: ticket.bookedPickupId })
    .from(ticket)
    .where(and(eq(ticket.companyId, principal.companyId), inArray(ticket.bookedPickupId, [...stopIds]), inArray(ticket.status, [...OPEN_TICKET_STATUSES])))
  return new Map(rows.flatMap((row) => (row.pickupId === null ? [] : [[row.pickupId, row.id] as const])))
}

/** A container's label, for the sentence an emptying refused names it by. */
async function containerLabel(tx: Tx, companyId: string, id: string): Promise<string> {
  const [row] = await tx
    .select({ label: container.label })
    .from(container)
    .where(and(eq(container.companyId, companyId), eq(container.id, id)))
    .limit(1)
  return row?.label ?? id
}

/**
 * The stops moved, in the order they stand on the route they leave: each
 * emptying first held against the stops of the route it joins, then every
 * stop taken off and added there, its open ticket with it. Both routes are
 * locked and judged by the caller; their `updatedAt` moves. The balance of a
 * day (routes/route-balance.ts, O15 of #290) moves its stops through it too.
 */
export async function moveStops(tx: Tx, principal: Principal, from: RouteRow, to: RouteRow, moving: readonly PickupRow[], at: Date): Promise<void> {
  const joined = (await pickupsOfRoute(tx, principal.companyId, to.id)).map(asMoving)
  for (const row of moving) {
    const stop = asMoving(row)
    if (emptiedAlready(stop, joined)) throw problem(409, { detail: emptiedThereAlready(await containerLabel(tx, principal.companyId, row.containerId as string), labelOf(to)) })
    joined.push(stop)
  }
  // The route's planned vehicle serves what joins it (O7 of #290): the stops' fractions, their containers, one trip's weight of each.
  if (to.plannedVehicleId !== null) {
    await refuseMisfit(
      tx,
      principal.companyId,
      to.plannedVehicleId,
      await pickupFitStops(
        tx,
        principal.companyId,
        moving.map((row) => row.id),
      ),
      `route ${labelOf(from)}`,
    )
  }
  const tickets = await ticketsBookedTo(
    tx,
    principal,
    moving.map((row) => row.id),
  )
  const note = movedTo(labelOf(to))
  for (const row of moving) {
    await takeOffStop(tx, principal, row.id, note, at)
    await addOfficeStop(tx, principal, to, addedAs(row, tickets.get(row.id)), { routeId: row.routeId, pickupId: row.id })
  }
  await tx
    .update(route)
    .set(stamp())
    .where(and(routeScope(principal), inArray(route.id, [from.id, to.id])))
}

const STATES =
  "Both routes are `planned` or `ready`: one that runs is refused (409, `Route RC-1042 is active; its order is frozen`) and a completed or cancelled one does not change. On a `ready` route the driver's device sees the change through the reads it already makes, and an active Plan reads stale until the route is measured again."

const MOVE =
  "Each stop moved is taken off where it stood — `skipped` with the reason `removed-by-dispatcher`, its note naming the route it went to, `pickup-skipped` written — and the office's own stop of the same work is added to the other route as `POST /routes/{id}/pickups` adds one, after its last position, in the order the stops stood: judged on that route's service date (a container with no placement then, a bulky booking for another day, a work order's container no longer where its move takes it from, the same work planned there already are each a 409 in Add stop's words), and booked for the open ticket the stop answered, where it answered one. An emptying is refused onto a route that empties the container already (409, `Route RC-1043 empties container BIN-7 already; take one of the two stops off instead`), and a stop the route's planned vehicle cannot serve (O7 of #290) — a fraction none of its compartments carries, a container its type does not lift, a stop heavier than one trip of its fraction — is refused (409, `WH-24 has no compartment for Glass, which 2 stops of route RC-1042 collect`). Generation never brings back the stop taken off nor skips or doubles the office's, so the move outlives the next run with no hold. A refusal rolls back the whole move. Under both routes' row locks, taken in id order; both routes' `updatedAt` move."

const problems = (grants: string) => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow ${grants}.`),
  404: describeProblem("No route with that id in the projects this account works in: a Service Provider's account moves no stop."),
})

export function stopMoveRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .post(
      "/routes/:id/move-stops",
      describeRoute({
        operationId: "moveRouteStops",
        summary: "Move stops onto another route",
        description: `Moves open stops of the route (O23 of #290) onto the route \`toRouteId\` names, of the same project (400 at \`toRouteId\` for the route itself or any other). \`pickupIds\` names open stops of this route, each once (400 at \`pickupIds\` counting the ids that are not). ${STATES} ${MOVE}`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The route the stops left, as it now stands.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body names no stop, one twice, an id that is not an open stop of the route, a member the command does not take, or no other route of its project."),
          ...problems(`\`edit\` on \`${PICKUPS}\``),
          409: describeProblem("A route is active, completed or cancelled, or a stop is refused where it would go; the detail says which."),
        },
      }),
      guard,
      requireGrant(PICKUPS, "edit"),
      validate("param", IdParam),
      validate("json", RouteMoveStops),
      async (c) => {
        const { id } = c.req.valid("param")
        const { pickupIds, toRouteId } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { current, other } = await lockedPair(tx, principal, id, toRouteId)
        requireNotStarted(current, ORDER_IS_FROZEN)
        const to = requireOther(current, toRouteId, other, "toRouteId")
        const stops = await pickupsOfRoute(tx, principal.companyId, current.id)
        requireOpenStops(pickupIds, stops, current)
        requireNotStarted(to, ORDER_IS_FROZEN)
        const order = movingInOrder(pickupIds, stops.map(asMoving)).map((stop) => stop.id)
        await moveStops(
          tx,
          principal,
          current,
          to,
          order.map((stopId) => stops.find((row) => row.id === stopId) as PickupRow),
          now(),
        )
        return c.json(await detailOf(tx, principal.companyId, (await findRoute(tx, principal, current.id)) ?? current))
      },
    )
    .post(
      "/routes/:id/split",
      describeRoute({
        operationId: "splitRoute",
        summary: "Split stops off onto a new route",
        description: `Splits the route (O23 of #290): a new ad-hoc route (#111) is made on the route's operating date — its service date too, as \`POST /routes\` makes one — with the route's depot, unloading station, planned start and service provider, and the vehicle, the driver and the note the body names, where it names them, judged as \`POST /routes\` judges them (400 at the field, the licence on the day, then 409s for a vehicle or driver out of service or away that day, allocated that day with another crew, or on another route of the day — taken with \`acceptSameDay\` where the times are not both known, never at once; O7 of #290); then the open stops \`pickupIds\` names move onto it. The stops are open stops of this route, each once (400 at \`pickupIds\` counting the ids that are not), and leave the route some of its open stops (400; a move to another route takes them all). ${STATES} ${MOVE} The \`route-reassigned\` event is written for the new route where it names a driver or a vehicle.`,
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The new route, planned, with the stops moved onto it.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body names no stop, one twice, an id that is not an open stop of the route, every open stop of it, a member the command does not take, or a vehicle or driver the rules of `POST /routes` refuse — each at its field."),
          ...problems(`\`create\` on \`${ROUTES}\` and \`edit\` on \`${PICKUPS}\``),
          409: describeProblem("The route is active, completed or cancelled; a vehicle or driver named is out of service or away on the day; or a stop is refused on the new route; the detail says which."),
        },
      }),
      guard,
      requireGrant(ROUTES, "create"),
      requireGrant(PICKUPS, "edit"),
      validate("param", IdParam),
      validate("json", RouteSplit),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedRoute(tx, principal, id)
        requireNotStarted(current, ORDER_IS_FROZEN)
        const stops = await pickupsOfRoute(tx, principal.companyId, current.id)
        requireOpenStops(body.pickupIds, stops, current)
        if (leavesNoStop(body.pickupIds, stops.map(asMoving))) throw invalidRequest("body", [{ path: "pickupIds", message: splitLeavesNone(labelOf(current)) }])
        const at = now()
        const scope: Scope = { companyId: principal.companyId, projectId: current.projectId }
        const made = await createAdHocRoute(
          tx,
          principal,
          scope,
          {
            operatingDate: current.operatingDate,
            plannedVehicleId: body.vehicleId ?? null,
            plannedDriverId: body.driverId ?? null,
            depotId: current.depotId,
            unloadingStationId: current.unloadingStationId,
            note: body.note ?? null,
            plannedStartTime: current.plannedStartTime,
            plannedServiceProviderId: current.plannedServiceProviderId,
            acceptSameDay: body.acceptSameDay === true,
          },
          at,
          { endsKnown: true },
        )
        const order = movingInOrder(body.pickupIds, stops.map(asMoving)).map((stop) => stops.find((row) => row.id === stop.id) as PickupRow)
        await moveStops(tx, principal, current, made, order, at)
        return created(c, "/routes", await detailOf(tx, principal.companyId, (await findRoute(tx, principal, made.id)) ?? made))
      },
    )
    .post(
      "/routes/:id/merge",
      describeRoute({
        operationId: "mergeRoutes",
        summary: "Merge another route into this one",
        description: `Merges the route \`routeId\` names, of the same project (400 at \`routeId\` for this route itself or any other), into this one (O23 of #290): every open stop of it moves onto this route, and it is then cancelled as \`POST /routes/{id}/cancel\` cancels one, with the reason code \`merged\` and the reason \`Merged into route RC-1042\` — \`route-cancelled\` written, a hold cleared, generation never bringing back a route the office cancelled. A route with no open stop is cancelled all the same. ${STATES} ${MOVE}`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("This route, as it now stands with the stops merged onto it.", RouteDetail),
          400: describeProblem("The path does not hold an id, or the body names no route, a member the command does not take, or no other route of this route's project."),
          ...problems(`\`edit\` on \`${ROUTES}\` and on \`${PICKUPS}\``),
          409: describeProblem("A route is active, completed or cancelled, or a stop is refused here; the detail says which."),
        },
      }),
      guard,
      requireGrant(ROUTES, "edit"),
      requireGrant(PICKUPS, "edit"),
      validate("param", IdParam),
      validate("json", RouteMerge),
      async (c) => {
        const { id } = c.req.valid("param")
        const { routeId } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { current, other } = await lockedPair(tx, principal, id, routeId)
        requireNotStarted(current, ORDER_IS_FROZEN)
        const merged = requireOther(current, routeId, other, "routeId")
        requireNotStarted(merged, ORDER_IS_FROZEN)
        const transition = routeTransition(merged.status as RouteStatus, "cancel", labelOf(merged))
        // A route that has not started is cancelled by its machine; a stay or a refusal here is a bug in the machine, not the client's.
        if (transition.kind !== "move") throw new Error(`route ${merged.id} is ${merged.status} and its cancel did not move`)
        const at = now()
        const stops = await pickupsOfRoute(tx, principal.companyId, merged.id)
        const order = openStopsInOrder(stops.map(asMoving)).map((stop) => stops.find((row) => row.id === stop.id) as PickupRow)
        await moveStops(tx, principal, merged, current, order, at)
        const lockedMerged = (await findRoute(tx, principal, merged.id)) ?? merged
        await cancelLockedRoute(tx, principal, lockedMerged, transition.to, { reasonCode: "merged", reason: mergedInto(labelOf(current)) }, at)
        return c.json(await detailOf(tx, principal.companyId, (await findRoute(tx, principal, current.id)) ?? current))
      },
    )
}
