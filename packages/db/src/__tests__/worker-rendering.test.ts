// Migration 0011 pinned without a database (Issue #97 part B): the file is
// hand-written whole, so the test holds it to the one spelling in
// sql/pgboss.ts — the worker role's statements, pg-boss's construction plan
// as the pinned pg-boss writes it, split the way the migrator splits a file,
// and the grants below — and holds the splitter to what it promises: the
// transaction wrapper dropped, a dollar-quoted body or a string literal never
// split, every statement ending in one semicolon. And it holds the pin: the
// schema version the file installed is the one the pinned pg-boss expects,
// so a pg-boss upgrade that moves its schema version fails here, where the
// answer is a new migration file, and not at the worker's start().
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { getConstructionPlans, getMigrationPlans } from "pg-boss"

import { MIGRATIONS_FOLDER } from "../migrate"
import { API_ROLE, WORKER_ROLE } from "../roles"
import { normalised, statementsOf } from "../sql/hand-written"
import { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION, pgbossGrantStatements, pgbossSchemaVersionOf, pgbossStatementsOf, workerRoleStatements, workerStatements } from "../sql/pgboss"

const MIGRATION = "0011_worker.sql"

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the worker role", () => {
  test("wms_worker is created BYPASSRLS and NOLOGIN, tolerating the race, granted to the owner, with USAGE on wms and extensions, SELECT on every wms table present and future, and the API role's search path", () => {
    const [role, grant, wms, extensions, select, future, path] = workerRoleStatements()
    assert.equal(WORKER_ROLE, "wms_worker")
    assert.match(role, /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'wms_worker'\)/)
    assert.match(role, /CREATE ROLE wms_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;/)
    assert.doesNotMatch(role, /REPLICATION/, "the worker replicates nothing")
    assert.match(role, /WHEN duplicate_object OR unique_violation THEN/)
    assert.match(grant, /GRANT wms_worker TO %I', current_user/)
    assert.equal(wms, "GRANT USAGE ON SCHEMA wms TO wms_worker;")
    assert.equal(extensions, "GRANT USAGE ON SCHEMA extensions TO wms_worker;")
    assert.equal(select, "GRANT SELECT ON ALL TABLES IN SCHEMA wms TO wms_worker;")
    assert.equal(future, "ALTER DEFAULT PRIVILEGES IN SCHEMA wms GRANT SELECT ON TABLES TO wms_worker;")
    assert.match(path, /ALTER ROLE wms_worker SET search_path = wms, extensions;/)
    assert.equal(workerRoleStatements().length, 7)
    for (const statement of workerRoleStatements()) {
      assert.doesNotMatch(statement, /INSERT|UPDATE|DELETE|TRUNCATE/, "no write right anywhere in wms")
    }
  })
})

describe("pg-boss's plan as a migration carries it", () => {
  const plan = getConstructionPlans(PGBOSS_SCHEMA)

  test("the schema is pgboss, pg-boss's own default, and the plan installs the version the module pins", () => {
    assert.equal(PGBOSS_SCHEMA, "pgboss")
    assert.equal(pgbossSchemaVersionOf(plan), PGBOSS_SCHEMA_VERSION, "the pinned pg-boss installs another schema version: 0011 is applied, so the upgrade is a new migration from getMigrationPlans, and PGBOSS_SCHEMA_VERSION moves with it")
    assert.throws(() => pgbossSchemaVersionOf("CREATE SCHEMA x;"), /inserts no version row/)
  })

  test("the transaction wrapper is dropped: no BEGIN, no COMMIT, no SET LOCAL, no advisory lock", () => {
    assert.match(plan, /^\s*BEGIN;/m)
    assert.match(plan, /COMMIT;\s*$/)
    assert.match(plan, /pg_advisory_xact_lock/)
    const statements = pgbossStatementsOf(plan)
    for (const statement of statements) {
      assert.doesNotMatch(statement, /^(BEGIN|COMMIT|SET LOCAL|SELECT pg_advisory_xact_lock)/i, statement.slice(0, 60))
    }
  })

  test("every statement ends in exactly one semicolon, begins with a word, and names the schema", () => {
    const statements = pgbossStatementsOf(plan)
    assert.ok(statements.length > 30, `${statements.length} statements`)
    for (const statement of statements) {
      assert.match(statement, /^[A-Za-z]/, statement.slice(0, 60))
      assert.match(statement, /[^;];$/, statement.slice(-60))
      assert.match(statement, /pgboss/, statement.slice(0, 60))
    }
    assert.equal(statements[0], `CREATE SCHEMA IF NOT EXISTS ${PGBOSS_SCHEMA};`)
    assert.equal(statements.at(-1), `INSERT INTO ${PGBOSS_SCHEMA}.version(version) VALUES ('${PGBOSS_SCHEMA_VERSION}');`)
  })

  test("a semicolon inside a dollar-quoted body or a string literal never splits", () => {
    assert.deepEqual(pgbossStatementsOf("CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END $$ LANGUAGE plpgsql; SELECT 1"), [
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END $$ LANGUAGE plpgsql;",
      "SELECT 1;",
    ])
    assert.deepEqual(pgbossStatementsOf("SELECT run($cmd$ALTER TABLE t ADD x int; DROP y$cmd$, 'a;b'); SELECT 'it''s; here'"), [
      "SELECT run($cmd$ALTER TABLE t ADD x int; DROP y$cmd$, 'a;b');",
      "SELECT 'it''s; here';",
    ])
    assert.deepEqual(pgbossStatementsOf("BEGIN;\nSET LOCAL lock_timeout = 30000;\nSELECT pg_advisory_xact_lock(1);\nCREATE SCHEMA x;\nCOMMIT;\n"), ["CREATE SCHEMA x;"])
    // The plan's own function bodies: every $$ opened is closed inside one statement.
    for (const statement of pgbossStatementsOf(plan)) {
      assert.equal((statement.match(/\$\$/g) ?? []).length % 2, 0, statement.slice(0, 60))
      assert.equal((statement.match(/\$cmd\$/g) ?? []).length % 2, 0, statement.slice(0, 60))
    }
  })

  test("a migration plan from the pinned version does not exist: nothing to upgrade while the pin holds", () => {
    // pg-boss answers a plan from an older version and refuses one from the current, so the refusal is the proof the pin is current.
    assert.throws(() => getMigrationPlans(PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION), new RegExp(`Version ${PGBOSS_SCHEMA_VERSION} not found`))
    assert.match(pgbossStatementsOf(getMigrationPlans(PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION - 1)).join("\n"), /pgboss\.version/, "from one version back there is a plan, and it moves the version row")
  })

  test("both application roles may use the schema, read and write its tables and run its functions, present and future, and neither may create in it", () => {
    const grants = pgbossGrantStatements()
    assert.equal(grants.length, 5)
    for (const grant of grants) {
      assert.match(grant, new RegExp(`TO ${API_ROLE}, ${WORKER_ROLE};$`))
      assert.doesNotMatch(grant, /CREATE|ALL PRIVILEGES/)
    }
    assert.equal(grants[0], `GRANT USAGE ON SCHEMA pgboss TO ${API_ROLE}, ${WORKER_ROLE};`)
    assert.equal(grants.filter((grant) => grant.startsWith("ALTER DEFAULT PRIVILEGES")).length, 2)
  })
})

describe("migration 0011", () => {
  test("carries exactly the role, pg-boss's plan and the grants, in that order, one statement per breakpoint", async () => {
    const statements = await fileStatements()
    const expected = workerStatements(getConstructionPlans(PGBOSS_SCHEMA)).map(normalised)
    assert.equal(statements.length, expected.length, `7 role statements, ${pgbossStatementsOf(getConstructionPlans(PGBOSS_SCHEMA)).length} of pg-boss's, 5 grants`)
    assert.deepEqual(statements, expected)
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE TABLE")).length, 10, "version, queue, schedule, subscription, bam, job, job_common (by LIKE), warning, queue_stats, job_dependency")
    assert.equal(statements.filter((statement) => /^(BEGIN|COMMIT)/.test(statement)).length, 0)
  })

  test("names the schema version it installed in its header, the same number the module pins", async () => {
    const file = await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8")
    assert.match(file, new RegExp(`schema version ${PGBOSS_SCHEMA_VERSION}\\b`))
  })
})
