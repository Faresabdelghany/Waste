import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { databaseUnderTest } from "./database"

const local = {
  DATABASE_ADMIN_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  DATABASE_URL: "postgresql://wms_api:wms_api@127.0.0.1:54322/postgres",
}

describe("databaseUnderTest", () => {
  test("skips, naming the missing variables and the commands, when a URL is missing and nothing requires one", () => {
    const result = databaseUnderTest({})
    assert.match(String(result.skip), /DATABASE_ADMIN_URL and DATABASE_URL are not set/)
    assert.match(String(result.skip), /pnpm db:start/)
    assert.match(String(result.skip), /pnpm db:migrate/)
    assert.match(String(databaseUnderTest({ DATABASE_ADMIN_URL: local.DATABASE_ADMIN_URL }).skip), /^DATABASE_URL is not set/)
  })

  test("fails instead of skipping when REQUIRE_DATABASE is set", () => {
    assert.throws(() => databaseUnderTest({ REQUIRE_DATABASE: "1" }), /DATABASE_ADMIN_URL and DATABASE_URL are not/)
    assert.throws(
      () => databaseUnderTest({ REQUIRE_DATABASE: "1", DATABASE_ADMIN_URL: local.DATABASE_ADMIN_URL }),
      /DATABASE_URL is not/,
    )
  })

  test("REQUIRE_DATABASE=0 or false counts as unset", () => {
    assert.equal(typeof databaseUnderTest({ REQUIRE_DATABASE: "0" }).skip, "string")
    assert.equal(typeof databaseUnderTest({ REQUIRE_DATABASE: "false" }).skip, "string")
  })

  test("runs against loopback hosts, whatever their case", () => {
    assert.equal(databaseUnderTest(local).skip, false)
    assert.equal(
      databaseUnderTest({
        DATABASE_ADMIN_URL: "postgresql://postgres:postgres@LOCALHOST:54322/postgres",
        DATABASE_URL: "postgresql://wms_api:wms_api@[::1]:54322/postgres",
      }).skip,
      false,
    )
  })

  test("refuses a URL that is not the local stack, naming the variable", () => {
    assert.throws(
      () =>
        databaseUnderTest({
          ...local,
          DATABASE_ADMIN_URL: "postgresql://postgres.ref:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres",
        }),
      /DATABASE_ADMIN_URL points at aws-0-eu-north-1\.pooler\.supabase\.com.*local stack only/,
    )
    assert.throws(
      () => databaseUnderTest({ ...local, DATABASE_URL: "postgresql://wms_api.ref:pw@db.ref.supabase.co:5432/postgres" }),
      /DATABASE_URL points at db\.ref\.supabase\.co/,
    )
  })
})
