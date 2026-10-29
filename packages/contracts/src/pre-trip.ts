// Pre-trip inspection on the wire (O13 of #290): a vehicle type's checklist,
// the check a driver's `pre-trip-check` appends, and the Vehicle Defects a
// check finds.
//
// The checklist is the vehicle type's, read on the `VehicleType` and replaced
// whole through `PUT /vehicle-types/:id/checklist`, the way its container
// types and its consumption are: an item is a label and whether a defect of
// it takes the vehicle out of service (`critical`), in the order the body
// gives them. The server mints the items' ids each time the set is replaced,
// since a check keeps a copy of each item it answered and never names the
// list's row again.
//
// A `PreTripCheck` is a ledger row with the command's id: the route it was
// made for, the vehicle or trailer, the driver, the instant on the device's
// clock, what each item came to — its label and weight copied beside the
// answer — and the odometer and the engine hours where the driver read them.
// A `VehicleDefect` is one failed item, open until the office marks it
// resolved, with the ticket the check opened for its defects.
import { CHECKLIST_MAX } from "@waste/domain/resources/pre-trip"
import { VEHICLE_DEFECT_STATUSES } from "@waste/domain/resources/vocabulary"
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { FlatPoint } from "./geojson"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { eachOnce, eachOnceSentence, NonNegativeInt, PositiveInt, recorded, stamped } from "./resource"
import { Label, Paragraph } from "./text"

export { CHECKLIST_MAX }

/** One item of a vehicle type's checklist as the type carries it: its id, what the driver looks at, and whether a defect of it grounds the vehicle. */
export const ChecklistItem = z.object({
  id: Id,
  label: Label,
  critical: z.boolean(),
})
export type ChecklistItem = z.infer<typeof ChecklistItem>

export const EACH_ITEM_ONCE = eachOnceSentence("checklist item", "a driver answers each once")

/** `PUT /vehicle-types/:id/checklist`: the whole list in the order a driver walks it, replacing what the type had; an empty list asks nothing of a check. */
export const VehicleTypeChecklistSet = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          label: Label,
          critical: z.boolean().default(true).describe("Whether a defect of the item sets the vehicle to maintenance; true when absent."),
        }),
      )
      .max(CHECKLIST_MAX),
  })
  .refine((body) => eachOnce(body.items, (item) => item.label.trim().toLowerCase()), { message: EACH_ITEM_ONCE, path: ["items"] })
export type VehicleTypeChecklistSet = z.infer<typeof VehicleTypeChecklistSet>

/** One answer of a `pre-trip-check`: the item by its id, whether it passed, and what the driver saw where it did not. */
export const CheckAnswer = z.strictObject({
  itemId: Id,
  passed: z.boolean(),
  note: Paragraph.optional(),
})
export type CheckAnswer = z.infer<typeof CheckAnswer>

export const EACH_ANSWER_ONCE = eachOnceSentence("checklist item", "a check answers each once")

/** The body of a `pre-trip-check`: the vehicle or trailer, every item of its type's checklist answered once, and the readings the driver took. */
export const PreTripCheckBody = {
  vehicleId: Id,
  items: z
    .array(CheckAnswer)
    .max(CHECKLIST_MAX)
    .refine((items) => eachOnce(items, (item) => item.itemId), { message: EACH_ANSWER_ONCE }),
  /** The odometer in whole kilometres, where the driver read it. */
  odometerKm: NonNegativeInt.optional(),
  /** The engine hours in whole hours, where the vehicle counts them. */
  engineHours: NonNegativeInt.optional(),
}

/** One answer as the check keeps it: the item's label and weight copied beside what the driver said. */
export const CheckedItem = z.object({
  itemId: Id,
  label: Label,
  critical: z.boolean(),
  passed: z.boolean(),
  note: Paragraph.nullable(),
})
export type CheckedItem = z.infer<typeof CheckedItem>

/** A pre-trip check: the ledger row a driver's `pre-trip-check` appended, under the command's id. */
export const PreTripCheck = z.object({
  ...recorded,
  projectId: Id,
  routeId: Id,
  vehicleId: Id,
  driverId: Id,
  /** The device's clock. */
  occurredAt: IsoDateTime,
  items: z.array(CheckedItem),
  /** How many items failed: the defects the check found. */
  defectCount: NonNegativeInt,
  odometerKm: NonNegativeInt.nullable(),
  engineHours: NonNegativeInt.nullable(),
  location: FlatPoint.nullable(),
  locationAccuracyM: PositiveInt.nullable(),
})
export type PreTripCheck = z.infer<typeof PreTripCheck>

export const VehicleDefectStatus = z.enum(VEHICLE_DEFECT_STATUSES)
export type VehicleDefectStatus = z.infer<typeof VehicleDefectStatus>

/** A Vehicle Defect: one failed item of a check, open until the office marks it resolved. */
export const VehicleDefect = z.object({
  ...stamped,
  projectId: Id,
  vehicleId: Id,
  preTripCheckId: Id,
  /** The item as the check answered it. */
  label: Label,
  critical: z.boolean(),
  note: Paragraph.nullable(),
  /** When the driver found it: the check's instant. */
  foundAt: IsoDateTime,
  status: VehicleDefectStatus,
  /** The ticket the check opened for its defects. */
  ticketId: Id.nullable(),
  resolvedAt: IsoDateTime.nullable(),
  resolutionNote: Paragraph.nullable(),
})
export type VehicleDefect = z.infer<typeof VehicleDefect>

/** `POST /vehicle-defects/:id/resolve`: what the office did about it, where it says. */
export const VehicleDefectResolve = z.strictObject({ note: Paragraph.optional() })
export type VehicleDefectResolve = z.infer<typeof VehicleDefectResolve>

/** `GET /pre-trip-checks`: a page, narrowed to a vehicle's or a route's. */
export const PreTripCheckListQuery = ProjectScopedListQuery.extend({ vehicleId: Id.optional(), routeId: Id.optional() })
export type PreTripCheckListQuery = z.infer<typeof PreTripCheckListQuery>

/** `GET /vehicle-defects`: a page, narrowed to a vehicle's, a status, or both. */
export const VehicleDefectListQuery = ProjectScopedListQuery.extend({ vehicleId: Id.optional(), status: VehicleDefectStatus.optional() })
export type VehicleDefectListQuery = z.infer<typeof VehicleDefectListQuery>
