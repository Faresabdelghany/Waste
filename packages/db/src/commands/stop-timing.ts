// What the optimiser's clock reads of a route (O14 of #290), the one read the
// API's fingerprint (`planKey`, ./plans.ts) and the worker's optimisation
// request (`routing.optimise`) share, so a Plan is keyed on exactly what it
// was asked: each stop's window and seconds at the kerb, and the route's
// departure and its planned driver's break.
//
// A stop's window is where its property's access hours and its agreement's
// promise overlap (`stopWindow`, @waste/domain/execution/shift). The
// agreement is the one its subscription runs under: a delivery's own
// subscription, or the subscription of the container's placement in force on
// the operating date. A shared collection point keeps no hours, so its stops
// are bounded by their agreement alone. Every time is seconds from the
// operating date's midnight on the project's clock.
import { departureOf, secondsOfDay, stopWindow, windowSeconds, type DriverShift, type TimeWindow } from "@waste/domain/execution/shift"
import type { PickupService } from "@waste/domain/execution/vocabulary"
import { serviceSecondsOf } from "@waste/domain/execution/workload"
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm"

import type { Tx } from "../client"
import { agreement, subscription } from "../schema/agreements"
import { containerType } from "../schema/catalogue"
import { container, containerServicePlacement } from "../schema/containers"
import { property } from "../schema/customers"
import { pickup } from "../schema/execution"
import { driver } from "../schema/fleet"

/** A stop as the optimiser's clock reads it: its window in seconds of the day, none, or `disjoint` where no time serves it; and its seconds at the kerb. */
export type StopTiming = { window: readonly [number, number] | null | "disjoint"; serviceSeconds: number }

/** A route as the optimiser's clock reads it. */
export type RouteTiming = {
  /** By pickup id: every pickup asked about that the route holds. */
  stops: Map<string, StopTiming>
  /** When the vehicle leaves the depot, seconds of the day; null where neither the route nor its driver says. */
  departure: number | null
  /** The planned driver's break: so many seconds inside a window of the day. */
  breaks: { seconds: number; window: readonly [number, number] }[]
  /** Whether any of it can move the order: a stop's window or a break. A departure alone moves nothing, and an untimed request is keyed as it was before O14. */
  timed: boolean
}

/** A driver's shift columns as the domain's shift, or null for a driver without one. */
export function shiftOf(row: { shiftStart: string | null; shiftEnd: string | null; breakMinutes: number | null; breakWindowStart: string | null; breakWindowEnd: string | null }): DriverShift | null {
  if (row.shiftStart === null || row.shiftEnd === null) return null
  const clock = (time: string) => time.slice(0, 5)
  return {
    from: clock(row.shiftStart),
    to: clock(row.shiftEnd),
    breakMinutes: row.breakMinutes,
    breakWindow: row.breakWindowStart === null || row.breakWindowEnd === null ? null : { from: clock(row.breakWindowStart), to: clock(row.breakWindowEnd) },
  }
}

/** Two time columns as a window, or null where they hold none. */
const windowOf = (start: string | null, end: string | null): TimeWindow | null => (start === null || end === null ? null : { from: start.slice(0, 5), to: end.slice(0, 5) })

/** The columns a driver's shift is read from. */
export const shiftColumns = {
  shiftStart: driver.shiftStart,
  shiftEnd: driver.shiftEnd,
  breakMinutes: driver.breakMinutes,
  breakWindowStart: driver.breakWindowStart,
  breakWindowEnd: driver.breakWindowEnd,
}

/** The planned driver's shift, or null for a route without one or a driver without a shift. */
export async function plannedShift(tx: Tx, companyId: string, plannedDriverId: string | null): Promise<DriverShift | null> {
  if (plannedDriverId === null) return null
  const [row] = await tx
    .select(shiftColumns)
    .from(driver)
    .where(and(eq(driver.companyId, companyId), eq(driver.id, plannedDriverId)))
    .limit(1)
  return row === undefined ? null : shiftOf(row)
}

/** The route's clock over the pickups named: their windows and service, its departure and its driver's break. */
export async function routeTiming(
  tx: Tx,
  companyId: string,
  routeRow: { operatingDate: string; plannedStartTime: string | null; plannedDriverId: string | null },
  pickupIds: readonly string[],
): Promise<RouteTiming> {
  const [rows, shift] = await Promise.all([
    pickupIds.length === 0
      ? []
      : tx
          .select({
            id: pickup.id,
            service: pickup.service,
            containerServiceSeconds: containerType.serviceSeconds,
            propertyStart: property.serviceWindowStart,
            propertyEnd: property.serviceWindowEnd,
            agreementStart: agreement.serviceWindowStart,
            agreementEnd: agreement.serviceWindowEnd,
          })
          .from(pickup)
          .leftJoin(property, and(eq(property.companyId, pickup.companyId), eq(property.id, pickup.propertyId)))
          .leftJoin(container, and(eq(container.companyId, pickup.companyId), eq(container.id, pickup.containerId)))
          .leftJoin(containerType, and(eq(containerType.companyId, container.companyId), eq(containerType.id, container.containerTypeId)))
          .leftJoin(
            containerServicePlacement,
            and(
              eq(containerServicePlacement.companyId, pickup.companyId),
              eq(containerServicePlacement.containerId, pickup.containerId),
              lte(containerServicePlacement.validFrom, routeRow.operatingDate),
              or(isNull(containerServicePlacement.validTo), gt(containerServicePlacement.validTo, routeRow.operatingDate)),
            ),
          )
          .leftJoin(subscription, and(eq(subscription.companyId, pickup.companyId), eq(subscription.id, sql`coalesce(${pickup.subscriptionId}, ${containerServicePlacement.subscriptionId})`)))
          .leftJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
          .where(and(eq(pickup.companyId, companyId), inArray(pickup.id, [...pickupIds]))),
    plannedShift(tx, companyId, routeRow.plannedDriverId),
  ])
  const stops = new Map<string, StopTiming>()
  for (const row of rows) {
    const window = stopWindow([windowOf(row.propertyStart, row.propertyEnd), windowOf(row.agreementStart, row.agreementEnd)])
    stops.set(row.id, {
      window: window === null || window === "disjoint" ? window : windowSeconds(window),
      serviceSeconds: serviceSecondsOf({ service: row.service as PickupService, containerServiceSeconds: row.containerServiceSeconds }),
    })
  }
  const departure = departureOf(routeRow.plannedStartTime, shift)
  const breaks =
    shift === null || shift.breakMinutes === null ? [] : [{ seconds: shift.breakMinutes * 60, window: windowSeconds(shift.breakWindow ?? { from: shift.from, to: shift.to }) }]
  const timed = breaks.length > 0 || [...stops.values()].some((stop) => stop.window !== null)
  return { stops, departure: departure === null ? null : secondsOfDay(departure), breaks, timed }
}
