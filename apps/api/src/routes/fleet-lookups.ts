// Resources' rows as the routes that name them read them (Issue #101, slice
// 6): a vehicle of one kind, a driver, a depot, an unloading station, and the
// project's clock. Two callers and one spelling — the allocation commands
// (routes/vehicle-allocations.ts) and Planning's scheme and group writes
// (routes/scheme-groups.ts) — so "Not a powered vehicle of this project" is
// typed once and a driver's licence is read the same way for a reservation
// and for a Collection Group.
//
// Two shapes, the way routes/references.ts has them. `requireDepot` and
// `requireUnloadingStation` are the singular existence checks, `requireRow`
// under the scope the key allows: a depot is the project's, a station the
// company's. `findVehicle` and `findDriver` read the row back instead of only
// finding it, because what the caller does next needs it — the class the
// vehicle requires and the callsign a sentence names it by, the class the
// driver holds and the day it runs out — and reading it twice would be the
// same statement over again. A vehicle is found by kind: an allocation's
// `vehicleId` and a group's is a `powered-vehicle`, an allocation's
// `trailerId` a `trailer`, and a row of the other kind is refused in that
// kind's words, since the two columns of an allocation must never hold the
// same vehicle and the kind is what keeps them apart.
//
// The fleet's own routes (slices 3 and 4) bring the same checks to
// routes/references.ts under the same names and sentences; the two are
// folded together where they meet.
import type { Tx } from "@waste/db/client"
import { driver, vehicle } from "@waste/db/schema/fleet"
import { project } from "@waste/db/schema/organisation"
import { depot, unloadingStation } from "@waste/db/schema/places"
import type { LicenceClass, VehicleKind, VehicleStatus } from "@waste/domain/resources/vocabulary"
import { and, eq } from "drizzle-orm"

import { invalidRequest } from "../problem"
import { requireRow } from "./shared"

/** What a project-scoped lookup is bounded by: the caller's company, and the project the record is in. */
export type Scope = { companyId: string; projectId: string }

export const NOT_A_POWERED_VEHICLE = "Not a powered vehicle of this project"
export const NOT_A_TRAILER = "Not a trailer of this project"
export const NOT_A_DRIVER = "Not a driver of this project"
export const NOT_A_DEPOT = "Not a depot of this project"
export const NOT_AN_UNLOADING_STATION = "Not an unloading station of this company"

/** What a body naming a vehicle of the wrong kind, of another project or of nobody's is told; one sentence per kind asked for. */
export const notAVehicleOfKind = (kind: VehicleKind): string => (kind === "trailer" ? NOT_A_TRAILER : NOT_A_POWERED_VEHICLE)

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

const vehicleColumns = {
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
  if (row === undefined) throw invalidRequest("body", [{ path, message: notAVehicleOfKind(kind) }])
  // The coded columns are text with a CHECK in the database and a vocabulary here.
  return row as VehicleRow
}

/** What a licence check reads of a driver, and the name a sentence calls them by. */
export type DriverRow = {
  id: string
  name: string
  licenceClass: LicenceClass | null
  /** `YYYY-MM-DD`, the last day the licence holds; null for none on record. */
  licenceExpiry: string | null
}

/** One driver of the project, read for the licence rule, or a 400 at `path`. */
export async function findDriver(tx: Tx, scope: Scope, id: string, path = "driverId"): Promise<DriverRow> {
  const [row] = await tx
    .select({ id: driver.id, name: driver.name, licenceClass: driver.licenceClass, licenceExpiry: driver.licenceExpiry })
    .from(driver)
    .where(and(eq(driver.companyId, scope.companyId), eq(driver.projectId, scope.projectId), eq(driver.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path, message: NOT_A_DRIVER }])
  return row as DriverRow
}

/** A depot a body names: the project's, since a route departs from a yard of the project it runs in. A null or absent id names nothing. */
export async function requireDepot(tx: Tx, scope: Scope, id: string | null | undefined, path = "depotId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, depot, { companyId: scope.companyId, id, also: eq(depot.projectId, scope.projectId) }, { path, message: NOT_A_DEPOT })
}

/** An unloading station a body names: the company's, since every project unloads at the same plant. A null or absent id names nothing. */
export async function requireUnloadingStation(tx: Tx, companyId: string, id: string | null | undefined, path = "unloadingStationId"): Promise<void> {
  if (id == null) return
  await requireRow(tx, unloadingStation, { companyId, id }, { path, message: NOT_AN_UNLOADING_STATION })
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
