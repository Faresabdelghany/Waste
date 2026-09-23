import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { databaseUnderTest, isDatabaseRequired, LOCAL_STACK_HINT } from "../database-under-test"

const ADMIN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
const APP = "postgresql://wms_api:wms_api@127.0.0.1:54322/postgres"
const both = ["DATABASE_ADMIN_URL", "DATABASE_URL"] as const

describe("databaseUnderTest", () => {
  test("runs, handing back every URL, when all the named variables are set", () => {
    const found = databaseUnderTest(both, { hint: LOCAL_STACK_HINT, env: { DATABASE_ADMIN_URL: ADMIN, DATABASE_URL: APP } })
    assert.deepEqual(found, { skip: false, urls: { DATABASE_ADMIN_URL: ADMIN, DATABASE_URL: APP } })
  })

  test("skips, naming exactly the missing variables and the hint, when one is unset or empty and nothing requires it", () => {
    const missingOne = databaseUnderTest(both, { hint: LOCAL_STACK_HINT, env: { DATABASE_ADMIN_URL: ADMIN, DATABASE_URL: "" } })
    assert.equal(missingOne.skip, `DATABASE_URL is not set: ${LOCAL_STACK_HINT}`)
    assert.deepEqual(missingOne.urls, { DATABASE_ADMIN_URL: ADMIN, DATABASE_URL: "" })
    const missingBoth = databaseUnderTest(both, { hint: "see the README", env: {} })
    assert.equal(missingBoth.skip, "DATABASE_ADMIN_URL and DATABASE_URL are not set: see the README")
  })

  test("fails instead of skipping when REQUIRE_DATABASE is set, naming the missing variables", () => {
    assert.throws(
      () => databaseUnderTest(["DATABASE_URL"], { hint: LOCAL_STACK_HINT, env: { REQUIRE_DATABASE: "1" } }),
      /^Error: REQUIRE_DATABASE is set, but DATABASE_URL is not$/,
    )
    assert.throws(
      () => databaseUnderTest(both, { hint: LOCAL_STACK_HINT, env: { REQUIRE_DATABASE: "true", DATABASE_URL: APP } }),
      /REQUIRE_DATABASE is set, but DATABASE_ADMIN_URL is not/,
    )
    assert.throws(() => databaseUnderTest(both, { hint: LOCAL_STACK_HINT, env: { REQUIRE_DATABASE: "yes" } }), /DATABASE_ADMIN_URL and DATABASE_URL are not/)
  })

  test("REQUIRE_DATABASE is on unless unset, empty, 0 or false, whatever the case", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " "]) {
      assert.equal(isDatabaseRequired({ REQUIRE_DATABASE: value }), true, JSON.stringify(value))
    }
    for (const value of [undefined, "", "0", "false", "False", "FALSE"]) {
      assert.equal(isDatabaseRequired({ REQUIRE_DATABASE: value }), false, JSON.stringify(value))
    }
    assert.equal(typeof databaseUnderTest(both, { hint: LOCAL_STACK_HINT, env: { REQUIRE_DATABASE: "0" } }).skip, "string")
  })

  test("the hint names the commands that bring the local stack up", () => {
    for (const command of ["pnpm db:start", "pnpm db:migrate", "pnpm db:bootstrap", ".env.example"]) {
      assert.ok(LOCAL_STACK_HINT.includes(command), command)
    }
  })
})
