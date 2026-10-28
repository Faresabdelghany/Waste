// A Route Scheme's lifecycle (O21 of #290): `POST /route-schemes/:id/archive`,
// the scheme's delete, and `POST /route-schemes/:id/successor`, the next
// version of its name. Both end the scheme from a day, and what ending does
// to its routes is @waste/domain/planning/lifecycle's.
//
// Archive erases nothing. A scheme that ever generated a route has run
// collections whose stops, proofs, tickets and billable events name it, so it
// is never deleted: the archive stamps `archived_at`, turns Plan Ahead off
// (`route_scheme_archived_shape` holds the pair) and cuts the period at the
// effective day, `effectiveFrom`, the first day the scheme no longer runs —
// tomorrow on the project's clock when the body names none, and never
// sooner, since today's routes are operating. A scheme that would not have
// started by then is cut nowhere, as a period cannot end on or before the day
// it starts; it goes back to `draft` instead, which plans nothing, so neither
// the nightly sweep, the office's Generate nor the public collection days
// read it again. Its groups and seasons stay with it, as the history of what
// it planned. From then on the scheme refuses every write — its patch, its
// groups' routes, a Generate, a successor — in one sentence (409,
// `requireNotArchived`), and reads as it stands, `archivedAt` saying when.
//
// A successor is a new scheme of the same name from `validFrom`, the day the
// predecessor gives way. One transaction: the predecessor's period is cut at
// that day, which frees the name for the database's one-in-force rule
// (`route_scheme_no_overlap`), and the new version is written from the
// predecessor as it is read — its recurrence, holiday and edit policies,
// Plan Ahead and its window, status, ends, every group with its rule or its
// picked containers and its crew, and its seasons — to the end the
// predecessor had, through `writeScheme`, so it is held to every rule a
// create is: a crew away or retired on the new start is refused there as it
// would be on a create. The day lies after the predecessor's start, before
// its end, and tomorrow at the earliest; an archived predecessor has no next
// version. The new version starts with no runs and no routes: its first
// Generate, or the nightly sweep, plans it.
//
// The routes from the day go in the same transaction, never through a queued
// generation run: the generate queue holds one job per scheme, so a send
// beside a Plan Ahead run would answer null and the cancel would never come.
// The rule is generation's own (planning/generation.ts, the worker's
// generate-routes.ts): the scheme's routes from the day are read under their
// row locks in id order, the order a run and a bulk dispatch lock them in; a
// `planned` route is cancelled by generation — status, `cancelled_by_generation`,
// the `regeneration` reason code, the sentence as its note, its hold cleared —
// and its open stops skipped `regeneration`; a planned route carrying an open
// stop the office added (#111, a stop moved onto it by O23 among them) is
// trimmed: the scheme's own open stops skipped, the office's left standing,
// the route left planned. A moved stop keeps `moved_from_pickup_id`, so
// Finance still bills it once as its chain's first stop. No outbox event is
// written, as a run writes none for its cleanup. A `ready` or `active` route
// is left as it stands and counted in the answer, for the office to cancel by
// hand; a completed or cancelled one is history already.
//
// The grant is `route-studio.schemes`: `delete` to archive, `create` for a
// successor. Both take the scheme's row lock first, as a patch does, so an
// edit or a generation run in flight is waited for.
import { RouteSchemeArchive, RouteSchemeArchived, RouteSchemeSuccession, RouteSchemeSuccessorCreate, type RouteScheme, type RouteSchemeCreate, type SchemeEndingCounts } from "@waste/contracts/route-schemes"
import type { Tx } from "@waste/db/client"
import { pickup, route } from "@waste/db/schema/execution"
import { routeScheme } from "@waste/db/schema/route-schemes"
import { REGENERATION_CANCEL, type RouteStatus } from "@waste/domain/execution/vocabulary"
import { firstEndingDay, routesEndedFrom, SCHEME_ARCHIVED_NOTE, supersededNote } from "@waste/domain/planning/lifecycle"
import { and, asc, eq, gte, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { describeProblem, invalidRequest, validate } from "../problem"
import { projectToday } from "./fleet-lookups"
import { writeScheme } from "./route-schemes"
import { findScheme, MODULE, noSuchScheme, requireNotArchived, schemeColumns, schemeScope, schemeWithGroups, type ClockOptions, type SchemeRow } from "./scheme-groups"
import { describeCreated, describeJson, IdParam, lockRow, stamp } from "./shared"

/** What an effective day before tomorrow is refused with, at its field. */
export const endsTomorrowAtTheEarliest = (tomorrow: string): string => `Today's routes are operating: the scheme can end from ${tomorrow} at the earliest`

/** What a successor's day outside the predecessor's period is refused with, at `validFrom`. */
export const successorStartsInside = (scheme: { validFrom: string; validTo: string | null }): string =>
  scheme.validTo === null ? `The next version starts after this one does, on ${scheme.validFrom}` : `The next version starts after this one does, on ${scheme.validFrom}, and before it ends, on ${scheme.validTo}`

/**
 * Ends the scheme's routes from `from`: each planned one cancelled or
 * trimmed as the domain decides, the dispatched and running ones counted.
 * Under the routes' row locks, in id order.
 */
export async function endSchemeRoutes(tx: Tx, companyId: string, schemeId: string, from: string, note: string, at: Date): Promise<SchemeEndingCounts> {
  const routes = await tx
    .select({ id: route.id, collectionGroupId: route.collectionGroupId, serviceDate: route.serviceDate, operatingDate: route.operatingDate, status: route.status, cancelledByGeneration: route.cancelledByGeneration, heldAt: route.heldAt })
    .from(route)
    .where(and(eq(route.companyId, companyId), eq(route.routeSchemeId, schemeId), gte(route.serviceDate, from)))
    .orderBy(asc(route.id))
    .for("update")
  const plannedIds = routes.filter((row) => row.status === "planned").map((row) => row.id)
  // The planned routes' open stops, the office's among them: which routes carry one decides cancel or trim.
  const open =
    plannedIds.length === 0
      ? []
      : await tx
          .select({ id: pickup.id, routeId: pickup.routeId, origin: pickup.origin })
          .from(pickup)
          .where(and(eq(pickup.companyId, companyId), inArray(pickup.routeId, plannedIds), eq(pickup.status, "planned")))
  const officeStops = new Set(open.filter((row) => row.origin === "office").map((row) => row.routeId))
  const ending = routesEndedFrom(
    routes.map((row) => ({
      id: row.id,
      // A scheme's route always carries its group (`route_scheme_shape`); only the office's ad-hoc route has none, and it has no scheme.
      collectionGroupId: row.collectionGroupId ?? "",
      serviceDate: row.serviceDate,
      operatingDate: row.operatingDate,
      status: row.status as RouteStatus,
      cancelledByGeneration: row.cancelledByGeneration,
      held: row.heldAt !== null,
      officeStops: officeStops.has(row.id),
    })),
    from,
    note,
  )

  const cancelled = ending.decisions.filter((decision) => decision.kind === "cancel").map((decision) => decision.routeId)
  const trimmed = ending.decisions.filter((decision) => decision.kind === "trim").map((decision) => decision.routeId)
  if (cancelled.length > 0) {
    await tx
      .update(route)
      .set({ status: "cancelled", cancelledAt: at, cancelledByGeneration: true, cancelReasonCode: REGENERATION_CANCEL, note, heldAt: null })
      .where(and(eq(route.companyId, companyId), inArray(route.id, cancelled)))
  }
  if (trimmed.length > 0) await tx.update(route).set({ note }).where(and(eq(route.companyId, companyId), inArray(route.id, trimmed)))
  // A cancelled route's every open stop, a trimmed one's own: the office's stops on a trimmed route stand.
  const cancelledSet = new Set(cancelled)
  const trimmedSet = new Set(trimmed)
  const skipped = open.filter((row) => cancelledSet.has(row.routeId) || (trimmedSet.has(row.routeId) && row.origin === "generation")).map((row) => row.id)
  if (skipped.length > 0) {
    await tx.update(pickup).set({ status: "skipped", reason: "regeneration", note, outcomeAt: at }).where(and(eq(pickup.companyId, companyId), inArray(pickup.id, skipped)))
  }
  return { cancelled: cancelled.length, trimmed: trimmed.length, kept: ending.kept }
}

/** The scheme the path names, locked and read again under the lock, refused when it is not here or is archived. */
async function lockedScheme(tx: Tx, principal: Principal, id: string): Promise<SchemeRow> {
  await lockRow(tx, routeScheme, { companyId: principal.companyId, id })
  const current = await findScheme(tx, principal, id)
  if (current === undefined) throw noSuchScheme(id)
  requireNotArchived(current)
  return current
}

/** The predecessor as the create body its next version is written from: the whole scheme as it reads, from `validFrom` to the end it had. */
function successorBody(predecessor: RouteScheme, validFrom: string): RouteSchemeCreate {
  return {
    projectId: predecessor.projectId,
    name: predecessor.name,
    planningAreaId: predecessor.planningAreaId,
    serviceType: predecessor.serviceType,
    frequency: predecessor.frequency,
    serviceDays: predecessor.serviceDays,
    weekRotation: predecessor.weekRotation,
    plannedStartTime: predecessor.plannedStartTime,
    holidayPolicy: predecessor.holidayPolicy,
    editPolicy: predecessor.editPolicy,
    planAhead: predecessor.planAhead,
    planAheadDays: predecessor.planAheadDays,
    status: predecessor.status,
    depotId: predecessor.depotId,
    unloadingStationId: predecessor.unloadingStationId,
    collectionGroups: predecessor.collectionGroups.map((group) => ({
      name: group.name,
      position: group.position,
      days: group.days,
      stopSource: group.stopSource,
      rule: group.rule,
      containerIds: group.stopSource === "manual" ? group.containerIds : null,
      serviceProviderId: group.serviceProviderId,
      vehicleId: group.vehicleId,
      driverId: group.driverId,
    })),
    seasons: predecessor.seasons,
    validFrom,
    ...(predecessor.validTo === null ? {} : { validTo: predecessor.validTo }),
  }
}

export function schemeLifecycleRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .post(
      "/route-schemes/:id/archive",
      describeRoute({
        operationId: "archiveRouteScheme",
        summary: "Archive a route scheme: its delete, which erases nothing",
        description:
          "Archives one route scheme of a project the caller works in, under its row lock. `effectiveFrom` is the first day the scheme no longer runs: tomorrow on the project's clock when absent, and never sooner, since today's routes are operating. The scheme's period is cut at that day — or, for a scheme that would not have started by then, left as it is and the scheme put back to `draft`, which plans nothing — Plan Ahead is turned off and `archivedAt` stamped. Nothing is erased: the groups, the seasons and every route the scheme generated stay. In the same transaction its routes with a service date on or after the day are ended as a generation run ends a shortened scheme's: a `planned` route is cancelled by generation with the `regeneration` reason code and the sentence `Route scheme archived — future planning stopped`, its hold cleared and its open stops skipped; one carrying an open stop the office added — a stop moved onto it among them — is trimmed instead, the scheme's own open stops skipped and the office's left standing on the planned route. A `ready` or `active` route is left as it stands and counted as `kept`, for the office to cancel by hand; a completed or cancelled one is history already. No event is written. From then on the scheme refuses its patch, its groups' writes, a Generate and a successor (409), and reads with `archivedAt` set.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The scheme as it now stands, and what became of its routes from the day.", RouteSchemeArchived),
          400: describeProblem("The path does not hold an id, the body names a member it does not have, or `effectiveFrom` is not a calendar day or comes before tomorrow on the project's clock."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `delete` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
          409: describeProblem("The scheme is archived already."),
        },
      }),
      guard,
      requireGrant(MODULE, "delete"),
      validate("param", IdParam),
      validate("json", RouteSchemeArchive),
      async (c) => {
        const { id } = c.req.valid("param")
        const { effectiveFrom: asked } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedScheme(tx, principal, id)
        const tomorrow = firstEndingDay(await projectToday(tx, { companyId: principal.companyId, projectId: current.projectId }, now)())
        const effectiveFrom = asked ?? tomorrow
        if (effectiveFrom < tomorrow) throw invalidRequest("body", [{ path: "effectiveFrom", message: endsTomorrowAtTheEarliest(tomorrow) }])

        const at = now()
        // Cut where the scheme would still run on the day; one that would not have started by then cannot end before it starts, and plans nothing as a draft.
        const runsOn = effectiveFrom > current.validFrom
        const cut = runsOn && (current.validTo === null || current.validTo > effectiveFrom)
        const [row] = await tx
          .update(routeScheme)
          .set({ archivedAt: at, planAhead: false, ...(cut ? { validTo: effectiveFrom } : {}), ...(runsOn ? {} : { status: "draft" }), ...stamp() })
          .where(and(schemeScope(principal), eq(routeScheme.id, id)))
          .returning(schemeColumns)
        const routes = await endSchemeRoutes(tx, principal.companyId, id, effectiveFrom, SCHEME_ARCHIVED_NOTE, at)
        return c.json({ scheme: await schemeWithGroups(tx, principal.companyId, row, now), routes })
      },
    )
    .post(
      "/route-schemes/:id/successor",
      describeRoute({
        operationId: "createRouteSchemeSuccessor",
        summary: "Write the next version of a route scheme, from a day",
        description:
          "Writes the next version of one route scheme of a project the caller works in: a new scheme of the same name, in force from `validFrom` to the end the predecessor had, and the predecessor's period cut at `validFrom`, in one transaction under the predecessor's row lock. The new version is the predecessor as it reads — its recurrence, holiday and edit policies, Plan Ahead and its window, status, planning area, depot and station, every collection group with its rule or its picked containers, provider, vehicle and driver, and its seasons — written as `POST /route-schemes` writes a scheme and held to every rule a create is held to, so a crew retired, suspended or away on the new start, or a validated scheme that no longer holds together, is refused as a create would refuse it; edit it afterwards like any scheme. `validFrom` comes after the predecessor's start, before its end, and on tomorrow on the project's clock at the earliest. The predecessor's routes with a service date on or after `validFrom` are ended as an archive ends them — a planned route cancelled by generation with the sentence `Superseded by the scheme's next version from <day>`, or trimmed where it carries an open stop the office added, a `ready` or `active` one kept and counted — and the new version has no runs and no routes until its first Generate or the nightly sweep plans it. `Location` names the new version.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The predecessor as it now stands, the new version, and what became of the predecessor's routes from the day; `Location` names the new version.", RouteSchemeSuccession),
          400: describeProblem("The path does not hold an id, the body is missing `validFrom` or names a member it does not have, `validFrom` is not a calendar day, comes before tomorrow on the project's clock, or lies outside the predecessor's period, or a group's driver may not take its vehicle on the new start."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `route-studio.schemes`."),
          404: describeProblem("No route scheme with that id in the projects this account works in."),
          409: describeProblem("The scheme is archived, a group's vehicle or driver is retired, suspended, inactive or away on the new start, or the scheme is validated and the new version would not hold together: the detail says which."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", RouteSchemeSuccessorCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const { validFrom } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const current = await lockedScheme(tx, principal, id)
        const tomorrow = firstEndingDay(await projectToday(tx, { companyId: principal.companyId, projectId: current.projectId }, now)())
        if (validFrom < tomorrow) throw invalidRequest("body", [{ path: "validFrom", message: endsTomorrowAtTheEarliest(tomorrow) }])
        if (validFrom <= current.validFrom || (current.validTo !== null && validFrom >= current.validTo)) throw invalidRequest("body", [{ path: "validFrom", message: successorStartsInside(current) }])

        // The predecessor as it reads, before the cut: what the next version is written from.
        const before = await schemeWithGroups(tx, principal.companyId, current, now)
        const [row] = await tx
          .update(routeScheme)
          .set({ validTo: validFrom, ...stamp() })
          .where(and(schemeScope(principal), eq(routeScheme.id, id)))
          .returning(schemeColumns)
        const successor = await writeScheme(tx, principal, successorBody(before, validFrom), now)
        const routes = await endSchemeRoutes(tx, principal.companyId, id, validFrom, supersededNote(validFrom), now())
        const answer: RouteSchemeSuccession = { predecessor: await schemeWithGroups(tx, principal.companyId, row, now), successor, routes }
        return c.json(answer, 201, { location: `/route-schemes/${successor.id}` })
      },
    )
}
