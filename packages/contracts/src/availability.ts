// When a driver or a vehicle is not there, on the wire (O6 of #290): a
// driver's absence and a vehicle's unavailability, each a period over days
// (ADR-0005) — `validFrom` the first day away, `validTo` the first day back,
// null while the return is not known — with why, and a free note. A vehicle
// here is either kind, a powered vehicle or a trailer. A create names its
// driver or vehicle; a patch moves the period, the reason or the note and
// never whose it is. One period of a driver, or of a vehicle, covers a day
// (the database's exclusion, a 409 naming the period already there).
// Recording one is never refused for the work planned on its days; the
// commands that name the driver or the vehicle afresh read these.
import { DRIVER_ABSENCE_REASONS, VEHICLE_UNAVAILABILITY_REASONS } from "@waste/domain/resources/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { dayWindow, ProjectScopedListQuery } from "./queries"
import { stamped } from "./resource"
import { Paragraph } from "./text"
import { effectiveDated, effectiveDatedBodies } from "./validity"

export const DriverAbsenceReason = z.enum(DRIVER_ABSENCE_REASONS)
export type DriverAbsenceReason = z.infer<typeof DriverAbsenceReason>

/** Why a vehicle or a trailer is out of use. */
export const VehicleUnavailabilityReason = z.enum(VEHICLE_UNAVAILABILITY_REASONS)
export type VehicleUnavailabilityReason = z.infer<typeof VehicleUnavailabilityReason>

export const DriverAbsence = effectiveDated(z.object({ ...stamped, projectId: Id, note: Paragraph.nullable(), driverId: Id, reason: DriverAbsenceReason }))
export type DriverAbsence = z.infer<typeof DriverAbsence>

export const VehicleUnavailability = effectiveDated(z.object({ ...stamped, projectId: Id, note: Paragraph.nullable(), vehicleId: Id, reason: VehicleUnavailabilityReason }))
export type VehicleUnavailability = z.infer<typeof VehicleUnavailability>

/** `POST /driver-absences`: the driver, why, a note, the first day away and the first day back (absent while not known). A patch moves the period, the reason or the note; never whose it is. */
const driverAbsenceBodies = effectiveDatedBodies({ driverId: Id, reason: DriverAbsenceReason, note: Paragraph.nullable().optional() }, { createOnly: { driverId: true } })

export const DriverAbsenceCreate = driverAbsenceBodies.create
export type DriverAbsenceCreate = z.infer<typeof DriverAbsenceCreate>

/** `PATCH /driver-absences/:id`. */
export const DriverAbsencePatch = driverAbsenceBodies.patch
export type DriverAbsencePatch = z.infer<typeof DriverAbsencePatch>

/** `POST /vehicle-unavailability`: the vehicle or trailer, why, a note, and the period. */
const vehicleUnavailabilityBodies = effectiveDatedBodies({ vehicleId: Id, reason: VehicleUnavailabilityReason, note: Paragraph.nullable().optional() }, { createOnly: { vehicleId: true } })

export const VehicleUnavailabilityCreate = vehicleUnavailabilityBodies.create
export type VehicleUnavailabilityCreate = z.infer<typeof VehicleUnavailabilityCreate>

/** `PATCH /vehicle-unavailability/:id`. */
export const VehicleUnavailabilityPatch = vehicleUnavailabilityBodies.patch
export type VehicleUnavailabilityPatch = z.infer<typeof VehicleUnavailabilityPatch>

/** A page of absences: one project's, one driver's, the ones touching a window of days. */
export const DriverAbsenceListQuery = dayWindow(ProjectScopedListQuery.extend({ driverId: Id.optional() }))
export type DriverAbsenceListQuery = z.infer<typeof DriverAbsenceListQuery>

/** A page of unavailability: one project's, one vehicle's, the periods touching a window of days. */
export const VehicleUnavailabilityListQuery = dayWindow(ProjectScopedListQuery.extend({ vehicleId: Id.optional() }))
export type VehicleUnavailabilityListQuery = z.infer<typeof VehicleUnavailabilityListQuery>
