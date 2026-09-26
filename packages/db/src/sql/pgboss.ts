// The Postgres side of the worker (Issue #97 part B, ADR-0007): the role its
// pg-boss connects as and the schema pg-boss runs on, hand-written into
// `0011_worker.sql` the way `0008_execution.sql` carries the sync role and the
// publication below its tables. Neither is a table's, so the gate in
// hand-written.ts knows nothing of them, and this module is the one spelling
// the file is copied from and the rendering test holds it to.
//
// `wms_worker` carries what the worker's sweeps need and nothing else:
// `BYPASSRLS`, because the one kind of statement in the system that reads
// across tenants — "which validated schemes want planning ahead", "which
// outbox rows are unpublished" — runs as this role, and forced row-level
// security would otherwise show it no rows at all; `USAGE` on `wms` and
// `extensions` and the API role's `search_path`, so a geometry column reads
// as it does for the API; `SELECT` on every `wms` table, present and future
// (a default privilege bound to the owner, as `wms_api`'s are), and no write
// right on any of them, so "every write runs fenced as `wms_api` under
// `withCompany`" is a rule the database holds and not one the worker's code
// promises — an INSERT as `wms_worker` is 42501; and `NOLOGIN`, since a
// password is given per environment by bootstrap.ts and never by a
// migration. The owner is granted membership, as it is in `wms_api` and
// `wms_sync`, so a test can `SET LOCAL ROLE wms_worker` and see what the
// worker sees. The role statements tolerate the concurrent-creation race the
// way `wms_api`'s do, roles being cluster-wide while the migrator's lock is
// per database.
//
// pg-boss's schema `pgboss` is installed by the owner, from the construction
// plan the pinned pg-boss exports (`getConstructionPlans`), and never by
// `boss.start()` as a role that owns nothing: the worker and the API both run
// pg-boss with `migrate: false`, and `start()` refuses a database whose
// `pgboss.version` is not the one the library expects, so a pg-boss upgrade
// that moves its schema version is a new migration file carrying
// `getMigrationPlans(PGBOSS_SCHEMA, <the version 0011 installed>)` through
// `pgbossStatementsOf`, and the rendering test says so when the two drift.
// The pin is exact — `"pg-boss": "12.34.0"` in this package and in
// `apps/worker`, no caret — so a `pnpm update` cannot move the library, and
// with it the plan and `PGBOSS_SCHEMA_VERSION`, without someone writing the
// migration first; a bump is a deliberate edit of both package.json files.
// The plan comes wrapped in pg-boss's own transaction — `BEGIN`, two `SET
// LOCAL`s, an advisory lock, `COMMIT` — which the migrator must not run: it
// applies every file in one transaction of its own, and a `COMMIT` inside it
// would commit the journal's half-written state. `pgbossStatementsOf` strips
// that wrapper and splits what is left into statements at the top-level
// semicolons, dollar-quoted function bodies and string literals left whole,
// so each lands behind its own `--> statement-breakpoint`.
//
// Both application roles get `USAGE` on `pgboss`, `SELECT, INSERT, UPDATE,
// DELETE` on its tables and `EXECUTE` on its functions, present and future:
// the worker to run pg-boss, the API to `send` a job in the request's
// transaction (#97's `POST /route-schemes/:id/generate`). Neither gets
// `CREATE` on the schema, so a partitioned queue (`partition: true`, whose
// `create_queue` makes a table as the caller) and pg-boss's persisted queue
// statistics (daily partitions, made the same way) are not available to
// them; the worker leaves both off.
import { WORKER_ROLE, API_ROLE } from "../roles"

/** The schema pg-boss runs on, pg-boss's own default name; `PgBoss({ schema })` in both processes. */
export const PGBOSS_SCHEMA = "pgboss"

/** pg-boss's schema version as `0011_worker` installed it: what `pgboss.version` holds, and what the pinned pg-boss must expect. */
export const PGBOSS_SCHEMA_VERSION = 42

/** The role: created once per cluster, tolerating another database's migrator having done so a moment ago, then granted to the owner so a test can look through its eyes, given the API role's schemas and search path, and SELECT on every wms table there is and will be. */
export function workerRoleStatements(): string[] {
  return [
    `DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WORKER_ROLE}') THEN
    BEGIN
      CREATE ROLE ${WORKER_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
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
    EXECUTE format('GRANT ${WORKER_ROLE} TO %I', current_user);
  EXCEPTION
    WHEN unique_violation THEN
      NULL;
  END;
END
$$;`,
    `GRANT USAGE ON SCHEMA wms TO ${WORKER_ROLE};`,
    `GRANT USAGE ON SCHEMA extensions TO ${WORKER_ROLE};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA wms TO ${WORKER_ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT ON TABLES TO ${WORKER_ROLE};`,
    `DO $$
BEGIN
  BEGIN
    ALTER ROLE ${WORKER_ROLE} SET search_path = wms, extensions;
  EXCEPTION
    WHEN unique_violation THEN
      ALTER ROLE ${WORKER_ROLE} SET search_path = wms, extensions;
  END;
END
$$;`,
  ]
}

/** The wrapper pg-boss puts around a plan, statement by statement: what the migrator must not run, since it holds a transaction of its own. */
const WRAPPER = [/^BEGIN$/i, /^SET LOCAL \w+ = \d+$/i, /^SELECT pg_advisory_xact_lock\(/i, /^COMMIT$/i]

/**
 * A pg-boss plan (`getConstructionPlans`, `getMigrationPlans`) as the
 * statements a migration file carries: pg-boss's transaction wrapper dropped
 * and the rest split at the top-level semicolons, each statement trimmed and
 * ending in one semicolon. A semicolon inside a dollar-quoted body (`$$ … $$`,
 * `$cmd$ … $cmd$`) or a string literal does not split.
 */
export function pgbossStatementsOf(plan: string): string[] {
  const statements: string[] = []
  let current = ""
  let quote: string | undefined
  for (let index = 0; index < plan.length; index += 1) {
    const character = plan[index]
    if (quote !== undefined) {
      current += character
      if (plan.startsWith(quote, index)) {
        current += quote.slice(1)
        index += quote.length - 1
        quote = undefined
      }
      continue
    }
    if (character === "'") {
      quote = "'"
      current += character
      continue
    }
    if (character === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(plan.slice(index))
      if (tag) {
        quote = tag[0]
        current += tag[0]
        index += tag[0].length - 1
        continue
      }
    }
    if (character === ";") {
      statements.push(current)
      current = ""
      continue
    }
    current += character
  }
  statements.push(current)
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !WRAPPER.some((pattern) => pattern.test(statement)))
    .map((statement) => `${statement};`)
}

/** The schema version a construction plan installs: the one row it inserts into `pgboss.version`. */
export function pgbossSchemaVersionOf(plan: string): number {
  const match = /INSERT INTO \S+\.version\s*\(version\)\s*VALUES\s*\('(\d+)'\)/i.exec(plan)
  if (!match) throw new Error("pgbossSchemaVersionOf: the plan inserts no version row")
  return Number(match[1])
}

/** What both application roles may do in pg-boss's schema, present objects and future ones alike: run it, and send into it. */
export function pgbossGrantStatements(): string[] {
  const roles = `${API_ROLE}, ${WORKER_ROLE}`
  return [
    `GRANT USAGE ON SCHEMA ${PGBOSS_SCHEMA} TO ${roles};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PGBOSS_SCHEMA} TO ${roles};`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${PGBOSS_SCHEMA} TO ${roles};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${PGBOSS_SCHEMA} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${PGBOSS_SCHEMA} GRANT EXECUTE ON FUNCTIONS TO ${roles};`,
  ]
}

/** Everything `0011_worker` carries, in order: the role, pg-boss's schema from the given construction plan, the grants on it. */
export const workerStatements = (constructionPlan: string): string[] => [...workerRoleStatements(), ...pgbossStatementsOf(constructionPlan), ...pgbossGrantStatements()]
