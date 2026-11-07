// Resources' rows as the routes that name them read them (Issue #101, slice
// 6): a vehicle of one kind and a driver. Two callers
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
// A Service Provider's account crews the routes it runs with its own fleet
// (#291 slice 23b): `ownedBy` holds a row read for it to its provider as
// well, refused in the provider's words (`notOwnFleet`), at the same field.
import type { Tx } from "@waste/db/client"
import { driver, vehicle } from "@waste/db/schema/fleet"
import type { DriverStatus, LicenceClass, VehicleKind, VehicleStatus } from "@waste/domain/resources/vocabulary"
import { and, eq } from "drizzle-orm"

import { notOwnFleet } from "../auth/provider"
import { invalidRequest } from "../problem"
import { NOT_A_DRIVER, notAVehicleOf, type Scope } from "./references"

/** The provider a provider's account's fleet must belong to, and the name its sentences call it by. */
export type OwnedBy = { serviceProviderId: string; provider: string }

/** What a sentence and a licence check read of a vehicle. */
export type VehicleRow = {
  id: string
  registration: string
  callsign: string | null
  kind: VehicleKind
  status: VehicleStatus
  requiredLicenceClass: LicenceClass
  /** Its `vehicle_type`: what a group's stop rule asks for (O7 of #290). */
  vehicleTypeId: string
}

/** The columns a `VehicleRow` is read from. */
export const vehicleColumns = {
  id: vehicle.id,
  registration: vehicle.registration,
  callsign: vehicle.callsign,
  kind: vehicle.kind,
  status: vehicle.status,
  requiredLicenceClass: vehicle.requiredLicenceClass,
  vehicleTypeId: vehicle.vehicleTypeId,
}

/**
 * One vehicle of the project and of the kind asked for, read for what the
 * caller does with it next, or a 400 at `path` in the kind's words. The
 * project comes from the scope and never from the body: a vehicle of another
 * project is a vehicle that is not here.
 */
export async function findVehicle(tx: Tx, scope: Scope, id: string, kind: VehicleKind, path: string, ownedBy?: OwnedBy): Promise<VehicleRow> {
  const [row] = await tx
    .select(vehicleColumns)
    .from(vehicle)
    .where(
      and(
        eq(vehicle.companyId, scope.companyId),
        eq(vehicle.projectId, scope.projectId),
        eq(vehicle.id, id),
        eq(vehicle.kind, kind),
        ownedBy === undefined ? undefined : eq(vehicle.serviceProviderId, ownedBy.serviceProviderId),
      ),
    )
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path, message: ownedBy === undefined ? notAVehicleOf(kind) : notOwnFleet(kind === "trailer" ? "trailer" : "vehicle", ownedBy.provider) }])
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
export async function findDriver(tx: Tx, scope: Scope, id: string, path = "driverId", ownedBy?: OwnedBy): Promise<DriverRow> {
  const [row] = await tx
    .select(driverColumns)
    .from(driver)
    .where(
      and(
        eq(driver.companyId, scope.companyId),
        eq(driver.projectId, scope.projectId),
        eq(driver.id, id),
        ownedBy === undefined ? undefined : eq(driver.serviceProviderId, ownedBy.serviceProviderId),
      ),
    )
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path, message: ownedBy === undefined ? NOT_A_DRIVER : notOwnFleet("driver", ownedBy.provider) }])
  return row as DriverRow
}
