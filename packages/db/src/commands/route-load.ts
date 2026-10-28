// What a Plan's reloads read of a route (O15 of #290), the one read the API's
// fingerprint (`planKey`, ./plans.ts) and the worker's optimisation request
// (`routing.optimise`) share, so a Plan is keyed on exactly what it was asked:
// each stop's load, as the route's workload weighs it (`stopLoadKg`,
// @waste/domain/execution/workload) — its container's litres times its
// fraction's density where it loads waste — against the payload of the
// route's planned vehicle. Whether those loads send the vehicle to its station
// on the way is the domain's rule (`reloadOf`, @waste/domain/routing/reloads).
import type { PickupService } from "@waste/domain/execution/vocabulary"
import { stopLoadKg } from "@waste/domain/execution/workload"
import { reloadOf, type Reload } from "@waste/domain/routing/reloads"
import type { PlanTrip } from "@waste/domain/routing/vocabulary"
import { and, eq, inArray } from "drizzle-orm"

import type { Tx } from "../client"
import { containerType, wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { pickup } from "../schema/execution"
import { vehicle } from "../schema/fleet"

/** A route's loads: each pickup's kilograms by its id, null where its weight cannot be expected, and the planned vehicle's payload, null without one. */
export type RouteLoad = { capacityKg: number | null; kg: Map<string, number | null> }

/** The route's loads over the pickups named. */
export async function routeLoad(tx: Tx, companyId: string, routeRow: { plannedVehicleId: string | null }, pickupIds: readonly string[]): Promise<RouteLoad> {
  const [rows, [planned]] = await Promise.all([
    pickupIds.length === 0
      ? []
      : tx
          .select({ id: pickup.id, service: pickup.service, volumeLitres: containerType.volumeLitres, densityKgPerCubicMetre: wasteFraction.densityKgPerCubicMetre })
          .from(pickup)
          .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
          .leftJoin(containerType, and(eq(containerType.companyId, container.companyId), eq(containerType.id, container.containerTypeId)))
          .leftJoin(wasteFraction, and(eq(wasteFraction.companyId, pickup.companyId), eq(wasteFraction.id, pickup.wasteFractionId)))
          .where(and(eq(pickup.companyId, companyId), inArray(pickup.id, [...pickupIds]))),
    routeRow.plannedVehicleId === null
      ? []
      : tx
          .select({ capacityKg: vehicle.capacityKg })
          .from(vehicle)
          .where(and(eq(vehicle.companyId, companyId), eq(vehicle.id, routeRow.plannedVehicleId)))
          .limit(1),
  ])
  const kg = new Map(rows.map((row) => [row.id, stopLoadKg({ service: row.service as PickupService, volumeLitres: row.volumeLitres, densityKgPerCubicMetre: row.densityKgPerCubicMetre })] as const))
  return { capacityKg: planned?.capacityKg ?? null, kg }
}

/** The reload a request over these pickups, in this order, carries; null for one that tips once at the end. */
export const reloadOver = (load: RouteLoad, request: { trip: PlanTrip; pickupIds: readonly string[] }): Reload | null =>
  reloadOf({ trip: request.trip, capacityKg: load.capacityKg, stopKg: request.pickupIds.map((id) => load.kg.get(id) ?? null) })
