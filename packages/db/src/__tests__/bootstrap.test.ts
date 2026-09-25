import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { planLocalBootstrap, planSyncBootstrap } from "../bootstrap"
import { API_ROLE, SYNC_ROLE } from "../roles"

const adminUrl = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

describe("planLocalBootstrap", () => {
  test("takes the API role's password from DATABASE_URL, percent-decoded", () => {
    const plan = planLocalBootstrap({ adminUrl, appUrl: `postgresql://${API_ROLE}:p%40ss%2Fword@127.0.0.1:54322/postgres` })
    assert.deepEqual(plan, { adminUrl, role: API_ROLE, password: "p@ss/word" })
  })

  test("refuses an admin URL that is not the local stack", () => {
    assert.throws(
      () =>
        planLocalBootstrap({
          adminUrl: "postgresql://postgres.ref:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres",
          appUrl: `postgresql://${API_ROLE}:pw@127.0.0.1:54322/postgres`,
        }),
      /local stack.*aws-0-eu-north-1\.pooler\.supabase\.com/,
    )
  })

  test("refuses a DATABASE_URL whose user is not the API role", () => {
    assert.throws(
      () => planLocalBootstrap({ adminUrl, appUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" }),
      /DATABASE_URL logs in as "postgres", not "wms_api"/,
    )
  })

  test("refuses an empty password", () => {
    assert.throws(() => planLocalBootstrap({ adminUrl, appUrl: `postgresql://${API_ROLE}@127.0.0.1:54322/postgres` }), /password/)
  })
})

describe("planSyncBootstrap", () => {
  test("takes the sync role's password from SYNC_DATABASE_URL, the same rules under the other name (Issue #104)", () => {
    assert.deepEqual(planSyncBootstrap({ adminUrl, syncUrl: `postgresql://${SYNC_ROLE}:s%40ync@127.0.0.1:54322/postgres` }), { adminUrl, role: SYNC_ROLE, password: "s@ync" })
  })

  test("refuses a hosted admin URL, a SYNC_DATABASE_URL logging in as anyone else, and an empty password, naming the variable", () => {
    assert.throws(
      () => planSyncBootstrap({ adminUrl: "postgresql://postgres.ref:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres", syncUrl: `postgresql://${SYNC_ROLE}:pw@127.0.0.1:54322/postgres` }),
      /local stack.*ALTER ROLE wms_sync WITH LOGIN PASSWORD/,
    )
    assert.throws(() => planSyncBootstrap({ adminUrl, syncUrl: `postgresql://${API_ROLE}:pw@127.0.0.1:54322/postgres` }), /SYNC_DATABASE_URL logs in as "wms_api", not "wms_sync"/)
    assert.throws(() => planSyncBootstrap({ adminUrl, syncUrl: `postgresql://${SYNC_ROLE}@127.0.0.1:54322/postgres` }), /SYNC_DATABASE_URL carries no password for the wms_sync role/)
  })
})
