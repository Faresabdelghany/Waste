// The periods a driver is away or a vehicle out of use (O6 of #290) touching
// a span of days, as a statement reads them: what a command naming a crew
// afresh and generation's run judge their days against
// (@waste/domain/resources/availability). One read per family over every
// owner asked, under both fences — the one project a driver's or a vehicle's
// periods live in — earliest first, each period with whose it is and the name
// a sentence or a warning gives them: a driver's name, a vehicle's label.
// `validOver` is the domain's `overlapsDays` in SQL, which validity.test.ts
// holds it to.
import type { AwayPeriod } from "@waste/domain/resources/availability"
import { and, asc, eq, inArray, ne } from "drizzle-orm"

import type { Tx } from "../client"
import { vehicleLabelOf } from "../commands/fleet-fit"
import { driverAbsence, vehicleUnavailability } from "../schema/availability"
import { driver, vehicle } from "../schema/fleet"
import type { Scope } from "./project-clock"
import { validOver } from "./valid-on"

/** Whose periods a read asks for: a driver's absences or a vehicle's (or a trailer's) unavailability. */
export type AwayFamily = "driver" | "vehicle"

/** A period as a read answers it: its id, whose it is and the name they are told by, beside the period itself. */
export type AwayRow = AwayPeriod & { id: string; ownerId: string; name: string }

/**
 * The periods of the owners touching `period` (half-open, an open end
 * reaching every later day), earliest first, in the scope's company and
 * project. `except` leaves out the row a patch moves.
 */
export async function awayPeriodsOver(tx: Tx, family: AwayFamily, scope: Scope, ownerIds: readonly string[], period: { validFrom: string; validTo: string | null }, except?: string): Promise<AwayRow[]> {
  const owners = [...new Set(ownerIds)]
  if (owners.length === 0) return []
  if (family === "driver") {
    return tx
      .select({ id: driverAbsence.id, ownerId: driverAbsence.driverId, validFrom: driverAbsence.validFrom, validTo: driverAbsence.validTo, reason: driverAbsence.reason, name: driver.name })
      .from(driverAbsence)
      .innerJoin(driver, and(eq(driver.companyId, driverAbsence.companyId), eq(driver.id, driverAbsence.driverId)))
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
    .select({ id: vehicleUnavailability.id, ownerId: vehicleUnavailability.vehicleId, validFrom: vehicleUnavailability.validFrom, validTo: vehicleUnavailability.validTo, reason: vehicleUnavailability.reason, name: vehicleLabelOf(vehicle) })
    .from(vehicleUnavailability)
    .innerJoin(vehicle, and(eq(vehicle.companyId, vehicleUnavailability.companyId), eq(vehicle.id, vehicleUnavailability.vehicleId)))
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
