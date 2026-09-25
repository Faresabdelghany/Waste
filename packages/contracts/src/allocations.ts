// Vehicle allocations on the wire (Issue #101, ADR-0005 over instants): the
// current reservation, the four commands that move it, and the event each
// appends. An allocation is never edited by a form: `allocate`, `change`,
// `confirm` and `release` each append an event carrying the snapshot the
// allocation then had and a reason, so the row is what the database's
// exclusion constraints hold — one live reservation of a vehicle, of a driver,
// of a trailer at a time — and the events are the ledger nobody rewrites.
// There is no PATCH.
//
// The window is two instants on a clock and not an effective-dated period:
// two routes a day on one vehicle is ordinary and a reservation without an
// end is not a plan, so both bounds are `IsoDateTime` and given, and the end
// comes after the start, strictly (`WINDOW_ENDS_AFTER_IT_STARTS`), since an
// empty window is an empty range the constraint would not even see. Comparing
// two RFC 3339 instants is comparing their epoch milliseconds, parsed once in
// the refine; a half-seen pair — a change giving one bound — is not judged,
// and the route holds the merged row in the same words.
//
// An allocation names no work: no route (Execution's) and no collection group
// (Planning's, which references Resources and not the other way); its purpose
// is its `note`, and the recurring reservation of a vehicle for a group is
// the group's own `vehicleId`. A create may be `planned` or `confirmed` and
// never `released`, which is what `release` is for; a released allocation
// does not change.
import * as z from "zod"

import { IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { recorded, somethingToChange, stamped } from "./resource"
import { AllocationAction, AllocationStatus } from "./resources"
import { Paragraph } from "./text"

/** A payload in whole kilograms, above zero. */
const Capacity = z.int().positive()

/** What a backwards or empty window is told, at the end, the bound a caller can move. */
export const WINDOW_ENDS_AFTER_IT_STARTS = "plannedTo is the instant the reservation ends, so it comes after plannedFrom"
export const windowEndsAfterItStarts = { message: WINDOW_ENDS_AFTER_IT_STARTS, path: ["plannedTo"] }

/** The end comes after the start, strictly; a half-seen pair is not judged. */
export function windowOrdered(value: { plannedFrom?: string; plannedTo?: string }): boolean {
  if (value.plannedFrom === undefined || value.plannedTo === undefined) return true
  return Date.parse(value.plannedTo) > Date.parse(value.plannedFrom)
}

export const VehicleAllocation = z
  .object({
    ...stamped,
    projectId: Id,
    vehicleId: Id,
    driverId: Id.nullable(),
    /** A vehicle of kind trailer. */
    trailerId: Id.nullable(),
    depotId: Id.nullable(),
    /** What it is planned to carry. */
    wasteFractionId: Id.nullable(),
    requiredCapacityKg: Capacity.nullable(),
    plannedFrom: IsoDateTime,
    plannedTo: IsoDateTime,
    status: AllocationStatus,
    note: Paragraph.nullable(),
  })
  .refine(windowOrdered, windowEndsAfterItStarts)
export type VehicleAllocation = z.infer<typeof VehicleAllocation>

/** `POST /vehicle-allocations`: planned, or confirmed straight away; never released. */
export const VehicleAllocationCreate = z
  .strictObject({
    projectId: Id,
    vehicleId: Id,
    driverId: Id.nullable().optional(),
    trailerId: Id.nullable().optional(),
    depotId: Id.nullable().optional(),
    wasteFractionId: Id.nullable().optional(),
    requiredCapacityKg: Capacity.nullable().optional(),
    plannedFrom: IsoDateTime,
    plannedTo: IsoDateTime,
    status: z.enum(["planned", "confirmed"]).default("planned").describe("Defaults to planned when absent; confirmed blocks other planners' checks, released is a command of its own."),
    note: Paragraph.nullable().optional(),
  })
  .refine(windowOrdered, windowEndsAfterItStarts)
export type VehicleAllocationCreate = z.infer<typeof VehicleAllocationCreate>

/** A change changes something beside its reason. */
const changesSomethingBesideTheReason = (body: object): boolean => Object.keys(body).some((key) => key !== "reason")

/** `POST /vehicle-allocations/:id/change`: every field a caller may move, and the reason, which is the event's and not the row's. */
export const VehicleAllocationChange = z
  .strictObject({
    vehicleId: Id.optional(),
    driverId: Id.nullable().optional(),
    trailerId: Id.nullable().optional(),
    depotId: Id.nullable().optional(),
    wasteFractionId: Id.nullable().optional(),
    requiredCapacityKg: Capacity.nullable().optional(),
    plannedFrom: IsoDateTime.optional(),
    plannedTo: IsoDateTime.optional(),
    note: Paragraph.nullable().optional(),
    reason: Paragraph,
  })
  .refine(changesSomethingBesideTheReason, somethingToChange)
  .refine(windowOrdered, windowEndsAfterItStarts)
export type VehicleAllocationChange = z.infer<typeof VehicleAllocationChange>

/** `POST /vehicle-allocations/:id/release`: the window freed, with a reason. */
export const VehicleAllocationRelease = z.strictObject({ reason: Paragraph })
export type VehicleAllocationRelease = z.infer<typeof VehicleAllocationRelease>

/** `POST /vehicle-allocations/:id/confirm`: nothing to say; a body with a member is refused. */
export const VehicleAllocationConfirm = z.strictObject({})
export type VehicleAllocationConfirm = z.infer<typeof VehicleAllocationConfirm>

/** One event of an allocation's history: the action, the status after it, the snapshot it left, and who did it. */
export const VehicleAllocationEvent = z.object({
  ...recorded,
  projectId: Id,
  vehicleAllocationId: Id,
  action: AllocationAction,
  /** The allocation's status after the action. */
  status: AllocationStatus,
  vehicleId: Id,
  driverId: Id.nullable(),
  trailerId: Id.nullable(),
  depotId: Id.nullable(),
  plannedFrom: IsoDateTime,
  plannedTo: IsoDateTime,
  reason: Paragraph.nullable(),
  recordedBy: Id,
})
export type VehicleAllocationEvent = z.infer<typeof VehicleAllocationEvent>

/** What a query giving one end of the overlapping window is told, at the other. */
export const BOTH_ENDS_OF_THE_WINDOW = "Give both overlappingFrom and overlappingTo or neither"
const bothEndsOfTheWindow = { message: BOTH_ENDS_OF_THE_WINDOW, path: ["overlappingTo"] }

/** What a query whose overlapping window runs backwards is told. */
export const OVERLAPPING_WINDOW_ORDERED = "overlappingTo is the end of the window, so it comes after overlappingFrom"
const overlappingWindowOrdered = { message: OVERLAPPING_WINDOW_ORDERED, path: ["overlappingTo"] }

/**
 * A page of allocations: one project's, one vehicle's, one driver's, one
 * trailer's, of one status, and the ones whose window touches a window —
 * `overlappingFrom` and `overlappingTo`, two query parameters since a query
 * string carries no nested object, both or neither, the read Planning's
 * Issue #11 check makes.
 */
export const VehicleAllocationListQuery = ProjectScopedListQuery.extend({
  vehicleId: Id.optional(),
  driverId: Id.optional(),
  trailerId: Id.optional(),
  status: AllocationStatus.optional(),
  overlappingFrom: IsoDateTime.optional(),
  overlappingTo: IsoDateTime.optional(),
})
  .refine((query) => (query.overlappingFrom === undefined) === (query.overlappingTo === undefined), bothEndsOfTheWindow)
  .refine((query) => windowOrdered({ plannedFrom: query.overlappingFrom, plannedTo: query.overlappingTo }), overlappingWindowOrdered)
export type VehicleAllocationListQuery = z.infer<typeof VehicleAllocationListQuery>
