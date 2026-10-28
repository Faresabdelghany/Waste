// A route's workload (O10 of #290), as the route's list and its details
// answer it: its stops' seconds at the kerb and their expected kilograms,
// against its planned vehicle's payload. The rules are the domain's
// (`routeWorkload`, @waste/domain/execution/workload); this is the read. Its
// stops are read grouped by what the rules look at — the route, the service,
// the status, the container type's litres and seconds, the fraction's density
// — and counted, so a page of routes is one statement over its stops however
// many there are, and one over its planned vehicles. The routes are those a
// fenced read already found, as `activePlansByRoute` reads their Plans.
//
// Beside it, the route's day against its planned driver's shift (O14 of
// #290), the over-shift verdict (`routeShift`, @waste/domain/execution/shift):
// the planned start, the active Plan's drive and the waiting its windows
// made, the stop time above, the unload visits the Plan makes on the way
// (O15) and the break, against the shift. A page's is three statements more,
// over its drivers, its active Plans and their unload visits.
import type { RouteShift, RouteWorkload } from "@waste/contracts/routes"
import type { Tx } from "@waste/db/client"
import { shiftColumns, shiftOf } from "@waste/db/commands/stop-timing"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { pickup } from "@waste/db/schema/execution"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { plan, planStop } from "@waste/db/schema/routing"
import { routeShift } from "@waste/domain/execution/shift"
import { routeWorkload, type WorkloadStop } from "@waste/domain/execution/workload"
import type { PickupService, PickupStatus } from "@waste/domain/execution/vocabulary"
import { and, count, eq, inArray } from "drizzle-orm"

/** Each route's workload, by its id: every route named answers one, a route without stops a workload of nothing. */
export async function workloadsByRoute(tx: Tx, companyId: string, routes: readonly { id: string; plannedVehicleId: string | null }[]): Promise<Map<string, RouteWorkload>> {
  if (routes.length === 0) return new Map()
  const vehicleIds = [...new Set(routes.flatMap((row) => (row.plannedVehicleId === null ? [] : [row.plannedVehicleId])))]
  const [groups, vehicles] = await Promise.all([
    tx
      .select({
        routeId: pickup.routeId,
        service: pickup.service,
        status: pickup.status,
        volumeLitres: containerType.volumeLitres,
        containerServiceSeconds: containerType.serviceSeconds,
        densityKgPerCubicMetre: wasteFraction.densityKgPerCubicMetre,
        stops: count(),
      })
      .from(pickup)
      .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
      .leftJoin(containerType, and(eq(containerType.companyId, container.companyId), eq(containerType.id, container.containerTypeId)))
      .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, pickup.companyId), eq(wasteFraction.id, pickup.wasteFractionId)))
      .where(
        and(
          eq(pickup.companyId, companyId),
          inArray(
            pickup.routeId,
            routes.map((row) => row.id),
          ),
        ),
      )
      .groupBy(pickup.routeId, pickup.service, pickup.status, containerType.volumeLitres, containerType.serviceSeconds, wasteFraction.densityKgPerCubicMetre),
    vehicleIds.length === 0
      ? []
      : tx
          .select({ id: vehicle.id, capacityKg: vehicle.capacityKg })
          .from(vehicle)
          .where(and(eq(vehicle.companyId, companyId), inArray(vehicle.id, vehicleIds))),
  ])
  // Each group is as many stops alike as it counts: the rules multiply, so nothing is spread back out.
  const stopsByRoute = new Map<string, WorkloadStop[]>()
  for (const group of groups) {
    const stops = stopsByRoute.get(group.routeId) ?? []
    stops.push({
      service: group.service as PickupService,
      status: group.status as PickupStatus,
      volumeLitres: group.volumeLitres,
      densityKgPerCubicMetre: group.densityKgPerCubicMetre,
      containerServiceSeconds: group.containerServiceSeconds,
      count: group.stops,
    })
    stopsByRoute.set(group.routeId, stops)
  }
  const capacity = new Map(vehicles.map((row) => [row.id, row.capacityKg]))
  return new Map(routes.map((row) => [row.id, routeWorkload(stopsByRoute.get(row.id) ?? [], row.plannedVehicleId === null ? null : (capacity.get(row.plannedVehicleId) ?? null))]))
}

/** The workload of a route a read found without stops to weigh: what a map lookup answers for a route it was never asked about. */
export const NO_WORKLOAD: RouteWorkload = routeWorkload([], null)

/** Each route's day against its planned driver's shift, by its id: every route named answers one, read beside its workload (`workloadsByRoute`). */
export async function shiftsByRoute(
  tx: Tx,
  companyId: string,
  routes: readonly { id: string; plannedDriverId: string | null; plannedStartTime: string | null; activePlanId: string | null }[],
  workloads: ReadonlyMap<string, RouteWorkload>,
): Promise<Map<string, RouteShift>> {
  if (routes.length === 0) return new Map()
  const driverIds = [...new Set(routes.flatMap((row) => (row.plannedDriverId === null ? [] : [row.plannedDriverId])))]
  const planIds = routes.flatMap((row) => (row.activePlanId === null ? [] : [row.activePlanId]))
  const [drivers, plans, unloads] = await Promise.all([
    driverIds.length === 0
      ? []
      : tx
          .select({ id: driver.id, ...shiftColumns })
          .from(driver)
          .where(and(eq(driver.companyId, companyId), inArray(driver.id, driverIds))),
    planIds.length === 0
      ? []
      : tx
          .select({ id: plan.id, durationSeconds: plan.durationSeconds, waitingSeconds: plan.waitingSeconds })
          .from(plan)
          .where(and(eq(plan.companyId, companyId), inArray(plan.id, planIds))),
    planIds.length === 0
      ? []
      : tx
          .select({ planId: planStop.planId, visits: count() })
          .from(planStop)
          .where(and(eq(planStop.companyId, companyId), inArray(planStop.planId, planIds), eq(planStop.kind, "unload")))
          .groupBy(planStop.planId),
  ])
  const visits = new Map(unloads.map((row) => [row.planId, row.visits]))
  const shifts = new Map(drivers.map((row) => [row.id, shiftOf(row)]))
  const measured = new Map(plans.map((row) => [row.id, row]))
  return new Map(
    routes.map((row) => {
      const active = row.activePlanId === null ? undefined : measured.get(row.activePlanId)
      return [
        row.id,
        routeShift({
          shift: row.plannedDriverId === null ? null : (shifts.get(row.plannedDriverId) ?? null),
          plannedStartTime: row.plannedStartTime,
          driveSeconds: active?.durationSeconds ?? null,
          waitingSeconds: active?.waitingSeconds ?? null,
          stopSeconds: (workloads.get(row.id) ?? NO_WORKLOAD).stopSeconds,
          unloads: active === undefined ? 0 : (visits.get(active.id) ?? 0),
        }),
      ]
    }),
  )
}

/** The day of a route a read found without a shift to judge: what a map lookup answers for a route it was never asked about. */
export const NO_SHIFT: RouteShift = { shift: null, startsAt: null, workSeconds: null, overShiftSeconds: null }
