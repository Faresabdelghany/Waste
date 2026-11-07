// The fill-driven emptying (O26 of #290, row 9.10): the worker's
// `fill-threshold` rule, raising an alert for a container whose pairing books
// an emptying, books the office's emptying of it ahead of its next scheduled
// one, in the same transaction as the alert. Which route is the domain's
// (`fillEmptyingRoute`, @waste/domain/execution/fill-emptying); this module
// reads what the choice needs and adds the office's emptying as every door
// adds an office stop (`addOfficeStop`), at the container's placement in
// force on the route's service date. Generation never moves or skips an
// office stop, and an office emptying on a route generation has no stop of
// the container stands for the round's emptying of it there; an emptying the
// office has planned for the container on the route already, from an earlier
// filling or a person, is this one.
//
// A refusal — the route started meanwhile, the container placed nowhere that
// day, the vehicle unable to take it — books nothing and is the alert's
// words, never the job's failure.
import { routeLabel } from "@waste/domain/numbering"
import { fillEmptyingRoute, type EmptyingRoute, type FillEmptyingOutcome } from "@waste/domain/execution/fill-emptying"
import { orderIsOpen } from "@waste/domain/execution/transitions"
import { NOT_STARTED_ROUTE_STATUSES } from "@waste/domain/execution/vocabulary"
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm"

import type { Tx } from "../client"
import { placementInForce } from "../query/placement-in-force"
import { pickup, route } from "../schema/execution"
import { addOfficeStop } from "./office-stops"
import { lockRow } from "./shared"

const routeColumns = {
  id: route.id,
  number: route.number,
  operatingDate: route.operatingDate,
  routeSchemeId: route.routeSchemeId,
  collectionGroupId: route.collectionGroupId,
}
const emptyingRouteOf = (row: { id: string; number: number; operatingDate: string; routeSchemeId: string | null; collectionGroupId: string | null }): EmptyingRoute => ({
  id: row.id,
  label: routeLabel(row.number),
  operatingDate: row.operatingDate,
  routeSchemeId: row.routeSchemeId,
  collectionGroupId: row.collectionGroupId,
})

/** What the stop says to the driver: why it is there. */
export const fillEmptyingNote = (sensorIdentifier: string, fillPercent: number, measuredAt: string): string =>
  `Emptying brought forward: sensor ${sensorIdentifier} read ${fillPercent}% at ${measuredAt}.`

/**
 * Books the fill-driven emptying of a container in the caller's transaction,
 * under `withCompany`, and answers what it came to. `today` is the project's
 * day; `note` the stop's words.
 */
export async function bookFillEmptying(tx: Tx, scope: { companyId: string; projectId: string }, containerId: string, today: string, note: string): Promise<FillEmptyingOutcome> {
  const { companyId, projectId } = scope
  // The container's next emptying of generation's, still planned on a route that has not started.
  const [next] = await tx
    .select(routeColumns)
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(
      and(
        eq(pickup.companyId, companyId),
        eq(pickup.projectId, projectId),
        eq(pickup.containerId, containerId),
        eq(pickup.origin, "generation"),
        eq(pickup.service, "empty"),
        eq(pickup.status, "planned"),
        inArray(route.status, [...NOT_STARTED_ROUTE_STATUSES]),
        gte(route.operatingDate, today),
      ),
    )
    .orderBy(asc(route.operatingDate), asc(route.id))
    .limit(1)
  const nextRoute = next === undefined ? null : emptyingRouteOf(next)
  const candidates =
    nextRoute === null || nextRoute.routeSchemeId === null || nextRoute.collectionGroupId === null
      ? []
      : await tx
          .select(routeColumns)
          .from(route)
          .where(
            and(
              eq(route.companyId, companyId),
              eq(route.projectId, projectId),
              eq(route.routeSchemeId, nextRoute.routeSchemeId),
              eq(route.collectionGroupId, nextRoute.collectionGroupId),
              inArray(route.status, [...NOT_STARTED_ROUTE_STATUSES]),
              gte(route.operatingDate, today),
              lt(route.operatingDate, nextRoute.operatingDate),
            ),
          )
  const choice = fillEmptyingRoute(nextRoute, candidates.map(emptyingRouteOf), today)
  if (choice.kind !== "book") return choice
  const chosen = choice.route

  await lockRow(tx, route, { companyId, id: chosen.id })
  const [locked] = await tx
    .select({ status: route.status, serviceDate: route.serviceDate, plannedVehicleId: route.plannedVehicleId })
    .from(route)
    .where(and(eq(route.companyId, companyId), eq(route.id, chosen.id)))
    .limit(1)
  if (locked === undefined || !orderIsOpen(locked.status)) return { kind: "refused", route: chosen, reason: "the route has started" }
  const place = await placementInForce(tx, scope, containerId, locked.serviceDate)
  if (place === undefined) return { kind: "refused", route: chosen, reason: "the container has no placement in force on the route's service date" }
  const added = await addOfficeStop(tx, companyId, { id: chosen.id, projectId, plannedVehicleId: locked.plannedVehicleId }, { service: "empty", containerId, ...place, note })
  if (added.kind === "misfit") return { kind: "refused", route: chosen, reason: added.sentence }
  return { kind: "booked", route: chosen }
}
