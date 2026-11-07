// The public door's role (Issue #293, ADR-0010): the statements that make it
// and open a table to it, copied into the migration that creates the role or
// opens the table, as the worker role's statements are (pgboss.ts). What it
// may read of a table — its columns and its rows — is the table's own
// declaration (`door`, schema/policies.ts), gathered as `PUBLIC_DOOR_TABLES`
// in table-policies.ts, which public-door.test.ts holds the database to.
//
// `wms_public` logs in as nobody. The API's own connection, `wms_api`, holds
// it with SET and without INHERIT, so a public request's transaction says
// `SET LOCAL ROLE wms_public` (public-door.ts at the package root) and every
// statement after that runs with this role's rights alone, never the API's;
// the setting ends with the transaction. The role owns nothing, bypasses
// nothing, and holds SELECT on exactly the columns the tables declare — a column left out
// is a column no public answer can carry, whatever a route's code asks — and
// no other right on any table. The default privileges of 0001 and 0011 name
// `wms_api` and `wms_worker` only, so a table added later is one this role
// cannot read until a migration grants it.
//
// Its rows are its own policies', since every table's tenant fence is
// written `TO wms_api` and forced: a project is visible while it publishes
// itself (`public_slug` set), and that row is how a request finds the company
// it then sets with `wms.company_id`; a fraction is visible inside that
// company. Granted to the owner as well, so a test can look through its eyes.
import { columnName, qualifiedTable, quoted, tableObjectName } from "../names"
import { API_ROLE, PUBLIC_ROLE } from "../roles"
import type { PublicDoorTable } from "../table-policies"

const HELPER = "publicDoor"

/** The suffix of each table's policy for the public role. */
export const PUBLIC_DOOR_POLICY = "public_door"

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
export const publicGrantStatements = (tables: readonly Pick<PublicDoorTable, "table" | "columns">[]): string[] =>
  tables.map(({ table, columns }) => `GRANT SELECT (${columns.map((column) => quoted(columnName(column))).join(", ")}) ON ${qualifiedTable(table, HELPER)} TO ${PUBLIC_ROLE};`)

/** One SELECT policy per table that brings its rows, for the public role, named `<table>_public_door`. */
export const publicPolicyStatements = (tables: readonly Pick<PublicDoorTable, "table" | "rows">[]): string[] =>
  tables.map(({ table, rows }) => `CREATE POLICY ${quoted(tableObjectName(table, PUBLIC_DOOR_POLICY, HELPER))} ON ${qualifiedTable(table, HELPER)} AS PERMISSIVE FOR SELECT TO ${PUBLIC_ROLE} USING (${rows});`)
