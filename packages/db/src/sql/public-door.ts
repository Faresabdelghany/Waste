// The public door's role (Issue #293, ADR-0010): what an anonymous reader of a
// project's published pages may see, spelled once here and copied into the
// migration that creates it, as the sync role's statements are (publication.ts).
//
// `wms_public` logs in as nobody. The API's own connection, `wms_api`, holds
// it with SET and without INHERIT, so a public request's transaction says
// `SET LOCAL ROLE wms_public` (public-door.ts at the package root) and every
// statement after that runs with this role's rights alone, never the API's;
// the setting ends with the transaction. The role owns nothing, bypasses
// nothing, and holds SELECT on exactly the columns below — a column left out
// is a column no public answer can carry, whatever a route's code asks — and
// no other right on any table. The default privileges of 0001 and 0011 name
// `wms_api` and `wms_worker` only, so a table added later is one this role
// cannot read until a migration grants it here.
//
// Its rows are its own policies', since every table's tenant fence is
// written `TO wms_api` and forced: a project is visible while it publishes
// itself (`public_slug` set), and that row is how a request finds the company
// it then sets with `wms.company_id`; a fraction and an item are visible
// inside that company, an item only while it is published and its project
// is too. Granted to the owner as well, so a test can look through its eyes.
import { PUBLISHED_ITEM } from "@waste/domain/sorting-guide/vocabulary"
import type { PgColumn, PgTable } from "drizzle-orm/pg-core"

import { columnName, qualifiedTable, quoted, tableObjectName } from "../names"
import { API_ROLE, PUBLIC_ROLE } from "../roles"
import { subscription, subscriptionPause } from "../schema/agreements"
import { wasteFraction } from "../schema/catalogue"
import { collectionCalendarHoliday } from "../schema/collection-calendars"
import { containerServicePlacement } from "../schema/containers"
import { property } from "../schema/customers"
import { route } from "../schema/execution"
import { generationMatch } from "../schema/generation"
import { project } from "../schema/organisation"
import { collectionGroup, collectionGroupContainer, routeScheme } from "../schema/route-schemes"
import { sortingGuideItem } from "../schema/sorting-guide"

const HELPER = "publicDoor"

/** The suffix of each table's policy for the public role. */
export const PUBLIC_DOOR_POLICY = "public_door"

/**
 * A table the public door reads: the columns it may SELECT, and the rows, as
 * a policy's predicate; null rows where an earlier migration's policy on the
 * table already stands and only columns are added.
 */
export type PublicDoorTable = { table: PgTable; columns: readonly PgColumn[]; rows: string | null }

const IN_COMPANY = `${quoted("company_id")} = (select wms.current_company_id())`

/** What migration 0017 opened (the Sorting Guide, #293 M1): spelled as that file has it, never edited, since an applied file is not. */
export const SORTING_GUIDE_DOOR: readonly PublicDoorTable[] = [
  {
    table: project,
    columns: [project.id, project.companyId, project.name, project.language, project.timezone, project.publicSlug],
    rows: `${quoted("public_slug")} is not null`,
  },
  {
    table: wasteFraction,
    columns: [wasteFraction.id, wasteFraction.companyId, wasteFraction.key, wasteFraction.name],
    rows: IN_COMPANY,
  },
  {
    table: sortingGuideItem,
    columns: [
      sortingGuideItem.id,
      sortingGuideItem.companyId,
      sortingGuideItem.projectId,
      sortingGuideItem.name,
      sortingGuideItem.synonyms,
      sortingGuideItem.wasteFractionId,
      sortingGuideItem.instructions,
      sortingGuideItem.status,
    ],
    rows: `${IN_COMPANY} and ${quoted("status")} = '${PUBLISHED_ITEM}' and exists (select 1 from "wms"."project" "published" where "published"."company_id" = ${quoted("sorting_guide_item")}.${quoted("company_id")} and "published"."id" = ${quoted("sorting_guide_item")}.${quoted("project_id")} and "published"."public_slug" is not null)`,
  },
]

/** A table's rows inside the company the request set, of a project that publishes itself: what every project-scoped table the door reads is bounded by. */
const inPublishedProject = (table: string) =>
  `${IN_COMPANY} and exists (select 1 from "wms"."project" "published" where "published"."company_id" = ${quoted(table)}.${quoted("company_id")} and "published"."id" = ${quoted(table)}.${quoted("project_id")} and "published"."public_slug" is not null)`

/**
 * What the collection days by address (#293 M2) opened: the property's
 * address and the plan's inputs — its subscriptions' periods, the placements
 * of its containers and their fractions, the groups that collect them, their
 * schemes' recurrence and the routes standing, the project's working week
 * and holidays. No customer, party, contact, agreement, price or ticket
 * column: what a resident is told is dates, fractions and a holiday's name.
 */
export const COLLECTION_DAYS_DOOR: readonly PublicDoorTable[] = [
  { table: project, columns: [project.weekend, project.holidayList], rows: null },
  { table: property, columns: [property.id, property.companyId, property.projectId, property.address], rows: inPublishedProject("property") },
  {
    table: subscription,
    columns: [subscription.id, subscription.companyId, subscription.projectId, subscription.propertyId, subscription.validFrom, subscription.validTo],
    rows: inPublishedProject("subscription"),
  },
  {
    table: containerServicePlacement,
    columns: [
      containerServicePlacement.companyId,
      containerServicePlacement.projectId,
      containerServicePlacement.containerId,
      containerServicePlacement.subscriptionId,
      containerServicePlacement.wasteFractionId,
      containerServicePlacement.validFrom,
      containerServicePlacement.validTo,
    ],
    rows: inPublishedProject("container_service_placement"),
  },
  {
    table: collectionGroup,
    columns: [collectionGroup.id, collectionGroup.companyId, collectionGroup.projectId, collectionGroup.routeSchemeId, collectionGroup.position, collectionGroup.days, collectionGroup.stopSource],
    rows: inPublishedProject("collection_group"),
  },
  {
    table: collectionGroupContainer,
    columns: [collectionGroupContainer.companyId, collectionGroupContainer.projectId, collectionGroupContainer.collectionGroupId, collectionGroupContainer.containerId],
    rows: inPublishedProject("collection_group_container"),
  },
  {
    table: generationMatch,
    columns: [generationMatch.id, generationMatch.companyId, generationMatch.projectId, generationMatch.collectionGroupId, generationMatch.containerIds],
    rows: inPublishedProject("generation_match"),
  },
  {
    table: routeScheme,
    columns: [
      routeScheme.id,
      routeScheme.companyId,
      routeScheme.projectId,
      routeScheme.frequency,
      routeScheme.serviceDays,
      routeScheme.weekRotation,
      routeScheme.validFrom,
      routeScheme.validTo,
      routeScheme.holidayPolicy,
      routeScheme.status,
    ],
    rows: inPublishedProject("route_scheme"),
  },
  {
    table: route,
    columns: [route.id, route.companyId, route.projectId, route.collectionGroupId, route.serviceDate, route.operatingDate, route.status, route.cancelledByGeneration, route.heldAt],
    rows: inPublishedProject("route"),
  },
  {
    table: collectionCalendarHoliday,
    columns: [collectionCalendarHoliday.companyId, collectionCalendarHoliday.projectId, collectionCalendarHoliday.day, collectionCalendarHoliday.name],
    rows: inPublishedProject("collection_calendar_holiday"),
  },
]

/** Every table and column the public role may read, and nothing else, as the migrations together grant them: the test that holds the database to them reads this. */
/**
 * What a subscription's pause (#291, slice 10b) opens to the collection days:
 * the pause's days under its subscription, so a paused address shows no day
 * generation will not plan. The keys the read is fenced by and the period,
 * nothing else.
 */
export const SUBSCRIPTION_PAUSE_DOOR: readonly PublicDoorTable[] = [
  {
    table: subscriptionPause,
    columns: [subscriptionPause.companyId, subscriptionPause.projectId, subscriptionPause.subscriptionId, subscriptionPause.validFrom, subscriptionPause.validTo],
    rows: inPublishedProject("subscription_pause"),
  },
]

export const PUBLIC_DOOR_TABLES: readonly { table: PgTable; columns: readonly PgColumn[] }[] = (() => {
  const merged = new Map<PgTable, PgColumn[]>()
  for (const { table, columns } of [...SORTING_GUIDE_DOOR, ...COLLECTION_DAYS_DOOR, ...SUBSCRIPTION_PAUSE_DOOR]) merged.set(table, [...(merged.get(table) ?? []), ...columns])
  return [...merged].map(([table, columns]) => ({ table, columns }))
})()

/** The role: created once per cluster, tolerating another database's migrator having done so a moment ago; held by the API's role to SET and not to inherit, and by the owner so a test can look through its eyes. */
export function publicRoleStatements(): string[] {
  return [
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PUBLIC_ROLE}') THEN
    BEGIN
      CREATE ROLE ${PUBLIC_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    EXCEPTION
      WHEN duplicate_object OR unique_violation THEN
        NULL;
    END;
  END IF;
END
$$;`,
    `DO $$
BEGIN
  BEGIN
    EXECUTE format('GRANT ${PUBLIC_ROLE} TO %I', current_user);
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END
$$;`,
    `GRANT ${PUBLIC_ROLE} TO ${API_ROLE} WITH INHERIT FALSE, SET TRUE;`,
    `GRANT USAGE ON SCHEMA wms TO ${PUBLIC_ROLE};`,
  ]
}

/** One column-list GRANT SELECT per table, in the list's order. */
export const publicGrantStatements = (tables: readonly PublicDoorTable[]): string[] =>
  tables.map(({ table, columns }) => `GRANT SELECT (${columns.map((column) => quoted(columnName(column))).join(", ")}) ON ${qualifiedTable(table, HELPER)} TO ${PUBLIC_ROLE};`)

/** One SELECT policy per table that brings its rows, for the public role, named `<table>_public_door`. */
export const publicPolicyStatements = (tables: readonly PublicDoorTable[]): string[] =>
  tables.flatMap(({ table, rows }) =>
    rows === null
      ? []
      : [
          `CREATE POLICY ${quoted(tableObjectName(table, PUBLIC_DOOR_POLICY, HELPER))} ON ${qualifiedTable(table, HELPER)} AS PERMISSIVE FOR SELECT TO ${PUBLIC_ROLE} USING (${rows});`,
        ],
  )

/** Everything migration 0017 carries for the door below the tables' statements, in order: the role, its grants, its policies. */
export const publicDoorStatements = (): string[] => [...publicRoleStatements(), ...publicGrantStatements(SORTING_GUIDE_DOOR), ...publicPolicyStatements(SORTING_GUIDE_DOOR)]

/** Everything the collection days' migration carries (#293 M2): the grants, then the policies of the tables it opens. */
export const collectionDaysDoorStatements = (): string[] => [...publicGrantStatements(COLLECTION_DAYS_DOOR), ...publicPolicyStatements(COLLECTION_DAYS_DOOR)]

/** What the subscription pause's migration carries for the door (#291 slice 10b), below the table's own statements: its grant, then its policy. */
export const subscriptionPauseDoorStatements = (): string[] => [...publicGrantStatements(SUBSCRIPTION_PAUSE_DOOR), ...publicPolicyStatements(SUBSCRIPTION_PAUSE_DOOR)]
