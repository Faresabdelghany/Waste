// pg-boss's plan as a migration carries it (Issue #97 part B), without a
// database: the splitter (sql/pgboss.ts) drops the transaction wrapper and
// never splits a dollar-quoted body or a string literal, every statement
// ending in one semicolon; the grants give both application roles the schema
// and neither the right to create in it. And the pin: the schema version the
// pinned pg-boss installs is `PGBOSS_SCHEMA_VERSION`, so a pg-boss upgrade
// that moves its schema version fails here, where the answer is a new
// migration file, and not at the worker's start().
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { getConstructionPlans, getMigrationPlans } from "pg-boss"

import { API_ROLE, WORKER_ROLE } from "../roles"
import { PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION, pgbossGrantStatements, pgbossSchemaVersionOf, pgbossStatementsOf } from "../sql/pgboss"

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

