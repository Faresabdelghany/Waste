// Where work happens (Issue #97): the Planning Area and its boundary
// versions. The glossary's "versioned geographic area" is two tables, because
// a Route Scheme (and, in Finance & Contracting, a Service Area) names the
// area and not one drawing of it: a scheme that named a boundary row would
// break the day a new version started.
//
// `planning_area` is the identity — the stable `code` a person quotes
// (`OP-CEN-01`), a name, a purpose — and carries `projectKey` for the tables
// that point at it. It has no status: "in force on a day" is having a
// boundary valid that day, and the prototype's Draft, Valid, Upcoming, Active
// and Expired are readings of the versions.
//
// `planning_area_boundary` is one version: an effective-dated polygon
// (ADR-0005), the first polygon this system stores. Its exclusion constraint
// is over the area alone — one boundary of an area in force at a time, a new
// version starting when the old ends — and its `previousVersionId` of the
// prototype is gone, since the chain is the code plus non-overlapping periods,
// which the constraint holds where a pointer could not. Overlap between two
// areas of one project is allowed and is a read, not a constraint. The ring
// rule is the contracts' (a closed ring of four or more positions, three
// distinct, holes allowed, no winding rule) and the database is the second
// stop: `st_isvalid` refuses a self-intersecting ring with 23514, which the
// API turns into a 400 on `boundary`. The GiST index is for the stop-matching
// query, a point-in-polygon over the version in force. Nothing references a
// version, so it has no `projectKey` and its reference to the Project takes a
// `tenantIndex`, as every referencing column set does.
import { PLANNING_AREA_PURPOSES } from "@waste/domain/planning/vocabulary"
import { index, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { oneOf } from "./checks"
import { id, projectScoped, timestamps, validity, validPeriod } from "./columns"
import { geometry, validGeometry } from "./geometry"
import { company, project } from "./organisation"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const planningArea = wms.table(
  "planning_area",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The stable reference a person quotes: `OP-CEN-01`. Set once; unique per project. */
    code: text().notNull(),
    name: text().notNull(),
    purpose: text().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantUnique(t, t.projectId, t.code),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.purpose, PLANNING_AREA_PURPOSES),
  ],
)

export const planningAreaBoundary = wms.table(
  "planning_area_boundary",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    ...validity,
    planningAreaId: uuid().notNull(),
    /** The area's outline for this period; the first polygon the system stores. */
    boundary: geometry.polygon().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    projectReference(t, [t.planningAreaId], planningArea),
    validPeriod(t),
    validGeometry(t.boundary),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.planningAreaId),
    // Point-in-polygon over the boundary in force: what resolves a rule group's stops.
    index(tableObjectName(t.companyId.table, "boundary_idx", "planningAreaBoundary")).using("gist", t.boundary),
  ],
)
