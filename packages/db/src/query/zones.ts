// Which planning areas hold a place on a day (O29 of #290, row 1.13): the
// address → zone read. An area holds the place when its boundary in force on
// the day (`validOn`, one version per area at a time) contains the point, as
// generation's matcher and a bulky booking judge a place (`st_contains`). Two
// areas may overlap, so a place can sit in several; they come in code order,
// the order a person reads a project's areas in. An area with no boundary in
// force on the day holds nothing, whatever it held before.
//
// The place is a point the caller has: a property's location, or a point the
// office picked from the address register before there is a property. Every
// statement names the company and the project, so the answer is the
// project's areas alone.
import type { PlanningAreaPurpose } from "@waste/domain/planning/vocabulary"
import { and, asc, eq, sql } from "drizzle-orm"

import type { Tx } from "../client"
import type { ScopedProject } from "./collection-days"
import { planningArea, planningAreaBoundary } from "../schema/planning-areas"
import { validOn } from "./valid-on"

/** A planning area as the read answers it: the area itself, not its outline. */
export type PlanningAreaAt = {
  id: string
  projectId: string
  code: string
  name: string
  purpose: string
  createdAt: Date
  updatedAt: Date
}

/** A point as `[longitude, latitude]`, flat, in WGS 84: what a property's location holds. */
export type PlacePoint = readonly [number, number]

/** The project's areas of `purpose` whose boundary in force on `day` contains `point`, in code order. */
export async function planningAreasAt(tx: Tx, scope: ScopedProject, point: PlacePoint, day: string, purpose: PlanningAreaPurpose): Promise<PlanningAreaAt[]> {
  const [lng, lat] = point
  return tx
    .select({
      id: planningArea.id,
      projectId: planningArea.projectId,
      code: planningArea.code,
      name: planningArea.name,
      purpose: planningArea.purpose,
      createdAt: planningArea.createdAt,
      updatedAt: planningArea.updatedAt,
    })
    .from(planningArea)
    .innerJoin(planningAreaBoundary, and(eq(planningAreaBoundary.companyId, planningArea.companyId), eq(planningAreaBoundary.planningAreaId, planningArea.id)))
    .where(
      and(
        eq(planningArea.companyId, scope.companyId),
        eq(planningArea.projectId, scope.projectId),
        eq(planningArea.purpose, purpose),
        validOn(planningAreaBoundary, day),
        sql`extensions.st_contains(${planningAreaBoundary.boundary}, extensions.st_setsrid(extensions.st_makepoint(${lng}::float8, ${lat}::float8), 4326))`,
      ),
    )
    .orderBy(asc(planningArea.code), asc(planningArea.id))
}
