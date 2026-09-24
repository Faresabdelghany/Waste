// Where work happens, on the wire (Issue #97): the Planning Area and its
// boundary versions. Two resources, because a Route Scheme names the area and
// not one drawing of it: `PlanningArea` is the identity — the stable `code` a
// person quotes, a name, a purpose — and `PlanningAreaBoundary` one
// effective-dated version of its outline (ADR-0005). The database holds one
// boundary of an area in force at a time; "active", "upcoming" and "expired"
// are readings of the versions against a day (`validOn`), and no status is on
// the wire.
//
// The ring rule is decided here, with the first stored polygon. A boundary is
// the contracts' `Polygon` and nothing else: an outer ring of four or more
// `[lng, lat]` positions closing on the first with three distinct, holes
// allowed, no winding rule (RFC 7946's right-hand rule is a SHOULD and PostGIS
// does not care), no altitude. The prototype's unclosed `{ lng, lat }[]` is
// closed in the web adapter, not repaired here — these schemas refuse rather
// than repair everywhere else, and the shape exists only in apps/web. What
// the shape rule cannot see, a ring that crosses itself, the database refuses
// with `st_isvalid` and the API answers as a 400 on `boundary`.
//
// The code is set once, like a waste fraction's key: a scheme, a Service Area
// or a report that quotes it goes on quoting it, and an area that needs
// another code is another area. A create may carry the first boundary, so the
// form that draws an area is one request; a boundary's patch moves its end or
// redraws it, and never its start, since a version begins where the earlier
// ended.
import * as z from "zod"

import { IsoDate } from "./dates"
import { Polygon } from "./geojson"
import { Id } from "./ids"
import { PlanningAreaPurpose } from "./planning"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, somethingToChange, stamped } from "./resource"
import { Label } from "./text"
import { endsAfterItStarts, Validity, ValidityCreate, validityOrdered } from "./validity"

export const PlanningArea = z.object({
  ...stamped,
  projectId: Id,
  /** The stable reference a person quotes: `OP-CEN-01`. Unique per project; set once. */
  code: Label,
  /** Unique per project. */
  name: Label,
  purpose: PlanningAreaPurpose,
})
export type PlanningArea = z.infer<typeof PlanningArea>

export const PlanningAreaBoundary = z
  .object({
    ...stamped,
    projectId: Id,
    planningAreaId: Id,
    /** The outline in force over the period: a closed ring of four or more positions, holes allowed. */
    boundary: Polygon,
    ...Validity.shape,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type PlanningAreaBoundary = z.infer<typeof PlanningAreaBoundary>

/** A new version: the area is the path's, the project the area's. A period overlapping another version is the route's 409. */
export const PlanningAreaBoundaryCreate = z
  .strictObject({
    boundary: Polygon,
    ...ValidityCreate,
  })
  .refine(validityOrdered, endsAfterItStarts)
export type PlanningAreaBoundaryCreate = z.infer<typeof PlanningAreaBoundaryCreate>

/** The end moves and the outline may be redrawn; the start does not move, since a version begins where the earlier one ended. Whether the new end still meets the next version is the route's question. */
export const PlanningAreaBoundaryPatch = z
  .strictObject({
    /** Null reopens the version; a day ends it. */
    validTo: IsoDate.nullable().optional(),
    boundary: Polygon.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type PlanningAreaBoundaryPatch = z.infer<typeof PlanningAreaBoundaryPatch>

export const PlanningAreaCreate = z.strictObject({
  projectId: Id,
  code: Label,
  name: Label,
  purpose: PlanningAreaPurpose,
  /** The first version, written in the same transaction; an area may also be registered first and drawn later. */
  boundary: PlanningAreaBoundaryCreate.optional(),
})
export type PlanningAreaCreate = z.infer<typeof PlanningAreaCreate>

/** The name and the purpose; the code is the reference the rest of the system quotes, and the boundaries are versions with routes of their own. */
export const PlanningAreaPatch = z
  .strictObject({
    name: Label.optional(),
    purpose: PlanningAreaPurpose.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type PlanningAreaPatch = z.infer<typeof PlanningAreaPatch>

/** A page of planning areas, from one project and of one purpose. */
export const PlanningAreaListQuery = ProjectScopedListQuery.extend({
  purpose: PlanningAreaPurpose.optional(),
})
export type PlanningAreaListQuery = z.infer<typeof PlanningAreaListQuery>

/** A page of boundary versions across the areas of a project, or of one area, in force on a day: the Layers control's read. */
export const PlanningAreaBoundaryListQuery = ProjectScopedListQuery.extend({
  planningAreaId: Id.optional(),
  /** The day the period is read against; absent asks for every version, whenever it ran. */
  validOn: IsoDate.optional(),
})
export type PlanningAreaBoundaryListQuery = z.infer<typeof PlanningAreaBoundaryListQuery>
