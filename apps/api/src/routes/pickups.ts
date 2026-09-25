// The Pickup as the dispatcher reads and corrects it (Issue #104, slice 3):
// `GET /pickups` lists them across routes, `GET /pickups/:id` reads one with
// its proofs in recording order, and two commands move one — `remove`, a stop
// taken off a route that has not started, and `correct-outcome`, the audited
// change of an outcome the driver recorded. A pickup is written by
// generation and by commands, never by a form (contracts/pickups.ts), and
// never deleted: a stop removed is `skipped · removed-by-dispatcher`, and
// the address it named is still in the route's record.
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
// same shape as payload (outbox.ts). Every statement carries the tenant and
// `inProjects`; the grant is `route-studio.pickups`, `view` to read and
// `edit` to command.
import { Page } from "@waste/contracts/pagination"
import { Pickup, PickupCorrection, PickupDetail, PickupListQuery, PickupRemove } from "@waste/contracts/pickups"
import type { Tx } from "@waste/db/client"
import { pickup, proofOfService, route } from "@waste/db/schema/execution"
import { doesNotChange, hasNotRun, pickupCorrection, pickupTransition } from "@waste/domain/execution/transitions"
import type { PickupStatus } from "@waste/domain/execution/vocabulary"
import { and, asc, eq, gt, gte, lte } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { findRoute, labelOf, noSuchPickup, pickupColumns, pickupOf, pickupScope, proofOf, proofsOfPickup, type PickupRow, type RouteRow } from "./execution-shapes"
import { requireRoute } from "./references"
import { requireNotStarted } from "./routes"
import type { ClockOptions } from "./scheme-groups"
import { describeJson, IdParam, lockRow } from "./shared"

const MODULE = "route-studio.pickups"

const PickupPage = Page(Pickup)

/** What removing a stop from a route that runs is told (the domain's `activeAnd`): the stop is the driver's now. */
const A_STOP_IS_THE_DRIVERS = "a stop is skipped by the driver"

/** One pickup of this company by id, inside the caller's projects; undefined when it is neither. */
async function findPickup(tx: Tx, principal: Principal, id: string): Promise<PickupRow | undefined> {
  const [row] = await tx
    .select(pickupColumns)
    .from(pickup)
    .where(and(pickupScope(principal), eq(pickup.id, id)))
    .limit(1)
  return row
}

/** The pickup with its proofs in recording order: what the read and both commands answer. */
async function detailOf(tx: Tx, companyId: string, row: PickupRow): Promise<PickupDetail> {
  return { ...pickupOf(row), proofs: (await proofsOfPickup(tx, companyId, row.id)).map(proofOf) }
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

/** A correction is made on a route that ran: `active` or `completed`; a route that has not is refused, and a cancelled one does not change. */
function requireRan(parent: RouteRow): void {
  const label = labelOf(parent)
  switch (parent.status) {
    case "active":
    case "completed":
      return
    case "planned":
    case "ready":
      throw problem(409, { detail: hasNotRun(label) })
    case "cancelled":
      throw problem(409, { detail: doesNotChange(label, "cancelled") })
    default:
      throw new Error(`route ${parent.id} carries a status the vocabulary does not know: ${parent.status}`)
  }
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
          "One page of pickups, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `routeId` is one route's stops, and must be a route of a project this account works in (400 on the query); `containerId` a container's history of stops, `status` one of the four, `propertyId` the stops at one service address, and `from` and `to` the stops of routes operating over a window of days (both inclusive, `to` on or after `from`). Each pickup's proofs are `GET /pickups/{id}`. Hand `nextCursor` back as `cursor` for the next page.",
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
        return c.json(pageOf(rows.map(pickupOf), limit))
      },
    )
    .get(
      "/pickups/:id",
      describeRoute({
        operationId: "getPickup",
        summary: "One pickup with its proofs",
        description:
          "One pickup of a project the caller works in, with its Proofs of Service in recording order — the driver's events and evidence, and any correction the office appended. A pickup of another company, or of a project this account does not work in, is a pickup that does not exist here.",
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
        return c.json(await detailOf(tx, principal.companyId, row))
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
        if (transition.kind !== "move") throw problem(409, { detail: transition.kind === "refuse" ? transition.sentence : `Pickup ${current.position} is already skipped` })
        const at = now()
        const [row] = await tx
          .update(pickup)
          .set({ status: transition.to, reason: "removed-by-dispatcher", note: reason, outcomeAt: at })
          .where(and(pickupScope(principal), eq(pickup.id, id)))
          .returning(pickupColumns)
        if (row === undefined) throw noSuchPickup(id)
        const detail = await detailOf(tx, principal.companyId, row)
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
        const detail = await detailOf(tx, principal.companyId, row)
        await emit(tx, principal, { aggregate: "pickup", aggregateId: row.id, kind: "pickup-corrected", payload: detail, projectId: row.projectId, occurredAt: at })
        return c.json(detail)
      },
    )
}
