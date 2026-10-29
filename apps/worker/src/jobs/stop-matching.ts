// The one query that replaces the prototype's `resolveStopMatches` on the
// server (Issue #97 part B, §5), and the reason the Registry's placements are
// effective-dated: for every service date of a run, every container of the
// scheme's project under a placement, a subscription and an agreement each
// valid on that day — eligibility is the period three times over, the
// "Active-agreement gate" the prototype approximated with a container status;
// `agreement.status` gates nothing until #79 decides (#97 §6.22) — with the
// placement's fraction and the subscription's place on that day, whether the
// place has a location, and which of the run's planning areas — the scheme's
// and its rule groups' own (O30 of #290) — hold that location inside their
// boundary in force on that day. Geography is
// containment in the boundary in force, never a stored area id: the
// Registry's `container` carries none on purpose, and a boundary that moves
// next month leaves this week's routes as they were. And whether a pause of
// the subscription is in force that day (#291, slice 10): a paused row is
// still a candidate, `paused`, so the domain passes it over in every group
// without counting it unlocated, and what a rule matches — the drift stamp —
// still sees it. And the tank installation it stands for that day (M11 of
// #293), whose due-from-last cadence the domain judges each day by
// (`tankWaits`): its interval, and its last emptying — the container's latest
// completed stop (`lastEmptyings`, @waste/db/query/tank-emptyings, the reading
// the API's register answers too), else the register's word for one before
// the platform — read once for the run's tanks after the statement.
//
// One statement for every day of the walk, `unnest` over the dates, so a
// year's run is one round trip and not three hundred; the domain's
// `resolveStops` (@waste/domain/planning/generation) takes the rows from
// there, applies the rule and the tie-breaks between groups, and says which
// containers could not be placed. The days travel as one `text[]` parameter
// cast to `date[]` in the statement: postgres.js serialises a JavaScript
// array as a text array and infers no element type of its own, so the cast
// is where the days become dates. The areas are an array subquery per row,
// so a container lies in none, one or several: a day with no boundary in
// force, or a run with no planning area, answers every container as in
// none, and the job says so on the run as a warning, never a throw. At most
// one boundary of an area is in force on a day
// (`planning_area_boundary_no_overlap`), so an area is named once.
// `st_contains` is qualified, as every function this package's SQL calls is,
// so it resolves whatever the connecting role's search path says. The
// statement runs on the API role's transaction under `withCompany`, so the
// fence bounds it to the company as it bounds every request; the project is a
// `where` beside it.
import type { Tx } from "@waste/db/client"
import { lastEmptyings } from "@waste/db/query/tank-emptyings"
import { validOn } from "@waste/db/query/valid-on"
import { agreement, subscription, subscriptionPause } from "@waste/db/schema/agreements"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { planningAreaBoundary } from "@waste/db/schema/planning-areas"
import { tankInstallation } from "@waste/db/schema/tanks"
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
  contained_in: string[]
  paused: boolean
  /** The interval of the tank it stands for that day; null for a container that stands for none. */
  tank_interval_months: number | null
  tank_last_emptied_on: string | null
}

/** The later of two days, either of which may be absent. */
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b)

/**
 * The stop candidates of a project for each of the days, keyed by day: the
 * containers eligible that day with the planning areas of `planningAreaIds`
 * whose boundary in force holds them. A day with no eligible container is an
 * empty list, so every day asked for is a key.
 */
export async function stopCandidatesByDay(tx: Tx, scope: { companyId: string; projectId: string }, planningAreaIds: readonly string[], days: readonly string[]): Promise<Map<string, StopCandidate[]>> {
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
      array(
        select ${planningAreaBoundary.planningAreaId}::text from ${planningAreaBoundary}
        where ${planningAreaBoundary.companyId} = ${container.companyId} and ${planningAreaBoundary.planningAreaId} = any(${sql.param([...planningAreaIds])}::text[]::uuid[])
          and ${validOn(planningAreaBoundary, sql`d.day`)}
          and ${place} is not null and extensions.st_contains(${planningAreaBoundary.boundary}, ${place})
        order by 1
      ) as contained_in,
      exists (
        select 1 from ${subscriptionPause}
        where ${subscriptionPause.companyId} = ${subscription.companyId} and ${subscriptionPause.subscriptionId} = ${subscription.id} and ${validOn(subscriptionPause, sql`d.day`)}
      ) as paused,
      tank.emptying_interval_months as tank_interval_months,
      tank.last_emptied_on::text as tank_last_emptied_on
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
    left join lateral (
      select ${tankInstallation.emptyingIntervalMonths} as emptying_interval_months, ${tankInstallation.lastEmptiedOn} as last_emptied_on from ${tankInstallation}
      where ${tankInstallation.companyId} = ${container.companyId} and ${tankInstallation.containerId} = ${container.id} and ${validOn(tankInstallation, sql`d.day`)}
    ) as tank on true
    order by d.day, ${container.label}, ${container.id}
  `)
  const emptyings = await lastEmptyings(tx, scope.companyId, [...new Set(rows.filter((row) => row.tank_interval_months !== null).map((row) => row.container_id))])
  for (const row of rows) {
    byDay.get(row.service_date)?.push({
      containerId: row.container_id,
      label: row.label,
      containerTypeId: row.container_type_id,
      wasteFractionId: row.waste_fraction_id,
      propertyId: row.property_id,
      sharedCollectionPointId: row.shared_collection_point_id,
      located: row.located,
      containedIn: row.contained_in,
      paused: row.paused,
      tank: row.tank_interval_months === null ? null : { lastEmptiedOn: later(emptyings.get(row.container_id)?.on ?? null, row.tank_last_emptied_on), intervalMonths: row.tank_interval_months },
    })
  }
  return byDay
}

/**
 * Whether a planning area — the scheme's, or a rule group's own — has a
 * boundary in force on each day: the run's warning for the days that have
 * none, where the rule groups matching within it match nothing. Asked once
 * per area for the walk, in one statement.
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
