// The Postgres side of PowerSync (Issue #104, ADR-0004): the role the sync
// service connects as and the publication it replicates, hand-written into
// `0008_execution.sql` below the tables' statements the way `0002` carries
// the access token hook below the eight tables' fences and triggers. Neither
// is a table's, so the gate in hand-written.ts knows nothing of them — they
// are nobody's table, like the hook — and this module is the one spelling
// the file is copied from and the rendering test holds it to.
//
// `wms_sync` carries what the sync service needs and nothing else:
// `REPLICATION`, to open a logical replication slot; `BYPASSRLS`, because
// forced row-level security would filter the initial snapshot for a role
// without it, and the service reads every tenant by construction — the
// fence a device gets is the sync rules' column lists, not the database's
// policies; `USAGE` on `wms`; `SELECT` on exactly the synced tables; and
// `NOLOGIN`, since a password is given per environment by bootstrap.ts and
// never by a migration. It owns nothing and may write nothing: an INSERT as
// it is 42501. The owner is granted membership, as it is in `wms_api`, so a
// test can `SET LOCAL ROLE wms_sync` and see what the service sees. The role
// statements tolerate the concurrent-creation race the way `wms_api`'s do,
// roles being cluster-wide while the migrator's lock is per database.
//
// `SYNCED_TABLES` are the tables the sync rules read (#104 §3, "Down"): the
// driver's own rows and everything a bucket's data query names — the route,
// its pickups, sessions, proofs, unloads and receipts, the places a pickup
// names, the catalogue the start and unload screens pick from — and
// `user_account`, which no bucket sends down but every parameter query joins
// to resolve the driver from the token's subject, and which PowerSync
// evaluates against its own replica; the sync rules' column lists keep its
// e-mail off every device. The publication is `FOR TABLE` over exactly this
// list, so a table the rules do not name is never replicated and a table
// added to the rules is added here first; part B's sync-rules test holds the
// YAML to this list. `route_leg` joins it when #97 B's slice 7 creates it.
import { getTableName } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { qualifiedTable } from "../names"
import { SYNC_ROLE } from "../roles"
import { userAccount } from "../schema/access"
import { containerType, wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { driverCommand, pickup, proofOfService, route, session, unload } from "../schema/execution"
import { driver, vehicle } from "../schema/fleet"
import { depot, unloadingStation, unloadingStationFraction } from "../schema/places"

const HELPER = "powersyncPublication"

/** The publication's name, as the sync service's connection names it. */
export const PUBLICATION = "powersync"

/** The tables the sync rules read, in the order the schema exports them: what the role may SELECT and the publication replicates, and nothing else. */
export const SYNCED_TABLES: readonly PgTable[] = [
  userAccount,
  wasteFraction,
  containerType,
  container,
  property,
  sharedCollectionPoint,
  depot,
  unloadingStation,
  unloadingStationFraction,
  vehicle,
  driver,
  route,
  pickup,
  session,
  proofOfService,
  unload,
  driverCommand,
]

/** The synced tables by name, for a test that reads `pg_publication_tables`. */
export const syncedTableNames = (): string[] => SYNCED_TABLES.map((table) => getTableName(table))

/** The role: created once per cluster, tolerating another database's migrator having done so a moment ago, then granted to the owner so a test can look through its eyes. */
export function syncRoleStatements(): string[] {
  return [
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${SYNC_ROLE}') THEN
    BEGIN
      CREATE ROLE ${SYNC_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION BYPASSRLS;
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
    EXECUTE format('GRANT ${SYNC_ROLE} TO %I', current_user);
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END
$$;`,
    `GRANT USAGE ON SCHEMA wms TO ${SYNC_ROLE};`,
  ]
}

/** One GRANT SELECT per synced table, in the list's order: a right per table, so a table left out of the list is a table the role cannot read. */
export const syncGrantStatements = (): string[] => SYNCED_TABLES.map((table) => `GRANT SELECT ON ${qualifiedTable(table, HELPER)} TO ${SYNC_ROLE};`)

/** The publication over exactly the synced tables. */
export const publicationStatement = (): string => `CREATE PUBLICATION ${PUBLICATION} FOR TABLE ${SYNCED_TABLES.map((table) => qualifiedTable(table, HELPER)).join(", ")};`

/** Everything the file carries below the tables' statements, in order: the role, its grants, the publication. */
export const powersyncStatements = (): string[] => [...syncRoleStatements(), ...syncGrantStatements(), publicationStatement()]
