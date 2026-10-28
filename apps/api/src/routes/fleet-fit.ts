// Whether a vehicle fits the stops it is given (O7 of #290), as the commands
// that put a vehicle and stops together read it: `assign` naming a vehicle
// afresh, a split's new route, a move or a merge onto a route with a planned
// vehicle, Add stop on one, and the Balance day's proposal. The rule is the
// domain's (`firstMisfit`, @waste/domain/resources/fleet-fit): a fraction no
// compartment carries, a container its type does not lift, a stop heavier
// than one trip of its fraction — each a 409 in its sentence, after every 400
// of the command. A route heavier than one payload is not refused: its Plan
// unloads on the way (O15), and the route read says how far over it runs.
//
// The stops judged are the ones that load waste (`loadsWaste`: an emptying, a
// swap, a bulky collection) and are still planned: a delivery's container is
// empty and a repair loads nothing, and a stop done or skipped is not the
// vehicle's to serve. A vehicle's fit is three statements however many are
// asked — the vehicles, their compartments with their fractions, and the
// container types their types lift — and the stops' one; names are read only
// once a sentence needs them.
import type { Tx } from "@waste/db/client"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { pickup } from "@waste/db/schema/execution"
import { vehicle, vehicleCompartment, vehicleCompartmentFraction } from "@waste/db/schema/fleet"
import { containerTypeVehicleType } from "@waste/db/schema/fleet-types"
import { loadsWaste, stopLoadKg } from "@waste/domain/execution/workload"
import type { PickupService } from "@waste/domain/execution/vocabulary"
import { firstMisfit, misfitSentence, type FitStop, type FitVehicle, type Misfit } from "@waste/domain/resources/fleet-fit"
import { and, asc, eq, inArray, type SQL } from "drizzle-orm"

import { problem } from "../problem"
import { vehicleLabel } from "./fleet-lookups"

/** A vehicle as the fleet rules read it, with the label a sentence names it by and its type. */
export type FitRow = FitVehicle & { id: string; label: string; vehicleTypeId: string }

/** The vehicles' fit, by id: every one of the company's asked for that exists. */
export async function fitsOf(tx: Tx, companyId: string, vehicleIds: readonly string[]): Promise<Map<string, FitRow>> {
  const ids = [...new Set(vehicleIds)]
  if (ids.length === 0) return new Map()
  const [vehicles, chambers] = await Promise.all([
    tx
      .select({ id: vehicle.id, registration: vehicle.registration, callsign: vehicle.callsign, capacityKg: vehicle.capacityKg, vehicleTypeId: vehicle.vehicleTypeId })
      .from(vehicle)
      .where(and(eq(vehicle.companyId, companyId), inArray(vehicle.id, ids))),
    tx
      .select({ id: vehicleCompartment.id, vehicleId: vehicleCompartment.vehicleId, capacityKg: vehicleCompartment.capacityKg, wasteFractionId: vehicleCompartmentFraction.wasteFractionId })
      .from(vehicleCompartment)
      .leftJoin(vehicleCompartmentFraction, and(eq(vehicleCompartmentFraction.companyId, vehicleCompartment.companyId), eq(vehicleCompartmentFraction.vehicleCompartmentId, vehicleCompartment.id)))
      .where(and(eq(vehicleCompartment.companyId, companyId), inArray(vehicleCompartment.vehicleId, ids)))
      .orderBy(asc(vehicleCompartment.position), asc(vehicleCompartmentFraction.id)),
  ])
  const typeIds = [...new Set(vehicles.map((row) => row.vehicleTypeId))]
  const lifts =
    typeIds.length === 0
      ? []
      : await tx
          .select({ vehicleTypeId: containerTypeVehicleType.vehicleTypeId, containerTypeId: containerTypeVehicleType.containerTypeId })
          .from(containerTypeVehicleType)
          .where(and(eq(containerTypeVehicleType.companyId, companyId), inArray(containerTypeVehicleType.vehicleTypeId, typeIds)))
  // Each compartment once, its fractions gathered from the rows the join spread it over.
  const compartments = new Map<string, Map<string, { capacityKg: number | null; wasteFractionIds: string[] }>>()
  for (const row of chambers) {
    const own = compartments.get(row.vehicleId) ?? new Map()
    const found = own.get(row.id) ?? { capacityKg: row.capacityKg, wasteFractionIds: [] }
    if (row.wasteFractionId !== null) found.wasteFractionIds.push(row.wasteFractionId)
    own.set(row.id, found)
    compartments.set(row.vehicleId, own)
  }
  return new Map(
    vehicles.map((row) => {
      const lifted = lifts.filter((pair) => pair.vehicleTypeId === row.vehicleTypeId).map((pair) => pair.containerTypeId)
      const fit: FitRow = {
        id: row.id,
        label: vehicleLabel(row),
        vehicleTypeId: row.vehicleTypeId,
        capacityKg: row.capacityKg,
        compartments: [...(compartments.get(row.id)?.values() ?? [])],
        // A type the compatibility set names nothing for lifts any.
        liftsContainerTypeIds: lifted.length === 0 ? null : lifted,
      }
      return [row.id, fit] as const
    }),
  )
}

/** The stops a vehicle would serve, as the rules read them: the planned ones that load waste, by `where` over `pickup`. */
async function fitStops(tx: Tx, companyId: string, where: SQL | undefined): Promise<FitStop[]> {
  const rows = await tx
    .select({
      service: pickup.service,
      wasteFractionId: pickup.wasteFractionId,
      containerTypeId: container.containerTypeId,
      volumeLitres: containerType.volumeLitres,
      densityKgPerCubicMetre: wasteFraction.densityKgPerCubicMetre,
    })
    .from(pickup)
    .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
    .leftJoin(containerType, and(eq(containerType.companyId, container.companyId), eq(containerType.id, container.containerTypeId)))
    .leftJoin(wasteFraction, and(eq(wasteFraction.companyId, pickup.companyId), eq(wasteFraction.id, pickup.wasteFractionId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.status, "planned"), where))
    .orderBy(asc(pickup.position), asc(pickup.id))
  return rows.flatMap((row) => {
    const service = row.service as PickupService
    if (!loadsWaste({ service })) return []
    return [{ wasteFractionId: row.wasteFractionId, kg: stopLoadKg({ service, volumeLitres: row.volumeLitres, densityKgPerCubicMetre: row.densityKgPerCubicMetre }), containerTypeId: row.containerTypeId }]
  })
}

/** A route's open stops that load waste. */
export const routeFitStops = (tx: Tx, companyId: string, routeId: string): Promise<FitStop[]> => fitStops(tx, companyId, eq(pickup.routeId, routeId))

/** These stops, those still open that load waste. */
export const pickupFitStops = (tx: Tx, companyId: string, pickupIds: readonly string[]): Promise<FitStop[]> =>
  pickupIds.length === 0 ? Promise.resolve([]) : fitStops(tx, companyId, inArray(pickup.id, [...pickupIds]))

/** The sentence of a misfit, its fraction's or its container type's name read for it. */
async function sentenceOf(tx: Tx, companyId: string, fit: FitRow, misfit: Misfit, of: string | undefined): Promise<string> {
  if (misfit.kind === "container-type") {
    const [row] = await tx
      .select({ name: containerType.name })
      .from(containerType)
      .where(and(eq(containerType.companyId, companyId), eq(containerType.id, misfit.containerTypeId)))
      .limit(1)
    return misfitSentence(misfit, { vehicle: fit.label, containerType: row?.name, of })
  }
  const [row] = await tx
    .select({ name: wasteFraction.name })
    .from(wasteFraction)
    .where(and(eq(wasteFraction.companyId, companyId), eq(wasteFraction.id, misfit.wasteFractionId)))
    .limit(1)
  return misfitSentence(misfit, { vehicle: fit.label, fraction: row?.name, of })
}

/**
 * The vehicle serves the stops (`firstMisfit`): a 409 in the first broken
 * rule's sentence otherwise, `of` naming whose stops they are (`route
 * RC-1042`; absent, the stops alone). A vehicle that is not there is asked
 * nothing: the caller has refused it at its field already.
 */
export async function refuseMisfit(tx: Tx, companyId: string, vehicleId: string, stops: readonly FitStop[], of?: string): Promise<void> {
  if (stops.length === 0) return
  const fit = (await fitsOf(tx, companyId, [vehicleId])).get(vehicleId)
  if (fit === undefined) return
  const misfit = firstMisfit(fit, stops)
  if (misfit !== undefined) throw problem(409, { detail: await sentenceOf(tx, companyId, fit, misfit, of) })
}
