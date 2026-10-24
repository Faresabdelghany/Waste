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

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { dayWindowIsOrdered, dayWindowOrdered, ProjectScopedListQuery } from "./queries"
import { changesSomething, somethingToChange, stamped } from "./resource"
import { Paragraph } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

/** Why a driver is away. */
export const DriverAbsenceReason = z.enum(DRIVER_ABSENCE_REASONS)
export type DriverAbsenceReason = z.infer<typeof DriverAbsenceReason>

/** Why a vehicle or a trailer is out of use. */
export const VehicleUnavailabilityReason = z.enum(VEHICLE_UNAVAILABILITY_REASONS)
export type VehicleUnavailabilityReason = z.infer<typeof VehicleUnavailabilityReason>

/** The period's own fields, beside whose it is. */
const periodFields = { ...stamped, projectId: Id, ...Validity.shape, note: Paragraph.nullable() }

/** A driver's absence: the days the driver is away, and why. */
export const DriverAbsence = z.object({ ...periodFields, driverId: Id, reason: DriverAbsenceReason }).refine(validityOrdered, endsAfterItStarts)
export type DriverAbsence = z.infer<typeof DriverAbsence>

/** A vehicle's unavailability: the days the vehicle or trailer is out of use, and why. */
export const VehicleUnavailability = z.object({ ...periodFields, vehicleId: Id, reason: VehicleUnavailabilityReason }).refine(validityOrdered, endsAfterItStarts)
export type VehicleUnavailability = z.infer<typeof VehicleUnavailability>

/** `POST /driver-absences`: the driver, the first day away and the first day back (absent while not known), why, and a note. */
export const DriverAbsenceCreate = z
  .strictObject({ driverId: Id, ...ValidityCreate, reason: DriverAbsenceReason, note: Paragraph.nullable().optional() })
  .refine(validityOrdered, endsAfterItStarts)
export type DriverAbsenceCreate = z.infer<typeof DriverAbsenceCreate>

/** `POST /vehicle-unavailability`: the vehicle or trailer, the period, why, and a note. */
export const VehicleUnavailabilityCreate = z
  .strictObject({ vehicleId: Id, ...ValidityCreate, reason: VehicleUnavailabilityReason, note: Paragraph.nullable().optional() })
  .refine(validityOrdered, endsAfterItStarts)
export type VehicleUnavailabilityCreate = z.infer<typeof VehicleUnavailabilityCreate>

/** What a patch may move: the period, the reason, the note; never whose it is. */
const patchFields = { validFrom: IsoDate.optional(), validTo: IsoDate.nullable().optional(), note: Paragraph.nullable().optional() }

/** `PATCH /driver-absences/:id`. */
export const DriverAbsencePatch = z
  .strictObject({ ...patchFields, reason: DriverAbsenceReason.optional() })
  .refine(changesSomething, somethingToChange)
  .refine(validityOrdered, endsAfterItStarts)
export type DriverAbsencePatch = z.infer<typeof DriverAbsencePatch>

/** `PATCH /vehicle-unavailability/:id`. */
export const VehicleUnavailabilityPatch = z
  .strictObject({ ...patchFields, reason: VehicleUnavailabilityReason.optional() })
  .refine(changesSomething, somethingToChange)
  .refine(validityOrdered, endsAfterItStarts)
export type VehicleUnavailabilityPatch = z.infer<typeof VehicleUnavailabilityPatch>

/** The days a list is asked over: `from` and `to`, both inclusive; a period touching any of them is listed. */
const touching = { from: IsoDate.optional(), to: IsoDate.optional() }

/** A page of absences: one project's, one driver's, the ones touching a window of days. */
export const DriverAbsenceListQuery = ProjectScopedListQuery.extend({ driverId: Id.optional(), ...touching }).refine(dayWindowOrdered, dayWindowIsOrdered)
export type DriverAbsenceListQuery = z.infer<typeof DriverAbsenceListQuery>

/** A page of unavailability: one project's, one vehicle's, the periods touching a window of days. */
export const VehicleUnavailabilityListQuery = ProjectScopedListQuery.extend({ vehicleId: Id.optional(), ...touching }).refine(dayWindowOrdered, dayWindowIsOrdered)
export type VehicleUnavailabilityListQuery = z.infer<typeof VehicleUnavailabilityListQuery>
