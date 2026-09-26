// The one query that replaces the prototype's `resolveStopMatches` on the
// server (Issue #97 part B, §5), and the reason the Registry's placements are
// effective-dated: for every service date of a run, every container of the
// scheme's project under a placement, a subscription and an agreement each
// valid on that day — eligibility is the period three times over, the
// "Active-agreement gate" the prototype approximated with a container status;
// `agreement.status` gates nothing until #79 decides (#97 §6.22) — with the
// placement's fraction and the subscription's place on that day, whether the
// place has a location, and whether that location lies inside the boundary
// of the scheme's planning area in force on that day. Geography is
// containment in the boundary in force, never a stored area id: the
// Registry's `container` carries none on purpose, and a boundary that moves
// next month leaves this week's routes as they were.
//
// One statement for every day of the walk, `unnest` over the dates, so a
// year's run is one round trip and not three hundred; the domain's
// `resolveStops` (@waste/domain/planning/generation) takes the rows from
// there, applies the rule and the tie-breaks between groups, and says which
// containers could not be placed. The days travel as one `text[]` parameter
// cast to `date[]` in the statement: postgres.js serialises a JavaScript
// array as a text array and infers no element type of its own, so the cast
// is where the days become dates. The boundary is a `left join`: a day with
// none in force, or a scheme with no planning area, answers every container
// as not contained, and the job says so on the run as a warning, never a
// throw. At most one boundary of an area is in force on a day
// (`planning_area_boundary_no_overlap`), so the join multiplies nothing.
// `st_contains` is qualified, as every function this package's SQL calls is,
// so it resolves whatever the connecting role's search path says. The
// statement runs on the API role's transaction under `withCompany`, so the
// fence bounds it to the company as it bounds every request; the project is a
// `where` beside it.
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { planningAreaBoundary } from "@waste/db/schema/planning-areas"
import type { StopCandidate } from "@waste/domain/planning/generation"
import { sql } from "drizzle-orm"

type Row = {
  service_date: string
  container_id: string
  label: string
  container_type_id: string
  waste_fraction_id: string
  property_id: string | null
  shared_collection_point_id: string | null
  located: boolean
  contained: boolean
}

/**
 * The stop candidates of a project for each of the days, keyed by day: the
 * containers eligible that day with where they stand against the planning
 * area's boundary in force. A day with no eligible container is an empty
 * list, so every day asked for is a key.
 */
export async function stopCandidatesByDay(tx: Tx, scope: { companyId: string; projectId: string }, planningAreaId: string | null, days: readonly string[]): Promise<Map<string, StopCandidate[]>> {
  const byDay = new Map<string, StopCandidate[]>(days.map((day) => [day, []]))
  if (days.length === 0) return byDay
  const place = sql`coalesce(${property.location}, ${sharedCollectionPoint.location})`
  const rows = await tx.execute<Row>(sql`
    select d.day::text as service_date,
      ${container.id} as container_id,
      ${container.label} as label,
      ${container.containerTypeId} as container_type_id,
      ${containerServicePlacement.wasteFractionId} as waste_fraction_id,
      ${subscription.propertyId} as property_id,
      ${subscription.sharedCollectionPointId} as shared_collection_point_id,
      (${place} is not null) as located,
      (${planningAreaBoundary.boundary} is not null and ${place} is not null and extensions.st_contains(${planningAreaBoundary.boundary}, ${place})) as contained
    from unnest(${sql.param([...days])}::text[]::date[]) as d(day)
    join ${container} on ${container.companyId} = ${scope.companyId} and ${container.projectId} = ${scope.projectId}
    join ${containerServicePlacement}
      on ${containerServicePlacement.companyId} = ${container.companyId} and ${containerServicePlacement.projectId} = ${container.projectId} and ${containerServicePlacement.containerId} = ${container.id}
      and ${validOn(containerServicePlacement, sql`d.day`)}
    join ${subscription}
      on ${subscription.companyId} = ${containerServicePlacement.companyId} and ${subscription.projectId} = ${containerServicePlacement.projectId} and ${subscription.id} = ${containerServicePlacement.subscriptionId}
      and ${validOn(subscription, sql`d.day`)}
    join ${agreement}
      on ${agreement.companyId} = ${subscription.companyId} and ${agreement.projectId} = ${subscription.projectId} and ${agreement.id} = ${subscription.agreementId}
      and ${validOn(agreement, sql`d.day`)}
    left join ${property} on ${property.companyId} = ${subscription.companyId} and ${property.id} = ${subscription.propertyId}
    left join ${sharedCollectionPoint} on ${sharedCollectionPoint.companyId} = ${subscription.companyId} and ${sharedCollectionPoint.id} = ${subscription.sharedCollectionPointId}
    left join ${planningAreaBoundary}
      on ${planningAreaBoundary.companyId} = ${container.companyId} and ${planningAreaBoundary.planningAreaId} = ${planningAreaId}
      and ${validOn(planningAreaBoundary, sql`d.day`)}
    order by d.day, ${container.label}, ${container.id}
  `)
  for (const row of rows) {
    byDay.get(row.service_date)?.push({
      containerId: row.container_id,
      label: row.label,
      containerTypeId: row.container_type_id,
      wasteFractionId: row.waste_fraction_id,
      propertyId: row.property_id,
      sharedCollectionPointId: row.shared_collection_point_id,
      located: row.located,
      contained: row.contained,
    })
  }
  return byDay
}

/**
 * Whether the scheme's planning area has a boundary in force on each day:
 * the run's warning for the days that have none, where rule groups match
 * nothing. Asked once for the walk, in one statement.
 */
export async function daysWithBoundary(tx: Tx, companyId: string, planningAreaId: string, days: readonly string[]): Promise<Set<string>> {
  if (days.length === 0) return new Set()
  const rows = await tx.execute<{ day: string }>(sql`
    select d.day::text as day
    from unnest(${sql.param([...days])}::text[]::date[]) as d(day)
    where exists (
      select 1 from ${planningAreaBoundary}
      where ${planningAreaBoundary.companyId} = ${companyId} and ${planningAreaBoundary.planningAreaId} = ${planningAreaId} and ${validOn(planningAreaBoundary, sql`d.day`)}
    )
  `)
  return new Set(rows.map((row) => row.day))
}
