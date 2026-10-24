// The Pickup as the dispatcher reads and corrects it (Issue #104, slice 3):
// `GET /pickups` lists them across routes, `GET /pickups/:id` reads one with
// its proofs in recording order, `POST /routes/:id/pickups` adds the office's
// stop to a route that has not started (#111), and two commands move one —
// `remove`, a stop taken off a route that has not started, and
// `correct-outcome`, the audited change of an outcome the driver recorded. A
// pickup is written by generation and by commands, never by a form
// (contracts/pickups.ts), and never deleted: a stop removed is `skipped ·
// removed-by-dispatcher`, and the address it named is still in the route's
// record.
//
// The office's stop (#111) is `origin = office`, which generation's refresh
// leaves where it is put, and it goes after the route's last position as the
// route stands — generation never moves it, so a later refresh that grows the
// plan may number its own stops past it, and the dispatcher's order (a
// manual Plan) is how the office puts it elsewhere; on a `ready` route the driver's
// device sees it through the sync and the driver door, and an active Plan
// that does not name it reads stale and keeps it at the end of the order
// until the next measurement. It names a container — whose placement in
// force on the route's service date, the placement, its subscription and its
// agreement each valid that day, gives the place and the fraction, the way
// generation resolves a stop — or an address of the
// route's project, a property or a shared collection point served as a
// subscription's is (routes/statuses.ts), with the fraction collected there:
// an address-only stop, with no container. Its service (O3 of #290) is an
// emptying, or a repair or a wash of a container where it stands; the office
// may name a container the route stops at already — an extra emptying of one
// generation plans, a work order beside its collection — since only
// generation's stops hold one per container (`pickup_route_id_container_id_key`,
// a unique index over them alone). The route's row lock, which generation
// takes on the routes it reads too, serialises every writer of a route's
// stops. No event is written: no consumer reads a stop's arrival, and
// Resolution and Finance hear of it at its outcome like any other, its
// service on the payload.
//
// Both commands run under the route's row lock, since the rule each holds is
// the route's: a stop is removed only while the route is `planned` or
// `ready` (once it runs, a stop is the driver's to skip — routes/routes.ts's
// `requireNotStarted`, the same rule from the stop's side), and an outcome is
// corrected only on a route that ran, `active` or `completed`. The pickup
// machine is the domain's (@waste/domain/execution/transitions): a removal
// is a `skip` of a `planned` pickup, refused for one already decided in the
// machine's words, and a correction is `pickupCorrection`, which moves a
// decided pickup to any outcome, the same one included since a correction
// may change the reason alone, and refuses a planned one, which has nothing
// to correct. The correction appends a `correction` proof — `source =
// dispatch`, the dispatcher's account, the outcome the pickup was moved to,
// the note saying why — and the original proofs stand: the ledger is never
// rewritten, and what the driver said and what the office decided are both
// on the record.
//
// A command answers the pickup with its proofs, the resource the read
// answers, and writes its outbox event in the same transaction with that
// same shape as payload (outbox.ts). Every answer, the list's included,
// carries the stop's `sequence` (#219): its place in its route's execution
// order, the one the route's detail gives it, read through plan-shapes.ts's
// `sequencesOfRoutes` — for a page, over the page's routes at once — so a
// stop a command answers keeps the number the list gave it. Every statement
// carries the tenant and `inProjects`; the grant is `route-studio.pickups`,
// `view` to read and `edit` to command.
import { Page } from "@waste/contracts/pagination"
import { PickupAdd, PickupCorrection, PickupDetail, PickupListItem, PickupListQuery, PickupRemove } from "@waste/contracts/pickups"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { pickup, proofOfService, route } from "@waste/db/schema/execution"
import { pickupCorrection, pickupTransition } from "@waste/domain/execution/transitions"
import type { OfficeStopService, PickupStatus } from "@waste/domain/execution/vocabulary"
import { and, asc, eq, gt, gte, lte, max } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { findRoute, labelOf, noSuchPickup, pickupColumns, pickupOf, pickupScope, proofOf, proofsOfPickup, routeScope, type PickupRow, type RouteRow } from "./execution-shapes"
import { sequenceIn, sequencesOfRoutes } from "./plan-shapes"
import { requireProperty, requireRoute, requireSharedCollectionPoint, requireWasteFraction, type Scope } from "./references"
import { lockedRoute, ORDER_IS_FROZEN, requireNotStarted, requireRan } from "./routes"
import type { ClockOptions } from "./scheme-groups"
import { created, describeCreated, describeJson, IdParam, lockRow, stamp } from "./shared"
import { placeOf, refuseUnservedPlace } from "./statuses"

const MODULE = "route-studio.pickups"

const PickupPage = Page(PickupListItem)

/** What removing a stop from a route that runs is told (the domain's `activeAnd`): the stop is the driver's now. */
const A_STOP_IS_THE_DRIVERS = "a stop is skipped by the driver"

/** What a body naming a container that is not the route's project's is told, at `containerId`. */
export const NOT_A_CONTAINER = "Not a container of this project"

/** What a container placed nowhere on the route's service date is told: there is no place to collect it at, and no fraction to say what it holds. */
export const notPlacedOn = (container: string): string => `Container ${container} has no placement in force on the route's service date, so no place to collect it at`


/** Where and what a stop the office adds collects: the place, one of the two, and the fraction. */
type StopPlace = { propertyId: string | null; sharedCollectionPointId: string | null; wasteFractionId: string }

/**
 * The place and the fraction of a container's stop on the route's service
 * date: the placement in force that day — the placement, its subscription and
 * its agreement each valid that day, generation's own eligibility
 * (apps/worker's stop matching) — the place the subscription names and the
 * fraction the placement holds, what generation writes a stop with. The
 * container is the project's (400 at `containerId`); a container with no such
 * placement is a 409 naming it, after the body's 400s, since the id is right
 * and the row is there.
 */
async function containerStop(tx: Tx, scope: Scope, containerId: string, serviceDate: string): Promise<{ label: string; place: StopPlace | undefined }> {
  const [found] = await tx
    .select({ label: container.label })
    .from(container)
    .where(and(eq(container.companyId, scope.companyId), eq(container.projectId, scope.projectId), eq(container.id, containerId)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "containerId", message: NOT_A_CONTAINER }])
  const [place] = await tx
    .select({ propertyId: subscription.propertyId, sharedCollectionPointId: subscription.sharedCollectionPointId, wasteFractionId: containerServicePlacement.wasteFractionId })
    .from(containerServicePlacement)
    .innerJoin(
      subscription,
      and(eq(subscription.companyId, containerServicePlacement.companyId), eq(subscription.projectId, containerServicePlacement.projectId), eq(subscription.id, containerServicePlacement.subscriptionId), validOn(subscription, serviceDate)),
    )
    .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.projectId, subscription.projectId), eq(agreement.id, subscription.agreementId), validOn(agreement, serviceDate)))
    .where(and(eq(containerServicePlacement.companyId, scope.companyId), eq(containerServicePlacement.projectId, scope.projectId), eq(containerServicePlacement.containerId, containerId), validOn(containerServicePlacement, serviceDate)))
    .limit(1)
  return { label: found.label, place }
}

/**
 * What the stop a body names collects, judged in body order: a container's
 * place and fraction on the route's service date, or the address and the
 * fraction the body gives — the 400s of the fields first, then the 409s of
 * the rows they name. The label is the container's, for the sentence the
 * same work booked twice is told; an address-only stop has none.
 */
async function stopOf(tx: Tx, scope: Scope, body: PickupAdd, serviceDate: string): Promise<{ label: string | null; at: StopPlace & { containerId: string | null } }> {
  if (body.containerId != null) {
    const { label, place } = await containerStop(tx, scope, body.containerId, serviceDate)
    if (place === undefined) throw problem(409, { detail: notPlacedOn(label) })
    return { label, at: { containerId: body.containerId, ...place } }
  }
  // The contract holds an address-only stop to one place and its fraction; a body here without the fraction is a bug in it.
  if (body.wasteFractionId == null) throw new Error("an address-only stop reached the route without its fraction")
  const propertyStatus = await requireProperty(tx, scope, body.propertyId)
  const pointStatus = await requireSharedCollectionPoint(tx, scope, body.sharedCollectionPointId)
  await requireWasteFraction(tx, scope.companyId, body.wasteFractionId)
  refuseUnservedPlace(placeOf(propertyStatus, pointStatus), "stop")
  return { label: null, at: { containerId: null, propertyId: body.propertyId ?? null, sharedCollectionPointId: body.sharedCollectionPointId ?? null, wasteFractionId: body.wasteFractionId } }
}

/** What the same work booked twice on a route is told: an office stop of the container for that service is planned there already. A double-sent Add stop meets it; a second visit is booked once the first is done or taken off. */
export const bookedAlready = (container: string, service: OfficeStopService, route: string): string =>
  `Container ${container} has a planned ${service === "empty" ? "emptying" : service} the office added to route ${route} already`

/** One pickup of this company by id, inside the caller's projects; undefined when it is neither. */
async function findPickup(tx: Tx, principal: Principal, id: string): Promise<PickupRow | undefined> {
  const [row] = await tx
    .select(pickupColumns)
    .from(pickup)
    .where(and(pickupScope(principal), eq(pickup.id, id)))
    .limit(1)
  return row
}

/** The pickup with its `sequence`, as the list carries it (#219), and its proofs in recording order: what the read and both commands answer. */
async function detailOf(tx: Tx, principal: Principal, row: PickupRow): Promise<PickupDetail> {
  const [sequences, proofs] = await Promise.all([sequencesOfRoutes(tx, principal, [row.routeId]), proofsOfPickup(tx, principal.companyId, row.id)])
  return { ...pickupOf(row), sequence: sequenceIn(sequences, row), proofs: proofs.map(proofOf) }
}

/**
 * The pickup the path names and its route, under the route's row lock: the
 * pickup is read once to learn its route, the route is locked, and both are
 * read again underneath the lock, since the first read only said which route
 * to lock (the pattern of routes/lifecycle.ts's `endPlacement`). A pickup
 * outside the caller's scope is the family's 404 either time.
 */
async function lockedPickup(tx: Tx, principal: Principal, id: string): Promise<{ current: PickupRow; parent: RouteRow }> {
  const before = await findPickup(tx, principal, id)
  if (before === undefined) throw noSuchPickup(id)
  await lockRow(tx, route, { companyId: principal.companyId, id: before.routeId })
  const current = await findPickup(tx, principal, id)
  if (current === undefined) throw noSuchPickup(id)
  const parent = await findRoute(tx, principal, current.routeId)
  // The key holds every pickup to a route of its project, and the pickup was read under the caller's scope a moment ago.
  if (parent === undefined) throw new Error(`pickup ${id} names route ${current.routeId}, which is not there`)
  return { current, parent }
}

const commandProblems = (action: "view" | "edit") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
  404: describeProblem("No pickup with that id in the projects this account works in."),
})

export function pickupRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/pickups",
      describeRoute({
        operationId: "listPickups",
        summary: "The pickups of the caller's projects",
        description:
          "One page of pickups, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `routeId` is one route's stops, and must be a route of a project this account works in (400 on the query); `containerId` a container's history of stops, `status` one of the four, `propertyId` the stops at one service address, and `from` and `to` the stops of routes operating over a window of days (both inclusive, `to` on or after `from`). Each pickup carries its `sequence` (#219), its place in its route's current execution order, the one `GET /routes/{id}` gives it: the active Plan's order where the route has one, the generated baseline's otherwise, counted over the whole route whatever the page holds; `position` stays the baseline. Each pickup's proofs are `GET /pickups/{id}`. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of pickups.", PickupPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is malformed, the window runs backwards, `projectId` is not a project this account works in, or `routeId` is not a route of one."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PickupListQuery),
      async (c) => {
        const { limit, cursor, projectId, routeId, containerId, status, propertyId, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        // The route asked about is one the caller may see: the project named, or any the caller works in — the containers list's rule for its warehouse.
        if (routeId !== undefined) await requireRoute(tx, { companyId: principal.companyId, projectId: projectId ?? projectIdsOf(principal) }, routeId, "routeId", "query")
        const rows = await tx
          .select(pickupColumns)
          .from(pickup)
          .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
          .where(
            and(
              pickupScope(principal),
              projectId === undefined ? undefined : eq(pickup.projectId, projectId),
              routeId === undefined ? undefined : eq(pickup.routeId, routeId),
              containerId === undefined ? undefined : eq(pickup.containerId, containerId),
              status === undefined ? undefined : eq(pickup.status, status),
              propertyId === undefined ? undefined : eq(pickup.propertyId, propertyId),
              from === undefined ? undefined : gte(route.operatingDate, from),
              to === undefined ? undefined : lte(route.operatingDate, to),
              after === undefined ? undefined : gt(pickup.id, after),
            ),
          )
          .orderBy(asc(pickup.id))
          .limit(fetchLimit(limit))
        // Paged first, so the row that only proves there is a next page brings no route of its own to read.
        const { items, nextCursor } = pageOf(rows, limit)
        const sequences = await sequencesOfRoutes(
          tx,
          principal,
          items.map((row) => row.routeId),
        )
        const page: PickupListItem[] = items.map((row) => ({ ...pickupOf(row), sequence: sequenceIn(sequences, row) }))
        return c.json({ items: page, nextCursor })
      },
    )
    .get(
      "/pickups/:id",
      describeRoute({
        operationId: "getPickup",
        summary: "One pickup with its proofs",
        description:
          "One pickup of a project the caller works in, with its `sequence` as `GET /pickups` carries it and its Proofs of Service in recording order — the driver's events and evidence, and any correction the office appended. A pickup of another company, or of a project this account does not work in, is a pickup that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The pickup with its proofs.", PickupDetail),
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
        const row = await findPickup(tx, principal, id)
        if (row === undefined) throw noSuchPickup(id)
        return c.json(await detailOf(tx, principal, row))
      },
    )
    .post(
      "/routes/:id/pickups",
      describeRoute({
        operationId: "addRoutePickup",
        summary: "Add a stop to a route that has not started",
        description:
          "The office's stop (#111): a `planned` pickup with `origin` office, appended after the route's last position as the route stands, on a `planned` or `ready` route — on a `ready` one the driver's device sees it through the existing reads, and an active Plan that does not name it reads stale and keeps it at the end of the order until the route is measured again. Generation never moves it, so a later refresh that grows the plan may number its own stops past it; the dispatcher's order is how it goes elsewhere. The body names a container of the route's project (400 at `containerId`), whose placement in force on the route's service date — the placement, its subscription and its agreement each valid that day, as generation judges a stop — gives the stop its place and its fraction: a container with no such placement is refused (409, `Container BIN-82014 has no placement in force on the route's service date, so no place to collect it at`), while one the route stops at already is the office's to name again — an extra emptying, or a work order beside its collection — unless the office has the same work planned for it on the route already (409, `Container BIN-82014 has a planned wash the office added to route RC-1042 already`, which a double-sent request meets) — or an address-only stop: a property or a shared collection point of the project (400 at its field) that is served as a subscription's place is, an active property or an open or restricted point (409 naming the status otherwise), with the waste fraction collected there (400 at `wasteFractionId` for one that is not this company's), and no container. The `service` (O3 of #290) is `empty` unless the body says `repair` or `wash`, each of a container (400 at `containerId` otherwise). The note is what the driver reads at the stop. Generation's refresh never skips or moves the stop; an office emptying of a container generation has no stop of stands for the plan's emptying of it, while a repair or a wash leaves generation to plan the container's emptying beside it. A route that has started is refused (409): its order is frozen; a completed or cancelled one does not change. Under the route's row lock; the route's `updatedAt` moves, since its stops are part of it on the wire. No event is written: Resolution and Finance hear of the stop at its outcome, as of any other.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The stop, planned, with its `sequence` in the route's order and no proofs yet.", PickupDetail),
          400: describeProblem("The path does not hold an id, or the body names neither a container nor an address, a container beside a place or a fraction, two places, an address without its fraction, a member the command does not take, or a container, property, shared collection point or fraction that is not the project's or the company's — each at the field that is wrong. A repair or a wash names no container (400 at `containerId`), or the service is not one the office books (400 at `service`)."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\`.`),
          404: describeProblem("No route with that id in the projects this account works in."),
          409: describeProblem("The route is active, completed or cancelled; the container has no placement on the route's service date; or the property or the point is not served; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PickupAdd),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const parent = await lockedRoute(tx, principal, id)
        requireNotStarted(parent, ORDER_IS_FROZEN)
        const scope: Scope = { companyId: principal.companyId, projectId: parent.projectId }
        const stop = await stopOf(tx, scope, body, parent.serviceDate)
        const [last] = await tx
          .select({ position: max(pickup.position) })
          .from(pickup)
          .where(and(eq(pickup.companyId, principal.companyId), eq(pickup.routeId, parent.id)))
        // The office may repeat a container on a route — an extra emptying, a work order beside its collection — but not book the same work twice while it is planned: a double-sent request meets this. Under the route's lock nobody adds one meanwhile.
        if (stop.label !== null && stop.at.containerId !== null) {
          const [booked] = await tx
            .select({ id: pickup.id })
            .from(pickup)
            .where(and(eq(pickup.companyId, principal.companyId), eq(pickup.routeId, parent.id), eq(pickup.containerId, stop.at.containerId), eq(pickup.origin, "office"), eq(pickup.service, body.service), eq(pickup.status, "planned")))
            .limit(1)
          if (booked !== undefined) throw problem(409, { detail: bookedAlready(stop.label, body.service, labelOf(parent)) })
        }
        const [row] = await tx
          .insert(pickup)
          .values({ id: newId(), ...scope, routeId: parent.id, position: (last?.position ?? 0) + 1, origin: "office", service: body.service, note: body.note ?? null, ...stop.at })
          .returning(pickupColumns)
        await tx
          .update(route)
          .set(stamp())
          .where(and(routeScope(principal), eq(route.id, parent.id)))
        return created(c, "/pickups", await detailOf(tx, principal, row))
      },
    )
    .post(
      "/pickups/:id/remove",
      describeRoute({
        operationId: "removePickup",
        summary: "Take a stop off a route that has not started",
        description:
          "The `remove` command: a `planned` pickup of a `planned` or `ready` route becomes `skipped` with the reason `removed-by-dispatcher`, the body's reason as its `note` and its `outcomeAt` stamped; the row stays, since the address it named is part of the route's record. A route that runs is refused (409): a stop is skipped by the driver then; a completed or cancelled route does not change. A pickup already decided is refused (409) in the machine's words: the first outcome stands. Under the route's row lock; the `pickup-skipped` event is written in the same transaction, carrying the pickup as answered here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The pickup, skipped, with its proofs.", PickupDetail),
          400: describeProblem("The path does not hold an id, or the body has no reason or carries a member the command does not take."),
          ...commandProblems("edit"),
          409: describeProblem("The route is active, completed or cancelled, or the pickup already has an outcome; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PickupRemove),
      async (c) => {
        const { id } = c.req.valid("param")
        const { reason } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { current, parent } = await lockedPickup(tx, principal, id)
        requireNotStarted(parent, A_STOP_IS_THE_DRIVERS)
        const transition = pickupTransition(current.status as PickupStatus, "skip", current.position)
        if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
        // A skip moves a planned pickup or refuses a decided one; the machine never answers "stay" for it, so that branch is a bug in the machine and not a client's.
        if (transition.kind !== "move") throw new Error(`a skip of pickup ${id} neither moved nor refused`)
        const at = now()
        const [row] = await tx
          .update(pickup)
          .set({ status: transition.to, reason: "removed-by-dispatcher", note: reason, outcomeAt: at })
          .where(and(pickupScope(principal), eq(pickup.id, id)))
          .returning(pickupColumns)
        if (row === undefined) throw noSuchPickup(id)
        const detail = await detailOf(tx, principal, row)
        await emit(tx, principal, { aggregate: "pickup", aggregateId: row.id, kind: "pickup-skipped", payload: detail, projectId: row.projectId, occurredAt: at })
        return c.json(detail)
      },
    )
    .post(
      "/pickups/:id/correct-outcome",
      describeRoute({
        operationId: "correctPickupOutcome",
        summary: "Correct a pickup's outcome",
        description:
          "The audited correction: on a pickup that is `completed`, `skipped` or `failed` of a route that ran (`active` or `completed`), appends a `correction` Proof of Service — `source` dispatch, the caller's account, the new `outcome`, the reason where the outcome takes one, and the `note` saying why — and moves the pickup's status, `reason` and `outcomeAt`. The original proofs stand: what the driver recorded and what the office decided are both on the record. A `reason` goes with `skipped` or `failed` and not with `completed` (400 at `reason`). A `planned` pickup has no outcome to correct (409); a route that has not run is refused (409), and a cancelled one does not change. Under the route's row lock; the `pickup-corrected` event is written in the same transaction, carrying the pickup with its proofs as answered here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The pickup as corrected, with its proofs, the correction last.", PickupDetail),
          400: describeProblem("The path does not hold an id, or the body is missing the outcome or the note, names a member the command does not take, asks for `planned`, or gives a reason with `completed` or none with `skipped` or `failed`."),
          ...commandProblems("edit"),
          409: describeProblem("The pickup is still planned, or its route has not run or is cancelled; the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PickupCorrection),
      async (c) => {
        const { id } = c.req.valid("param")
        const { outcome, reason, note } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const { current, parent } = await lockedPickup(tx, principal, id)
        requireRan(parent)
        const transition = pickupCorrection(current.status as PickupStatus, outcome, current.position)
        if (transition.kind === "refuse") throw problem(409, { detail: transition.sentence })
        if (transition.kind !== "move") throw new Error(`a correction of pickup ${id} neither moved nor refused`)
        const at = now()
        const [row] = await tx
          .update(pickup)
          .set({ status: transition.to, reason: reason ?? null, outcomeAt: at })
          .where(and(pickupScope(principal), eq(pickup.id, id)))
          .returning(pickupColumns)
        if (row === undefined) throw noSuchPickup(id)
        await tx.insert(proofOfService).values({
          id: newId(),
          companyId: principal.companyId,
          projectId: row.projectId,
          routeId: row.routeId,
          pickupId: row.id,
          sessionId: null,
          kind: "correction",
          source: "dispatch",
          occurredAt: at,
          recordedBy: principal.user.id,
          reason: reason ?? null,
          note,
          outcome,
        })
        const detail = await detailOf(tx, principal, row)
        await emit(tx, principal, { aggregate: "pickup", aggregateId: row.id, kind: "pickup-corrected", payload: detail, projectId: row.projectId, occurredAt: at })
        return c.json(detail)
      },
    )
}
