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
import { wasteFraction } from "../schema/catalogue"
import { project } from "../schema/organisation"
import { sortingGuideItem } from "../schema/sorting-guide"

const HELPER = "publicDoor"

/** The suffix of each table's policy for the public role. */
export const PUBLIC_DOOR_POLICY = "public_door"

/** A table the public door reads: the columns it may SELECT, and the rows, as a policy's predicate. */
export type PublicDoorTable = { table: PgTable; columns: readonly PgColumn[]; rows: string }

const IN_COMPANY = `${quoted("company_id")} = (select wms.current_company_id())`

/** Every table and column the public role may read, and nothing else: the grants, the policies and the test that holds the database to them all read this. */
export const PUBLIC_DOOR_TABLES: readonly PublicDoorTable[] = [
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
export const publicGrantStatements = (): string[] =>
  PUBLIC_DOOR_TABLES.map(({ table, columns }) => `GRANT SELECT (${columns.map((column) => quoted(columnName(column))).join(", ")}) ON ${qualifiedTable(table, HELPER)} TO ${PUBLIC_ROLE};`)

/** One SELECT policy per table for the public role, named `<table>_public_door`. */
export const publicPolicyStatements = (): string[] =>
  PUBLIC_DOOR_TABLES.map(
    ({ table, rows }) =>
      `CREATE POLICY ${quoted(tableObjectName(table, PUBLIC_DOOR_POLICY, HELPER))} ON ${qualifiedTable(table, HELPER)} AS PERMISSIVE FOR SELECT TO ${PUBLIC_ROLE} USING (${rows});`,
  )

/** Everything the migration carries for the door below the tables' statements, in order: the role, its grants, its policies. */
export const publicDoorStatements = (): string[] => [...publicRoleStatements(), ...publicGrantStatements(), ...publicPolicyStatements()]
