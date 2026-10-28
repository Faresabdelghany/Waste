// A route's workload (O10 of #290): what its stops take at the kerb and what
// they are expected to weigh. A stop's expected weight is its container's
// litres times its fraction's density (kg per m³, `waste_fraction`), and its
// service time an emptying's container type's seconds (`container_type`) or a
// work order's figure for its service. Both settings are the company's, the
// seed's figures typical ones the office sets its own over.
//
// The route reads them as the stop time its Duration adds to the drive — over
// the stops still planned, the set the optimiser's Plan orders — and as the
// load it compares with its planned vehicle's payload, over the stops it
// serves, planned or completed, that load waste: an emptying, a swap and a
// bulky collection (O11), never
// a delivery's empty container, a repair or a wash. Where the load runs
// over the payload on a full trip, the route's Plan unloads on the way
// (O15 of #290, @waste/domain/routing/reloads), each stop's load read here
// (`stopLoadKg`); without a payload, a station or loads that say so, the route
// tips once at the end and a heavier one is told it is over.
// The optimiser is sent each stop's service; its cost is the drive alone, so
// a stop's seconds never change the order, and they stay out of a Plan's
// fingerprint (`@waste/domain/routing/fingerprint`).
import { roundHalfAwayFromZero } from "../finance/money"
import type { PickupService, PickupStatus, WorkOrderService } from "./vocabulary"

/** A fraction's density, kg per m³: the bounds the database and the wire hold it to. */
export const DENSITY_KG_PER_CUBIC_METRE = { min: 1, max: 2000 } as const

/** A container type's service time, seconds at the kerb: the bounds the database and the wire hold it to. */
export const SERVICE_SECONDS = { min: 1, max: 3600 } as const

/** A stop whose service time nothing says: an emptying of a container type with none, or of no container at all. */
export const UNKNOWN_SERVICE_SECONDS = 60

/** A work order's time at the stop, by its service: typical figures, the same whatever the container. */
export const WORK_ORDER_SERVICE_SECONDS = {
  deliver: 300,
  remove: 300,
  swap: 600,
  repair: 900,
  wash: 600,
} as const satisfies Record<WorkOrderService, number>

/** A bulky collection's time at the stop (O11 of #290): items carried out by hand, whatever they are. */
export const BULKY_SERVICE_SECONDS = 600

/** Its container's volume times its fraction's density, whole kilograms, or null where either is unknown. */
export function expectedKg(stop: { volumeLitres: number | null; densityKgPerCubicMetre: number | null }): number | null {
  if (stop.volumeLitres === null || stop.densityKgPerCubicMetre === null) return null
  return roundHalfAwayFromZero((stop.volumeLitres * stop.densityKgPerCubicMetre) / 1000)
}

/** A stop's seconds at the kerb: an emptying its container type's, a work order its service's, a bulky collection its own. */
export function serviceSecondsOf(stop: { service: PickupService; containerServiceSeconds: number | null }): number {
  if (stop.service === "bulky") return BULKY_SERVICE_SECONDS
  if (stop.service !== "empty") return WORK_ORDER_SERVICE_SECONDS[stop.service]
  return stop.containerServiceSeconds ?? UNKNOWN_SERVICE_SECONDS
}

/** A stop as its route's workload reads it, or `count` stops alike, as a read grouped by these fields gives them. */
export type WorkloadStop = {
  service: PickupService
  status: PickupStatus
  volumeLitres: number | null
  densityKgPerCubicMetre: number | null
  containerServiceSeconds: number | null
  /** How many stops alike this one stands for; one where absent. */
  count?: number
}

/** What a route's stops take and weigh, against its vehicle's payload. */
export type RouteWorkload = {
  /** Seconds at the stops still planned: what the drive still to come adds at the kerb. */
  stopSeconds: number
  /** The kilograms its stops that load waste are expected to weigh, those that can be; null where none can. */
  expectedKg: number | null
  /** Stops that load waste whose weight cannot be expected: no container, no volume, no density. */
  unexpectedStops: number
  /** The planned vehicle's payload, or null. */
  capacityKg: number | null
  /** How far the expected kilograms run over the payload, 0 within it; null where either is unknown. */
  overCapacityKg: number | null
}

/** Whether the route serves the stop: one done or still to do, never one skipped or failed. */
const serves = (stop: WorkloadStop) => stop.status === "planned" || stop.status === "completed"

/** Whether the stop puts waste on the truck: an emptying, a swap's full container and a bulky collection's items, whose weight nothing says; a delivery's is empty, and a repair or a wash loads nothing. */
const loadsWaste = (stop: Pick<WorkloadStop, "service">) => stop.service === "empty" || stop.service === "swap" || stop.service === "bulky"

/** The kilograms a stop puts on the truck, as a Plan's reloads read it: its expected weight where it loads waste, nothing where it loads none, null where its weight cannot be expected. */
export function stopLoadKg(stop: Pick<WorkloadStop, "service" | "volumeLitres" | "densityKgPerCubicMetre">): number | null {
  return loadsWaste(stop) ? expectedKg(stop) : 0
}

/** A route's workload, against its planned vehicle's payload. */
export function routeWorkload(stops: readonly WorkloadStop[], capacityKg: number | null): RouteWorkload {
  let stopSeconds = 0
  let known = 0
  let kg = 0
  let unexpectedStops = 0
  for (const stop of stops) {
    const count = stop.count ?? 1
    if (stop.status === "planned") stopSeconds += serviceSecondsOf(stop) * count
    if (!serves(stop) || !loadsWaste(stop)) continue
    const weight = expectedKg(stop)
    if (weight === null) {
      unexpectedStops += count
      continue
    }
    known += count
    kg += weight * count
  }
  const expected = known === 0 ? null : kg
  return {
    stopSeconds,
    expectedKg: expected,
    unexpectedStops,
    capacityKg,
    overCapacityKg: expected === null || capacityKg === null ? null : Math.max(0, expected - capacityKg),
  }
}
