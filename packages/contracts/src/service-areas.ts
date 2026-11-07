// The Service Area and its Assignment on the wire (Issue #112): "an
// effective-dated geographic and service responsibility awarded to a service
// provider. Its geographic scope references operator-owned Planning Areas —
// the service provider domain has no zone concept of its own — while the
// contract's own boundary text stays the authoritative legal boundary"
// (CONTEXT.md), and "the effective-dated relationship that links an existing
// Service Area to one service provider. Assigning or transferring it changes
// the relationship and preserves the Service Area itself."
//
// So an area carries its `code` as the contract spells it (`CA-Ø-2`, a
// `Label` bounded to `SERVICE_AREA_CODE_MAX` and not a `Slug`, since a slug
// would refuse the letter, §7.27), its `boundaryText`, and two sets that
// travel with it and are replaced whole: the planning areas it covers and
// the waste fractions it is awarded for. It stores no polygon and no
// products — a provider is paid per product through its prices, not scoped
// by them. A create may ride the first assignment, since an award is made to
// someone, and answers `ServiceAreaCreated`, the area with the assignment it
// wrote or null (the `PlanningAreaCreated` precedent). The area's patch
// moves its name, its text, its notes and its period, never its code; the
// assignment's patch moves its notes and its end, never the provider or the
// area — a transfer is a new assignment, the old one ended on the day.
// Whether an assignment's period lies inside its area's, and whether a
// planning area is already in another area over the period, are the route's
// questions.
//
// The lists: an area by project, day, planning area, or provider — the last
// through the assignments valid on `validOn`, so it requires the day
// (`PROVIDER_NEEDS_A_DAY`); an assignment by project, area, provider, day.
// A Service Provider's own account reads its assignments and the areas they
// name through these, bounded by the route.
import { validityOrdered } from "@waste/domain/periods"
import { EACH_FRACTION_ONCE } from "@waste/domain/registry/catalogue"
import { eachOnce, SET_MAX } from "@waste/domain/requests"
import { EACH_PLANNING_AREA_ONCE, PROVIDER_NEEDS_A_DAY, SERVICE_AREA_CODE_MAX, SERVICE_AREA_CODE_TOO_LONG } from "@waste/domain/service-providers/service-areas"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { stamped } from "./resource"
import { Label, Paragraph } from "./text"
import { effectiveDated, effectiveDatedBodies, endsAfterItStarts } from "./validity"

/** The award's code as the contract spells it. */
const ServiceAreaCode = Label.max(SERVICE_AREA_CODE_MAX, { error: SERVICE_AREA_CODE_TOO_LONG })

const eachPlanningAreaOnce = { message: EACH_PLANNING_AREA_ONCE, path: ["planningAreaIds"] }
const eachFractionOnce = { message: EACH_FRACTION_ONCE, path: ["wasteFractionIds"] }

const IdSet = z.array(Id).max(SET_MAX)

export const ServiceAreaAssignment = effectiveDated(
  z.object({
    ...stamped,
    projectId: Id,
    serviceAreaId: Id,
    /** The company's provider that holds the area over the period. */
    serviceProviderId: Id,
    notes: Paragraph.nullable(),
  }),
)
export type ServiceAreaAssignment = z.infer<typeof ServiceAreaAssignment>

/**
 * `POST /service-areas/:id/assignments`: the area is the path's and the
 * project the area's. Whether the period lies inside the area's is the
 * route's question. `PATCH /service-area-assignments/:id` moves the notes and
 * the end, a null reopening the assignment; never the provider or the area,
 * since a transfer is a new assignment.
 */
const assignmentBodies = effectiveDatedBodies({ serviceProviderId: Id, notes: Paragraph.nullable().optional() }, { createOnly: { serviceProviderId: true, validFrom: true } })

export const ServiceAreaAssignmentCreate = assignmentBodies.create
export type ServiceAreaAssignmentCreate = z.infer<typeof ServiceAreaAssignmentCreate>

export const ServiceAreaAssignmentPatch = assignmentBodies.patch
export type ServiceAreaAssignmentPatch = z.infer<typeof ServiceAreaAssignmentPatch>

/** An area: the resource the two answers below extend, its period's rule with it. */
export const ServiceArea = effectiveDated(
  z.object({
    ...stamped,
    projectId: Id,
    /** The award's code as the contract spells it; set once, one area of a code in force at a time. */
    code: ServiceAreaCode,
    name: Label,
    /** The contract's own boundary text: the authoritative legal boundary. */
    boundaryText: Paragraph,
    notes: Paragraph.nullable(),
    /** The operational geography the award covers, by id; replaced whole through its own route. */
    planningAreaIds: z.array(Id),
    /** The service scope, by id; replaced whole through its own route. */
    wasteFractionIds: z.array(Id),
  }),
)
export type ServiceArea = z.infer<typeof ServiceArea>

/** The first assignment riding on an area's create: the provider, and a period defaulting to the area's. */
const FirstAssignment = z
  .strictObject({
    serviceProviderId: Id,
    /** The area's start when absent. */
    validFrom: IsoDate.optional(),
    /** The area's end when absent; null is open ended. */
    validTo: IsoDate.nullable().optional(),
  })
  .refine(validityOrdered, endsAfterItStarts)

/**
 * `POST /service-areas`: the award, its two sets, and the first assignment
 * when the award is made to someone straight away, written in the same
 * transaction; an area may also be registered first and assigned later.
 * `PATCH /service-areas/:id` moves the name, the text, the notes and the
 * period, a null end reopening the award; never the code, which the contract
 * spells, nor the sets, each replaced whole through its own route.
 */
const serviceAreaBodies = effectiveDatedBodies(
  {
    projectId: Id,
    code: ServiceAreaCode,
    name: Label,
    boundaryText: Paragraph,
    notes: Paragraph.nullable().optional(),
    planningAreaIds: IdSet.default([]).describe("The planning areas the award covers; none when absent, and then no route is reached through it."),
    wasteFractionIds: IdSet.default([]).describe("The waste fractions the award is for; none when absent."),
    assignment: FirstAssignment.optional(),
  },
  { createOnly: { projectId: true, code: true, planningAreaIds: true, wasteFractionIds: true, assignment: true } },
)

export const ServiceAreaCreate = serviceAreaBodies.create
  // zod 4 runs a check on a body whose fields failed, so each set is read with care.
  .refine((body) => eachOnce(body.planningAreaIds ?? []), eachPlanningAreaOnce)
  .refine((body) => eachOnce(body.wasteFractionIds ?? []), eachFractionOnce)
export type ServiceAreaCreate = z.infer<typeof ServiceAreaCreate>

/** What a create answers: the area as written, and the first assignment beside it when the body made one — null when it did not — so the client has both ids from the one request. */
export const ServiceAreaCreated = ServiceArea.safeExtend({ assignment: ServiceAreaAssignment.nullable() })
export type ServiceAreaCreated = z.infer<typeof ServiceAreaCreated>

export const ServiceAreaPatch = serviceAreaBodies.patch
export type ServiceAreaPatch = z.infer<typeof ServiceAreaPatch>

/** `PUT /service-areas/:id/planning-areas`: the whole set, replacing what the area had. */
export const ServiceAreaPlanningAreasSet = z.strictObject({ ids: IdSet }).refine((body) => eachOnce(body.ids), { message: EACH_PLANNING_AREA_ONCE, path: ["ids"] })
export type ServiceAreaPlanningAreasSet = z.infer<typeof ServiceAreaPlanningAreasSet>

/** `PUT /service-areas/:id/waste-fractions`: likewise. */
export const ServiceAreaWasteFractionsSet = z.strictObject({ ids: IdSet }).refine((body) => eachOnce(body.ids), { message: EACH_FRACTION_ONCE, path: ["ids"] })
export type ServiceAreaWasteFractionsSet = z.infer<typeof ServiceAreaWasteFractionsSet>

/** An area with its assignments, earliest first. */
export const ServiceAreaDetail = ServiceArea.safeExtend({ assignments: z.array(ServiceAreaAssignment) })
export type ServiceAreaDetail = z.infer<typeof ServiceAreaDetail>

const providerNeedsADay = { message: PROVIDER_NEEDS_A_DAY, path: ["validOn"] }

/** A page of areas: one project's, in force on a day, naming a planning area, or held by a provider on the day. */
export const ServiceAreaListQuery = ProjectScopedListQuery.extend({
  /** The day the period is read against; absent asks for every area, whenever it ran. */
  validOn: IsoDate.optional(),
  /** The areas naming this planning area. */
  planningAreaId: Id.optional(),
  /** The areas whose assignment names this provider on `validOn`, which it requires. */
  serviceProviderId: Id.optional(),
}).refine((query) => query.serviceProviderId === undefined || query.validOn !== undefined, providerNeedsADay)
export type ServiceAreaListQuery = z.infer<typeof ServiceAreaListQuery>

/** A page of assignments across the areas of a project, or of one area, one provider, in force on a day. */
export const ServiceAreaAssignmentListQuery = ProjectScopedListQuery.extend({
  serviceAreaId: Id.optional(),
  serviceProviderId: Id.optional(),
  validOn: IsoDate.optional(),
})
export type ServiceAreaAssignmentListQuery = z.infer<typeof ServiceAreaAssignmentListQuery>
