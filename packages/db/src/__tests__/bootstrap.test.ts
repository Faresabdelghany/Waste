import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { planLocalBootstrap } from "../bootstrap"
import { API_ROLE, WORKER_ROLE } from "../roles"

const DATABASE_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
const DATABASE_URL = `postgresql://${API_ROLE}:p%40ss%2Fword@127.0.0.1:54322/postgres`
const WORKER_DATABASE_URL = `postgresql://${WORKER_ROLE}:w%40rker@127.0.0.1:54322/postgres`

describe("planLocalBootstrap", () => {
  test("takes each role's password from its URL, percent-decoded: the API role's from DATABASE_URL and the worker role's from WORKER_DATABASE_URL", () => {
    assert.deepEqual(planLocalBootstrap({ DATABASE_ADMIN_URL, DATABASE_URL, WORKER_DATABASE_URL }), {
      adminUrl: DATABASE_ADMIN_URL,
      logins: [
        { role: API_ROLE, password: "p@ss/word" },
        { role: WORKER_ROLE, password: "w@rker" },
      ],
      unset: [],
    })
  })

  test("leaves the worker role without a login where WORKER_DATABASE_URL is unset or empty, and refuses without DATABASE_URL or the admin URL (Issue #97 part B)", () => {
    for (const worker of [{}, { WORKER_DATABASE_URL: "" }]) {
      assert.deepEqual(planLocalBootstrap({ DATABASE_ADMIN_URL, DATABASE_URL, ...worker }), {
        adminUrl: DATABASE_ADMIN_URL,
        logins: [{ role: API_ROLE, password: "p@ss/word" }],
        unset: [{ role: WORKER_ROLE, variable: "WORKER_DATABASE_URL" }],
      })
    }
    assert.throws(() => planLocalBootstrap({ DATABASE_ADMIN_URL, WORKER_DATABASE_URL }), /^Error: DATABASE_URL must be set/)
    assert.throws(() => planLocalBootstrap({}), /^Error: DATABASE_ADMIN_URL and DATABASE_URL must be set/)
  })

  test("refuses an admin URL that is not the local stack", () => {
    assert.throws(
      () => planLocalBootstrap({ DATABASE_ADMIN_URL: "postgresql://postgres.ref:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres", DATABASE_URL, WORKER_DATABASE_URL }),
      /local stack.*aws-0-eu-north-1\.pooler\.supabase\.com.*ALTER ROLE .* WITH LOGIN PASSWORD .* for wms_api and wms_worker/,
    )
  })

  test("refuses a URL logging in as another role, or as its role of a Supabase project, and one without a password, naming the variable", () => {
    const refusals: [Record<string, string>, RegExp][] = [
      [{ DATABASE_URL: DATABASE_ADMIN_URL }, /^DATABASE_URL: logs in as postgres, not wms_api$/],
      [{ WORKER_DATABASE_URL: DATABASE_URL }, /^WORKER_DATABASE_URL: logs in as wms_api, not wms_worker$/],
      [{ DATABASE_URL: `postgresql://${API_ROLE}.abcdefghijklmnopqrst:pw@127.0.0.1:54322/postgres` }, /^DATABASE_URL: names another Supabase project$/],
      [{ DATABASE_URL: `postgresql://${API_ROLE}@127.0.0.1:54322/postgres` }, /^DATABASE_URL: carries no password$/],
      [{ WORKER_DATABASE_URL: `postgresql://${WORKER_ROLE}@127.0.0.1:54322/postgres` }, /^WORKER_DATABASE_URL: carries no password$/],
    ]
    for (const [override, reason] of refusals) {
      assert.throws(() => planLocalBootstrap({ DATABASE_ADMIN_URL, DATABASE_URL, WORKER_DATABASE_URL, ...override }), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, reason)
        return true
      })
    }
  })
})
