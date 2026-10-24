// What a command naming a driver or a vehicle afresh asks of its days (O6 of
// #290): whether a period of the driver's absence, or of the vehicle's
// unavailability, touches them. The days are a half-open period (`Period`,
// periods.ts) — a route's operating date, a group's first run day, an
// allocation's window rendered as its project's days — and the read is one
// per family over every row asked, under both fences, answering the earliest
// period touching the days, which the refusal names. Each refusal is a 409 in
// the domain's sentence (@waste/domain/resources/availability), judged after
// every 400 of the command, the way a status gate is: the id is right and the
// row is there, and what refuses is where it is on those days. The routes
// that keep the periods (availability.ts) ask the same reads.
import type { Tx } from "@waste/db/client"
import { validOver } from "@waste/db/query/valid-on"
import { driverAbsence, vehicleUnavailability } from "@waste/db/schema/availability"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { absentDriver, absentForDispatch, awayOver as earliestOver, unavailableForDispatch, unavailableVehicle, type AvailabilityNeed, type AwayPeriod } from "@waste/domain/resources/availability"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, asc, eq, inArray, ne } from "drizzle-orm"

import { problem } from "../problem"
import { vehicleLabel } from "./fleet-lookups"
import type { Period } from "./periods"
import type { Scope } from "./references"

/** One day, as a route's operating date or a group's run day is. */
export const oneDay = (day: string): Period => ({ validFrom: day, validTo: addDays(day, 1) })

/** The days from `first` through `last`, both in: an allocation's window as its project reads it. */
export const daysThrough = (first: string, last: string): Period => ({ validFrom: first, validTo: addDays(last, 1) })

/** A period as the routes read it back: its id and whose it is beside the period itself. */
export type AwayRow = AwayPeriod & { id: string; ownerId: string }

/** Whose periods a read asks for: a driver's absences or a vehicle's (or a trailer's) unavailability. */
export type AwayFamily = "driver" | "vehicle"

/**
 * The periods of the owners touching `period`, earliest first, in the
 * scope's company and project — the one project a driver's or a vehicle's
 * periods live in. `except` leaves out the row a patch moves.
 */
export async function periodsOver(tx: Tx, family: AwayFamily, scope: Scope, ownerIds: readonly string[], period: Period, except?: string): Promise<AwayRow[]> {
  const owners = [...new Set(ownerIds)]
  if (owners.length === 0) return []
  if (family === "driver") {
    return tx
      .select({ id: driverAbsence.id, ownerId: driverAbsence.driverId, validFrom: driverAbsence.validFrom, validTo: driverAbsence.validTo, reason: driverAbsence.reason })
      .from(driverAbsence)
      .where(
        and(
          eq(driverAbsence.companyId, scope.companyId),
          eq(driverAbsence.projectId, scope.projectId),
          inArray(driverAbsence.driverId, owners),
          validOver(driverAbsence, period),
          except === undefined ? undefined : ne(driverAbsence.id, except),
        ),
      )
      .orderBy(asc(driverAbsence.validFrom))
  }
  return tx
    .select({ id: vehicleUnavailability.id, ownerId: vehicleUnavailability.vehicleId, validFrom: vehicleUnavailability.validFrom, validTo: vehicleUnavailability.validTo, reason: vehicleUnavailability.reason })
    .from(vehicleUnavailability)
    .where(
      and(
        eq(vehicleUnavailability.companyId, scope.companyId),
        eq(vehicleUnavailability.projectId, scope.projectId),
        inArray(vehicleUnavailability.vehicleId, owners),
        validOver(vehicleUnavailability, period),
        except === undefined ? undefined : ne(vehicleUnavailability.id, except),
      ),
    )
    .orderBy(asc(vehicleUnavailability.validFrom))
}

/** The earliest period of one owner touching `period`, or undefined. */
export async function awayOver(tx: Tx, family: AwayFamily, scope: Scope, ownerId: string, period: Period, except?: string): Promise<AwayRow | undefined> {
  const [row] = await periodsOver(tx, family, scope, [ownerId], period, except)
  return row
}

/** A driver's name for a sentence, read only once a refusal needs it. */
export async function driverName(tx: Tx, scope: Scope, id: string): Promise<string> {
  const [row] = await tx.select({ name: driver.name }).from(driver).where(and(eq(driver.companyId, scope.companyId), eq(driver.projectId, scope.projectId), eq(driver.id, id))).limit(1)
  return row?.name ?? "The driver"
}

/** A vehicle's label for a sentence (`vehicleLabel`), read only once a refusal needs it. */
export async function vehicleName(tx: Tx, scope: Scope, id: string): Promise<string> {
  const [row] = await tx
    .select({ registration: vehicle.registration, callsign: vehicle.callsign })
    .from(vehicle)
    .where(and(eq(vehicle.companyId, scope.companyId), eq(vehicle.projectId, scope.projectId), eq(vehicle.id, id)))
    .limit(1)
  return row === undefined ? "The vehicle" : vehicleLabel(row)
}

/** The crew a command names, by id: each null or absent where it names none. */
export type Crew = { vehicleId?: string | null; trailerId?: string | null; driverId?: string | null }

/** What a crew member away is told, by the command that refuses them. */
type Sentences = { vehicle: (label: string, period: AwayPeriod, as: "vehicle" | "trailer") => string; driver: (name: string, period: AwayPeriod) => string }

/**
 * The crews a command names are there, each on its days: in the crews'
 * order, the vehicle, then the trailer, then the driver — the order the
 * status gates judge them in — the first one away a 409 naming the earliest
 * period of theirs touching their days. One read per family over them all.
 */
async function refuseAway(tx: Tx, scope: Scope, crews: readonly (Crew & { days: Period })[], say: Sentences): Promise<void> {
  const ids = (pick: (crew: Crew) => string | null | undefined) => crews.flatMap((crew) => (pick(crew) == null ? [] : [pick(crew) as string]))
  const vehicleIds = [...ids((crew) => crew.vehicleId), ...ids((crew) => crew.trailerId)]
  const driverIds = ids((crew) => crew.driverId)
  if (vehicleIds.length === 0 && driverIds.length === 0) return
  // The span every crew's days lie in: a period touching one of them touches it.
  const span: Period = {
    validFrom: crews.map((crew) => crew.days.validFrom).reduce((a, b) => (a < b ? a : b)),
    validTo: crews.some((crew) => crew.days.validTo === null) ? null : crews.map((crew) => crew.days.validTo as string).reduce((a, b) => (a > b ? a : b)),
  }
  const [vehicles, drivers] = await Promise.all([periodsOver(tx, "vehicle", scope, vehicleIds, span), periodsOver(tx, "driver", scope, driverIds, span)])
  const awayFor = (rows: readonly AwayRow[], ownerId: string, days: Period) =>
    earliestOver(
      rows.filter((row) => row.ownerId === ownerId),
      days.validFrom,
      days.validTo,
    )
  for (const crew of crews) {
    for (const [id, as] of [[crew.vehicleId, "vehicle"], [crew.trailerId, "trailer"]] as const) {
      if (id == null) continue
      const away = awayFor(vehicles, id, crew.days)
      if (away !== undefined) throw problem(409, { detail: say.vehicle(await vehicleName(tx, scope, id), away, as) })
    }
    if (crew.driverId == null) continue
    const away = awayFor(drivers, crew.driverId, crew.days)
    if (away !== undefined) throw problem(409, { detail: say.driver(await driverName(tx, scope, crew.driverId), away) })
  }
}

/** The crew a command names is there over its days: a 409 in the sentence of what the command needs them for otherwise. */
export function refuseCrewAway(tx: Tx, scope: Scope, crew: Crew, days: Period, need: AvailabilityNeed): Promise<void> {
  return refuseCrewsAway(tx, scope, [{ ...crew, days }], need)
}

/** Several crews, each over its own days — a scheme's groups — judged in their order with one read per family. */
export function refuseCrewsAway(tx: Tx, scope: Scope, crews: readonly (Crew & { days: Period })[], need: AvailabilityNeed): Promise<void> {
  return refuseAway(tx, scope, crews, { vehicle: (label, period, as) => unavailableVehicle(label, period, need, as), driver: (name, period) => absentDriver(name, period, need) })
}

/** A dispatch goes out with a planned crew that is there on the operating date: a 409 naming the period otherwise. */
export function refuseDispatchAway(tx: Tx, scope: Scope, crew: Crew, day: string): Promise<void> {
  return refuseAway(tx, scope, [{ ...crew, days: oneDay(day) }], { vehicle: unavailableForDispatch, driver: absentForDispatch })
}
