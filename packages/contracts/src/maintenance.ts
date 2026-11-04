// Vehicle maintenance on the wire (O20 of #290): a vehicle's maintenance
// plans — service intervals by days, kilometres or engine hours, counted from
// the last service — each read with where it stands (`due`), and the
// Maintenance Orders the office opens and completes to do the service.
//
// A plan names at least one interval, and a distance or hours interval the
// reading it counts from (@waste/domain/resources/maintenance, `planIssue`),
// which the create holds here and the patch, which may move either half, the
// API holds over the merged row. Completing an order of a plan is the service
// done: its day and readings become the plan's baseline. A plan is retired,
// never deleted, since its orders name it.
import { MAINTENANCE_DUE_STATES, MAINTENANCE_INTERVAL_MAX, planIssue } from "@waste/domain/resources/maintenance"
import { MAINTENANCE_ORDER_STATUSES, MAINTENANCE_PLAN_STATUSES } from "@waste/domain/resources/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, NonNegativeInt, PositiveInt, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"

export const MaintenancePlanStatus = z.enum(MAINTENANCE_PLAN_STATUSES)
export type MaintenancePlanStatus = z.infer<typeof MaintenancePlanStatus>
export const MaintenanceOrderStatus = z.enum(MAINTENANCE_ORDER_STATUSES)
export type MaintenanceOrderStatus = z.infer<typeof MaintenanceOrderStatus>
export const MaintenanceDueState = z.enum(MAINTENANCE_DUE_STATES)
export type MaintenanceDueState = z.infer<typeof MaintenanceDueState>

const IntervalDays = PositiveInt.max(MAINTENANCE_INTERVAL_MAX.days)
const IntervalKm = PositiveInt.max(MAINTENANCE_INTERVAL_MAX.km)
const IntervalHours = PositiveInt.max(MAINTENANCE_INTERVAL_MAX.hours)

/** Where a plan stands on the project's day, against the vehicle's latest readings. */
export const MaintenanceDue = z.object({
  state: MaintenanceDueState,
  nextDueOn: IsoDate.nullable(),
  nextDueKm: NonNegativeInt.nullable(),
  nextDueHours: NonNegativeInt.nullable(),
  /** The readings it was judged on: the latest a pre-trip check read, else the last service's. */
  odometerKm: NonNegativeInt.nullable(),
  engineHours: NonNegativeInt.nullable(),
})
export type MaintenanceDue = z.infer<typeof MaintenanceDue>

export const MaintenancePlan = z.object({
  ...stamped,
  projectId: Id,
  vehicleId: Id,
  /** What the service is: `Annual service`, `Brake inspection`. */
  name: Label,
  intervalDays: IntervalDays.nullable(),
  intervalKm: IntervalKm.nullable(),
  intervalHours: IntervalHours.nullable(),
  /** The last service: its day, and the odometer and engine hours then. */
  lastDoneOn: IsoDate,
  lastDoneKm: NonNegativeInt.nullable(),
  lastDoneHours: NonNegativeInt.nullable(),
  status: MaintenancePlanStatus,
  due: MaintenanceDue,
})
export type MaintenancePlan = z.infer<typeof MaintenancePlan>

/** The issue `planIssue` finds, as a refine's. */
const holdsTheRule = (body: { intervalDays?: number | null; intervalKm?: number | null; intervalHours?: number | null; lastDoneKm?: number | null; lastDoneHours?: number | null }, context: z.RefinementCtx) => {
  const issue = planIssue({ intervalDays: body.intervalDays ?? null, intervalKm: body.intervalKm ?? null, intervalHours: body.intervalHours ?? null, lastDoneKm: body.lastDoneKm ?? null, lastDoneHours: body.lastDoneHours ?? null })
  if (issue !== undefined) context.addIssue({ code: "custom", message: issue.message, path: [issue.path] })
}

export const MaintenancePlanCreate = z
  .strictObject({
    vehicleId: Id,
    name: Label,
    intervalDays: IntervalDays.optional(),
    intervalKm: IntervalKm.optional(),
    intervalHours: IntervalHours.optional(),
    lastDoneOn: IsoDate.describe("The day the service was last done; the date interval counts from it."),
    lastDoneKm: NonNegativeInt.optional().describe("The odometer then, in whole kilometres; required with a distance interval."),
    lastDoneHours: NonNegativeInt.optional().describe("The engine hours then; required with an hours interval."),
  })
  .superRefine(holdsTheRule)
export type MaintenancePlanCreate = z.infer<typeof MaintenancePlanCreate>

/** The name, the intervals and the baseline, each nullable but the name and the day, and the status; the API holds the merged row to the rule. */
export const MaintenancePlanPatch = z
  .strictObject({
    name: Label.optional(),
    intervalDays: IntervalDays.nullable().optional(),
    intervalKm: IntervalKm.nullable().optional(),
    intervalHours: IntervalHours.nullable().optional(),
    lastDoneOn: IsoDate.optional(),
    lastDoneKm: NonNegativeInt.nullable().optional(),
    lastDoneHours: NonNegativeInt.nullable().optional(),
    status: MaintenancePlanStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type MaintenancePlanPatch = z.infer<typeof MaintenancePlanPatch>

export const MaintenancePlanListQuery = ProjectScopedListQuery.extend({ vehicleId: Id.optional(), status: MaintenancePlanStatus.optional() })
export type MaintenancePlanListQuery = z.infer<typeof MaintenancePlanListQuery>

export const MaintenanceOrder = z.object({
  ...stamped,
  projectId: Id,
  vehicleId: Id,
  /** The plan it serves, or null for a one-off: a repair, a defect mended. */
  planId: Id.nullable(),
  title: Label,
  status: MaintenanceOrderStatus,
  /** The day it is planned for, where the office gave one. */
  dueOn: IsoDate.nullable(),
  note: Paragraph.nullable(),
  /** The day the service was done, and the readings then: given exactly when completed. */
  completedOn: IsoDate.nullable(),
  odometerKm: NonNegativeInt.nullable(),
  engineHours: NonNegativeInt.nullable(),
  /** What was done, or why it was called off. */
  closingNote: Paragraph.nullable(),
  closedAt: IsoDateTime.nullable(),
})
export type MaintenanceOrder = z.infer<typeof MaintenanceOrder>

/** What an order of no plan without a title is told. */
export const NAME_THE_ORDER = "Say what the order is for, or name the plan it serves"

export const MaintenanceOrderCreate = z
  .strictObject({
    vehicleId: Id,
    planId: Id.optional().describe("The plan the order serves; completing it is the plan's service done."),
    title: Label.optional().describe("What the order is for; the plan's name where absent."),
    dueOn: IsoDate.optional(),
    note: Paragraph.optional(),
  })
  .refine((body) => body.planId !== undefined || body.title !== undefined, { message: NAME_THE_ORDER, path: ["title"] })
export type MaintenanceOrderCreate = z.infer<typeof MaintenanceOrderCreate>

export const MaintenanceOrderComplete = z.strictObject({
  completedOn: IsoDate,
  odometerKm: NonNegativeInt.optional(),
  engineHours: NonNegativeInt.optional(),
  note: Paragraph.optional(),
})
export type MaintenanceOrderComplete = z.infer<typeof MaintenanceOrderComplete>

export const MaintenanceOrderCancel = z.strictObject({ note: Paragraph.optional() })
export type MaintenanceOrderCancel = z.infer<typeof MaintenanceOrderCancel>

export const MaintenanceOrderListQuery = ProjectScopedListQuery.extend({ vehicleId: Id.optional(), planId: Id.optional(), status: MaintenanceOrderStatus.optional() })
export type MaintenanceOrderListQuery = z.infer<typeof MaintenanceOrderListQuery>
