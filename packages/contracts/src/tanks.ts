// The tank register on the wire (M11 of #293): a Property's septic tanks,
// holding tanks, small treatment plants and grease separators, each the
// Container that stands for it in the plan, and the office's inspections of
// them. Every rule of resource.ts holds: an installation spreads `stamped`, a
// write body is strict, a patch is every field optional and at least one
// given; its Property and its Container are set once. Its period is
// half-open (ADR-0005), and a container stands for one tank at a time.
//
// An installation's emptying falls due its interval in months after the last
// one (the domain's due-from-last cadence, route-schemes/due-from-last.ts):
// the read answers the last emptying — its container's latest completed stop,
// with the litres the driver recorded there — and the day the next is due,
// reckoned from that stop or, before there is one, from `lastEmptiedOn`, the
// register's word for an emptying before the platform; null when the tank was
// never emptied, which is due now.
//
// An inspection is a ledger row: appended under the installation, by the
// account that recorded it, never rewritten.
import { TANK_INSPECTION_OUTCOMES, TANK_KINDS, TANK_OUTLETS } from "@waste/domain/registry/vocabulary"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, PositiveInt, recorded, somethingToChange, stamped } from "./resource"
import { Paragraph } from "./text"
import { endsAfterItStarts, validityOrdered, Validity } from "./validity"

export const TankKind = z.enum(TANK_KINDS)
export type TankKind = z.infer<typeof TankKind>
export const TankOutlet = z.enum(TANK_OUTLETS)
export type TankOutlet = z.infer<typeof TankOutlet>
export const TankInspectionOutcome = z.enum(TANK_INSPECTION_OUTCOMES)
export type TankInspectionOutcome = z.infer<typeof TankInspectionOutcome>

/** The longest interval a register takes between emptyings: ten years, as the database's check. */
export const TANK_INTERVAL_MONTHS_MAX = 120

/** Whole months between emptyings: 12 for a home, 24 for a holiday home, as the regulation says. */
export const EmptyingIntervalMonths = z.int().min(1).max(TANK_INTERVAL_MONTHS_MAX)

/** A tank's emptying as its container's latest completed stop says: the day its route ran, the stop, and the litres the driver recorded, if any. */
export const TankEmptying = z.object({ on: IsoDate, pickupId: Id, volumeLitres: PositiveInt.nullable() })
export type TankEmptying = z.infer<typeof TankEmptying>

export const TankInstallation = z.object({
  ...stamped,
  projectId: Id,
  ...Validity.shape,
  /** The Property it serves; set once. */
  propertyId: Id,
  /** The Container that stands for it in the plan; set once. */
  containerId: Id,
  kind: TankKind,
  /** What it holds, whole litres. */
  volumeLitres: PositiveInt,
  outlet: TankOutlet,
  emptyingIntervalMonths: EmptyingIntervalMonths,
  /** The last emptying before the platform knew the tank, as the register says; a completed stop is read before it. */
  lastEmptiedOn: IsoDate.nullable(),
  notes: Paragraph.nullable(),
  /** Its container's latest completed stop; null before there is one. */
  lastEmptying: TankEmptying.nullable(),
  /** The day the next emptying falls due, from the last one; null for a tank never emptied, which is due now. */
  dueOn: IsoDate.nullable(),
})
export type TankInstallation = z.infer<typeof TankInstallation>

export const TankInstallationCreate = z
  .strictObject({
    propertyId: Id,
    containerId: Id,
    kind: TankKind,
    volumeLitres: PositiveInt,
    outlet: TankOutlet,
    emptyingIntervalMonths: EmptyingIntervalMonths,
    lastEmptiedOn: IsoDate.nullable().optional(),
    notes: Paragraph.nullable().optional(),
    validFrom: IsoDate,
    validTo: IsoDate.nullable().optional(),
  })
  .refine(validityOrdered, endsAfterItStarts)
export type TankInstallationCreate = z.infer<typeof TankInstallationCreate>

/** Everything but the Property, the Container, the first day and the stamps. */
export const TankInstallationPatch = z
  .strictObject({
    kind: TankKind.optional(),
    volumeLitres: PositiveInt.optional(),
    outlet: TankOutlet.optional(),
    emptyingIntervalMonths: EmptyingIntervalMonths.optional(),
    lastEmptiedOn: IsoDate.nullable().optional(),
    notes: Paragraph.nullable().optional(),
    validTo: IsoDate.nullable().optional(),
  })
  .refine(changesSomething, somethingToChange)
export type TankInstallationPatch = z.infer<typeof TankInstallationPatch>

/** A page of installations: of one project, of one Property, of one Container, in force on one day. */
export const TankInstallationListQuery = ProjectScopedListQuery.extend({
  propertyId: Id.optional(),
  containerId: Id.optional(),
  validOn: IsoDate.optional(),
})
export type TankInstallationListQuery = z.infer<typeof TankInstallationListQuery>

export const TankInspection = z.object({
  ...recorded,
  projectId: Id,
  tankInstallationId: Id,
  inspectedOn: IsoDate,
  outcome: TankInspectionOutcome,
  findings: Paragraph.nullable(),
  /** When the tank is next to be inspected, where the inspector said. */
  nextInspectionOn: IsoDate.nullable(),
  /** The account that recorded it. */
  recordedBy: Id,
})
export type TankInspection = z.infer<typeof TankInspection>

export const NEXT_INSPECTION_AFTER = "nextInspectionOn comes after inspectedOn"

export const TankInspectionCreate = z
  .strictObject({
    inspectedOn: IsoDate,
    outcome: TankInspectionOutcome,
    findings: Paragraph.nullable().optional(),
    nextInspectionOn: IsoDate.nullable().optional(),
  })
  .refine((body) => body.nextInspectionOn == null || body.nextInspectionOn > body.inspectedOn, { message: NEXT_INSPECTION_AFTER, path: ["nextInspectionOn"] })
export type TankInspectionCreate = z.infer<typeof TankInspectionCreate>
