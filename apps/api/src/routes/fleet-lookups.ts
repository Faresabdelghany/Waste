// Resources' rows as the routes that name them read them (Issue #101, slice
// 6): a vehicle of one kind, a driver, and the project's clock. Two callers
// and one spelling — the allocation commands (routes/vehicle-allocations.ts)
// and Planning's group writes (routes/scheme-groups.ts) — so a driver's
// licence is read the same way for a reservation and for a Collection Group.
//
// These are reads, not checks. `findVehicle` and `findDriver` read the row
// back instead of only finding it, because what the caller does next needs
// it — the class the vehicle requires and the callsign a sentence names it
// by, the class the driver holds and the day it runs out — and reading it
// twice would be the same statement over again. The existence checks and
// their sentences are routes/references.ts's (`requireVehicle`,
// `requireDriver`, `requireDepot`, `requireUnloadingStation`): a read that
// finds nothing refuses in the words the check does, imported from there, so
// a body naming a trailer where a powered vehicle is required is told one
// thing whichever door asked. A vehicle is found by kind: an allocation's
// `vehicleId` and a group's is a `powered-vehicle`, an allocation's
// `trailerId` a `trailer`, and a row of the other kind is refused in that
// kind's words, since the two columns of an allocation must never hold the
// same vehicle and the kind is what keeps them apart. Both rows carry their
// status, since a route naming one afresh holds it (routes/statuses.ts) and a
// second read for one column would be the same statement over again; the
// column sets are exported so routes/scheme-groups.ts reads a body's whole
// fleet in one statement per table and gets the same rows.
//
// The project's clock is read here too — `projectTimezone`, `projectCurrency`
// and `projectToday`, the app's `now` rendered as a day on it — since a
// Collection Group's licence day, a billing run's `issuedOn` and a credit
// note's are one question asked by three contexts (Issue #112, its review).
import type { Tx } from "@waste/db/client"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import type { DriverStatus, LicenceClass, VehicleKind, VehicleStatus } from "@waste/domain/resources/vocabulary"
import { and, eq } from "drizzle-orm"

import { invalidRequest } from "../problem"
import { dayInTimezone } from "./days"
import { NOT_A_DRIVER, notAVehicleOf, type Scope } from "./references"

/** What a sentence and a licence check read of a vehicle. */
export type VehicleRow = {
  id: string
  registration: string
  callsign: string | null
  kind: VehicleKind
  status: VehicleStatus
  requiredLicenceClass: LicenceClass
}

/** How a person names a vehicle: the yard's callsign (`WH-24`) where it has one, the plate otherwise. */
export const vehicleLabel = (row: Pick<VehicleRow, "registration" | "callsign">): string => row.callsign ?? row.registration

/** The columns a `VehicleRow` is read from. */
export const vehicleColumns = {
  id: vehicle.id,
  registration: vehicle.registration,
  callsign: vehicle.callsign,
  kind: vehicle.kind,
  status: vehicle.status,
  requiredLicenceClass: vehicle.requiredLicenceClass,
}

/**
 * One vehicle of the project and of the kind asked for, read for what the
 * caller does with it next, or a 400 at `path` in the kind's words. The
 * project comes from the scope and never from the body: a vehicle of another
 * project is a vehicle that is not here.
 */
export async function findVehicle(tx: Tx, scope: Scope, id: string, kind: VehicleKind, path: string): Promise<VehicleRow> {
  const [row] = await tx
    .select(vehicleColumns)
    .from(vehicle)
    .where(and(eq(vehicle.companyId, scope.companyId), eq(vehicle.projectId, scope.projectId), eq(vehicle.id, id), eq(vehicle.kind, kind)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path, message: notAVehicleOf(kind) }])
  // The coded columns are text with a CHECK in the database and a vocabulary here.
  return row as VehicleRow
}

/** What a licence check reads of a driver, the name a sentence calls them by, and the status a new reference is held to. */
export type DriverRow = {
  id: string
  name: string
  status: DriverStatus
  licenceClass: LicenceClass | null
  /** `YYYY-MM-DD`, the last day the licence holds; null for none on record. */
  licenceExpiry: string | null
}

/** The columns a `DriverRow` is read from. */
export const driverColumns = { id: driver.id, name: driver.name, status: driver.status, licenceClass: driver.licenceClass, licenceExpiry: driver.licenceExpiry }

/** One driver of the project, read for the licence rule, or a 400 at `path`. */
export async function findDriver(tx: Tx, scope: Scope, id: string, path = "driverId"): Promise<DriverRow> {
  const [row] = await tx
    .select(driverColumns)
    .from(driver)
    .where(and(eq(driver.companyId, scope.companyId), eq(driver.projectId, scope.projectId), eq(driver.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path, message: NOT_A_DRIVER }])
  return row as DriverRow
}

/**
 * The project's timezone, an IANA name the contracts checked on the way in:
 * what an instant is rendered as a day in (routes/days.ts). The project is
 * one the principal works in, read under the caller's scope a moment ago, so
 * its absence here is a bug and is thrown.
 */
export async function projectTimezone(tx: Tx, companyId: string, projectId: string): Promise<string> {
  const [row] = await tx
    .select({ timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`projectTimezone: no project ${projectId} in company ${companyId}`)
  return row.timezone
}

/**
 * The project's currency, ISO 4217 as the contracts checked it: what a price
 * list defaults to and a default list must be in, and what a provider price
 * is quoted in (Issue #112). The same rule as the timezone's: the project is
 * the caller's, proved a moment ago, so its absence here is a bug and is
 * thrown.
 */
export async function projectCurrency(tx: Tx, companyId: string, projectId: string): Promise<string> {
  const [row] = await tx
    .select({ currency: project.currency })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
    .limit(1)
  if (row === undefined) throw new Error(`projectCurrency: no project ${projectId} in company ${companyId}`)
  return row.currency
}

/** Today on a project's clock, asked for at most once per request. */
export type Today = () => Promise<string>

/**
 * Today on the project's clock — the app's `now` rendered as a day in
 * `project.timezone` (routes/days.ts) — read once per request, however many
 * times it is asked, and not at all when nobody asks: a Collection Group's
 * licence day (routes/scheme-groups.ts), a billing run's `issuedOn`
 * (routes/billing-runs.ts), a credit note's (routes/invoices.ts). The clock
 * is the app's and never `new Date()` here, so a test pins the day.
 */
export function projectToday(tx: Tx, scope: Scope, now: () => Date): Today {
  let today: Promise<string> | undefined
  return () => (today ??= projectTimezone(tx, scope.companyId, scope.projectId).then((timezone) => dayInTimezone(now(), timezone)))
}
