// Service Provider Activities on the wire (#474,
// @waste/domain/service-providers/activities). The routes are
// apps/api/src/routes/service-provider-activities.ts.
//
// An Activity is one item of coordination between the office and one Service
// Provider: a proposal that asks for the office's Approval, a compliance
// follow-up the office raises with a due day, or a note either side keeps. It
// names its project and its provider, and may name the Service Area it is
// about. A create is shaped by its kind: a `route-day-change` names a
// Collection Group of a scheme, the days it should run on and the first day
// they apply; a `vehicle-change` the same group, the vehicle it should run
// with, optionally its driver, and the first day; a `stop-set-change` a group
// that picks its stops, the containers it should run on in stop order, and
// the first day; a `compliance-follow-up` its due day. It is moved by command —
// `approve`, `reject` or `withdraw` a proposal, `complete` or `cancel` the
// rest — and an approved proposal names the scheme version its approval
// wrote (`successorSchemeId`). Overdue is a reading of an open follow-up's
// due day, never a status.
import { SERVICE_PROVIDER_ACTIVITY_KINDS, SERVICE_PROVIDER_ACTIVITY_STATUSES } from "@waste/domain/service-providers/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ServiceDays } from "./planning"
import { CollectionGroupContainersSet } from "./route-schemes"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, PositiveInt, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"

export const ActivityKind = z.enum(SERVICE_PROVIDER_ACTIVITY_KINDS)
export type ActivityKind = z.infer<typeof ActivityKind>
export const ActivityStatus = z.enum(SERVICE_PROVIDER_ACTIVITY_STATUSES)
export type ActivityStatus = z.infer<typeof ActivityStatus>

/** What a proposal of days giving none is told. */
export const AT_LEAST_ONE_DAY = "A group runs on one day at least"

/** The days a route-day change asks the group to run on: one at least, each once. */
const ProposedDays = ServiceDays.refine((days) => days.length > 0, { message: AT_LEAST_ONE_DAY })

export const ServiceProviderActivity = z.object({
  ...stamped,
  projectId: Id,
  /** The company's running count, `ACT-<n>` in a sentence. */
  number: PositiveInt,
  kind: ActivityKind,
  status: ActivityStatus,
  serviceProviderId: Id,
  /** The award it is about, where it is about one. */
  serviceAreaId: Id.nullable(),
  subject: Label,
  body: Paragraph.nullable(),
  /** A compliance follow-up's last day in time; null for every other kind. */
  dueOn: IsoDate.nullable(),
  /** A proposal's scheme and group; null for every other kind. */
  routeSchemeId: Id.nullable(),
  collectionGroupId: Id.nullable(),
  /** A route-day change's days for the group; null for every other kind. */
  serviceDays: ServiceDays.nullable(),
  /** The first day a proposal applies from; null for every other kind. */
  effectiveFrom: IsoDate.nullable(),
  /** A vehicle change's vehicle for the group, and its driver where the proposal names one; null for every other kind. */
  vehicleId: Id.nullable(),
  driverId: Id.nullable(),
  /** A stop-set change's containers for the group, in stop order; null for every other kind. */
  containerIds: z.array(Id).nullable(),
  /** The scheme version an approval wrote; null until a proposal is approved. */
  successorSchemeId: Id.nullable(),
  openedBy: Id,
  /** Who closed it — approved, rejected, withdrew, completed or cancelled it — and when; null while it is open. */
  closedBy: Id.nullable(),
  closedAt: IsoDateTime.nullable(),
  /** Why it was closed as it was: always given for a rejection. */
  closeReason: Paragraph.nullable(),
})
export type ServiceProviderActivity = z.infer<typeof ServiceProviderActivity>

/** What every create names: the project, the provider, the subject, and optionally the award and a body. */
const createBase = {
  projectId: Id,
  serviceProviderId: Id,
  serviceAreaId: Id.nullable().optional(),
  subject: Label,
  body: Paragraph.nullable().optional(),
}

export const RouteDayChangeCreate = z.strictObject({
  ...createBase,
  kind: z.literal("route-day-change"),
  routeSchemeId: Id,
  collectionGroupId: Id,
  serviceDays: ProposedDays,
  effectiveFrom: IsoDate,
})
export type RouteDayChangeCreate = z.infer<typeof RouteDayChangeCreate>

export const ComplianceFollowUpCreate = z.strictObject({
  ...createBase,
  kind: z.literal("compliance-follow-up"),
  dueOn: IsoDate,
})
export type ComplianceFollowUpCreate = z.infer<typeof ComplianceFollowUpCreate>

export const CoordinationNoteCreate = z.strictObject({
  ...createBase,
  kind: z.literal("coordination-note"),
})
export type CoordinationNoteCreate = z.infer<typeof CoordinationNoteCreate>

/** A vehicle change: the group runs with this vehicle from `effectiveFrom`, and with this driver where one is named, else its own. */
export const VehicleChangeCreate = z.strictObject({
  ...createBase,
  kind: z.literal("vehicle-change"),
  routeSchemeId: Id,
  collectionGroupId: Id,
  vehicleId: Id,
  driverId: Id.nullable().optional(),
  effectiveFrom: IsoDate,
})
export type VehicleChangeCreate = z.infer<typeof VehicleChangeCreate>

/** The containers a stop-set change picks, in stop order: a manual group's list, as `PUT …/containers` takes one. */
const PickedContainers = CollectionGroupContainersSet.shape.containerIds

/** A stop-set change: the group, which picks its stops, runs on these containers in this order from `effectiveFrom`. */
export const StopSetChangeCreate = z.strictObject({
  ...createBase,
  kind: z.literal("stop-set-change"),
  routeSchemeId: Id,
  collectionGroupId: Id,
  containerIds: PickedContainers,
  effectiveFrom: IsoDate,
})
export type StopSetChangeCreate = z.infer<typeof StopSetChangeCreate>

/** `POST /service-provider-activities`: the body its kind shapes. */
export const ServiceProviderActivityCreate = z.discriminatedUnion("kind", [RouteDayChangeCreate, ComplianceFollowUpCreate, CoordinationNoteCreate, VehicleChangeCreate, StopSetChangeCreate])
export type ServiceProviderActivityCreate = z.infer<typeof ServiceProviderActivityCreate>

/**
 * What may be corrected while an Activity is open: its subject, body and
 * award, a follow-up's due day, a route-day change's days, a vehicle change's
 * vehicle and driver, a stop-set change's containers, and a proposal's first
 * day. The
 * kind, the provider, the project and a proposal's scheme and group are its
 * own — another group's change is another proposal. A member the kind does
 * not carry is refused by the API at its field.
 */
export const ServiceProviderActivityPatch = z
  .strictObject({
    serviceAreaId: Id.nullable().optional(),
    subject: Label.optional(),
    body: Paragraph.nullable().optional(),
    dueOn: IsoDate.optional(),
    serviceDays: ProposedDays.optional(),
    effectiveFrom: IsoDate.optional(),
    vehicleId: Id.optional(),
    driverId: Id.nullable().optional(),
    containerIds: PickedContainers.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type ServiceProviderActivityPatch = z.infer<typeof ServiceProviderActivityPatch>

/** `approve`, `withdraw`, `complete` and `cancel`: why, where the closer says. */
export const ActivityClose = z.strictObject({
  reason: Paragraph.nullable().optional(),
})
export type ActivityClose = z.infer<typeof ActivityClose>

/** `reject`: always why, which the provider reads. */
export const ActivityReject = z.strictObject({
  reason: Paragraph,
})
export type ActivityReject = z.infer<typeof ActivityReject>

/** A page of Activities: one project's or every one the caller reaches, one provider's, kind's or status's. */
export const ServiceProviderActivityListQuery = ProjectScopedListQuery.extend({
  serviceProviderId: Id.optional(),
  kind: ActivityKind.optional(),
  status: ActivityStatus.optional(),
})
export type ServiceProviderActivityListQuery = z.infer<typeof ServiceProviderActivityListQuery>
