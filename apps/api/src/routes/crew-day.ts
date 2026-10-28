// A route's crew against the rest of its day (O7 of #290, rows 3.18 and
// 10.2): the allocations reserving the vehicle, the trailer or the driver,
// and the other routes they are planned on. Both are 409s judged after the
// periods away (availability-rules.ts) and before the vehicle's fit
// (fleet-fit.ts): away, then allocated, then double-booked, then unfit.
//
// An allocation (routes/vehicle-allocations.ts) is live while `planned` or
// `confirmed`, and touches the route where its window meets the operating
// date on the project's clock. It refuses the route where it reserves one of
// the route's crew with another of it: the vehicle with another driver or
// trailer, the driver or the trailer with another vehicle. An allocation
// naming no driver reserves the vehicle with anyone, and a route naming no
// driver yet contradicts nobody's; with no allocation there is no rule.
//
// The other routes are the project's of the same operating date that are
// planned, ready or active and name the crew member in their Planned
// Assignment. Each route's span is its start and its work as the route read
// weighs it (`shiftsByRoute`), judged by the domain (`sameDayClash`,
// @waste/domain/execution/crew-day): a known overlap is refused outright, an
// unknown span unless the body says `acceptSameDay`. The read is one
// statement for the routes and the route read's few for their spans, made
// only when another route of the day names the crew.
import type { Tx } from "@waste/db/client"
import { route } from "@waste/db/schema/execution"
import { vehicleAllocation } from "@waste/db/schema/allocations"
import { project } from "@waste/db/schema/organisation"
import { allocatedWithOthers, overlappingRoute, sameDayClash, sameDayUnconfirmed, spanOf, type DaySpan } from "@waste/domain/execution/crew-day"
import { formatOccurrenceShortDate } from "@waste/domain/route-schemes/occurrences"
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm"

import { problem } from "../problem"
import { driverName, vehicleName } from "./availability-rules"
import { labelOf, routeColumns, type RouteRow } from "./execution-shapes"
import { dayInTimezone } from "./days"
import { projectTimezone } from "./fleet-lookups"
import type { Scope } from "./references"
import { LIVE_ALLOCATION_STATUSES } from "./statuses"
import { shiftsByRoute, workloadsByRoute } from "./workload"

/** The crew a route plans, by id, each null where it names none. */
export type RouteCrew = { vehicleId: string | null; driverId: string | null; trailerId: string | null }

/** An instant's time on the project's clock: `06:00`. */
const timeIn = (instant: Date, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant)

/** An allocation's window as a person reads it on the project's clock: "Mon 5 Oct 06:00–14:00", "Mon 5 Oct 06:00 – Tue 6 Oct 02:00". */
function windowPhrase(from: Date, to: Date, timeZone: string): string {
  const [first, last] = [dayInTimezone(from, timeZone), dayInTimezone(to, timeZone)]
  if (first === last) return `${formatOccurrenceShortDate(first)} ${timeIn(from, timeZone)}–${timeIn(to, timeZone)}`
  return `${formatOccurrenceShortDate(first)} ${timeIn(from, timeZone)} – ${formatOccurrenceShortDate(last)} ${timeIn(to, timeZone)}`
}

/**
 * No live allocation over the day reserves one of the crew with another of
 * it: a 409 naming the allocation's window and crew otherwise, the vehicle's
 * allocation before the trailer's, before the driver's.
 */
export async function refuseAllocatedElsewhere(tx: Tx, scope: Scope, crew: RouteCrew, day: string): Promise<void> {
  const { vehicleId, driverId, trailerId } = crew
  const named = [
    ...(vehicleId === null ? [] : [eq(vehicleAllocation.vehicleId, vehicleId)]),
    ...(trailerId === null ? [] : [eq(vehicleAllocation.trailerId, trailerId)]),
    ...(driverId === null ? [] : [eq(vehicleAllocation.driverId, driverId)]),
  ]
  if (named.length === 0) return
  // The day's bounds on the project's clock, rendered by the database from the project's timezone.
  const dayStart = sql`(${day}::date)::timestamp at time zone ${project.timezone}`
  const dayEnd = sql`((${day}::date) + 1)::timestamp at time zone ${project.timezone}`
  const rows = await tx
    .select({ vehicleId: vehicleAllocation.vehicleId, driverId: vehicleAllocation.driverId, trailerId: vehicleAllocation.trailerId, plannedFrom: vehicleAllocation.plannedFrom, plannedTo: vehicleAllocation.plannedTo })
    .from(vehicleAllocation)
    .innerJoin(project, and(eq(project.companyId, vehicleAllocation.companyId), eq(project.id, vehicleAllocation.projectId)))
    .where(
      and(
        eq(vehicleAllocation.companyId, scope.companyId),
        eq(vehicleAllocation.projectId, scope.projectId),
        inArray(vehicleAllocation.status, [...LIVE_ALLOCATION_STATUSES]),
        or(...named),
        sql`tstzrange(${vehicleAllocation.plannedFrom}, ${vehicleAllocation.plannedTo}, '[)') && tstzrange(${dayStart}, ${dayEnd}, '[)')`,
      ),
    )
    .orderBy(asc(vehicleAllocation.plannedFrom), asc(vehicleAllocation.id))
  // Which of the route's crew an allocation reserves with others, and those others, by kind.
  const differs = (theirs: string | null, ours: string | null) => theirs !== null && ours !== null && theirs !== ours
  const clashes: { who: () => Promise<string>; others: () => Promise<string[]>; row: (typeof rows)[number] }[] = []
  for (const row of rows) {
    if (vehicleId !== null && row.vehicleId === vehicleId && (differs(row.driverId, driverId) || differs(row.trailerId, trailerId))) {
      clashes.push({
        row,
        who: () => vehicleName(tx, scope, vehicleId),
        others: async () => [...(differs(row.driverId, driverId) ? [await driverName(tx, scope, row.driverId as string)] : []), ...(differs(row.trailerId, trailerId) ? [await vehicleName(tx, scope, row.trailerId as string)] : [])],
      })
    }
  }
  for (const row of rows) {
    if (trailerId !== null && row.trailerId === trailerId && differs(row.vehicleId, vehicleId)) clashes.push({ row, who: () => vehicleName(tx, scope, trailerId), others: async () => [await vehicleName(tx, scope, row.vehicleId)] })
  }
  for (const row of rows) {
    if (driverId !== null && row.driverId === driverId && differs(row.vehicleId, vehicleId)) clashes.push({ row, who: () => driverName(tx, scope, driverId), others: async () => [await vehicleName(tx, scope, row.vehicleId)] })
  }
  const [first] = clashes
  if (first === undefined) return
  const timeZone = await projectTimezone(tx, scope.companyId, scope.projectId)
  throw problem(409, { detail: allocatedWithOthers(await first.who(), windowPhrase(first.row.plannedFrom, first.row.plannedTo, timeZone), await first.others()) })
}

/** Which of the crew a command names afresh, or moves the day or the start of: only those are asked of the day's other routes. */
export type CrewAsked = { vehicle: boolean; driver: boolean; trailer: boolean }

/**
 * The crew named afresh is on no other route of the day at once (row 3.18):
 * the route as the command leaves it — its day, start and crew — against the
 * project's other routes of that day naming one of them, planned, ready or
 * active. A known overlap is a 409 whatever the body says; a span not known
 * is a 409 unless the body says `acceptSameDay`. The vehicle, then the
 * trailer, then the driver; the first overlap of any before an unknown span.
 */
export async function refuseDoubleBooked(tx: Tx, scope: Scope, after: RouteRow, asked: CrewAsked, acceptSameDay: boolean): Promise<void> {
  const members = [
    ...(asked.vehicle && after.plannedVehicleId !== null ? [{ column: route.plannedVehicleId, id: after.plannedVehicleId, name: () => vehicleName(tx, scope, after.plannedVehicleId as string) }] : []),
    ...(asked.trailer && after.plannedTrailerId !== null ? [{ column: route.plannedTrailerId, id: after.plannedTrailerId, name: () => vehicleName(tx, scope, after.plannedTrailerId as string) }] : []),
    ...(asked.driver && after.plannedDriverId !== null ? [{ column: route.plannedDriverId, id: after.plannedDriverId, name: () => driverName(tx, scope, after.plannedDriverId as string) }] : []),
  ]
  if (members.length === 0) return
  const others = await tx
    .select(routeColumns)
    .from(route)
    .where(
      and(
        eq(route.companyId, scope.companyId),
        eq(route.projectId, scope.projectId),
        eq(route.operatingDate, after.operatingDate),
        inArray(route.status, ["planned", "ready", "active"]),
        ne(route.id, after.id),
        or(...members.map((member) => eq(member.column, member.id))),
      ),
    )
    .orderBy(asc(route.number))
  if (others.length === 0) return
  // Every span the route read would answer: the route as the command leaves it, and the others as they stand.
  const weighed = [after, ...others]
  const shifts = await shiftsByRoute(tx, scope.companyId, weighed, await workloadsByRoute(tx, scope.companyId, weighed))
  const spanOfRoute = (row: RouteRow): DaySpan | null => {
    const day = shifts.get(row.id)
    return day === undefined ? null : spanOf(day)
  }
  const own = spanOfRoute(after)
  const judged = members.map((member) => {
    const sharing = others.filter((row) => (member.column === route.plannedVehicleId ? row.plannedVehicleId : member.column === route.plannedTrailerId ? row.plannedTrailerId : row.plannedDriverId) === member.id)
    return { member, clash: sameDayClash(own, sharing.map((row) => ({ id: row.id, span: spanOfRoute(row) }))) }
  })
  const overlap = judged.find((one) => one.clash?.kind === "overlap")
  if (overlap !== undefined && overlap.clash !== undefined) {
    const other = others.find((row) => row.id === overlap.clash?.routeId) as RouteRow
    throw problem(409, { detail: overlappingRoute(await overlap.member.name(), labelOf(other), spanOfRoute(other) as DaySpan, labelOf(after), own as DaySpan) })
  }
  if (acceptSameDay) return
  const unknown = judged.find((one) => one.clash?.kind === "unknown")
  if (unknown !== undefined && unknown.clash !== undefined) {
    const other = others.find((row) => row.id === unknown.clash?.routeId) as RouteRow
    throw problem(409, { detail: sameDayUnconfirmed(await unknown.member.name(), labelOf(other), labelOf(after)) })
  }
}
