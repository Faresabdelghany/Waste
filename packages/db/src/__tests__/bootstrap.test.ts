import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"

import { planLocalBootstrap } from "../bootstrap"
import { API_ROLE, GRANTED_ROLES, OWNER, WORKER_ROLE } from "../roles"
import { databasePort } from "../supabase-config"

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
      /local stack.*aws-0-eu-north-1\.pooler\.supabase\.com.*logins for wms_api and wms_worker are the Pilot database workflow's grant-logins operation/,
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

/** A file of the repository: this one is packages/db/src/__tests__/bootstrap.test.ts. */
const repositoryFile = (file: string): string => readFileSync(new URL(`../../../../${file}`, import.meta.url), "utf8")

// The local stack's URLs are spelled where a person copies them (.env.example)
// and where CI sets them for every job (ci.yml's workflow `env`), neither of
// which can read roles.ts; held here to it through the plan bootstrap makes.
describe("the local stack's URLs as the repository spells them", () => {
  const spellings: [string, (variable: string) => RegExp][] = [
    [".env.example", (variable) => new RegExp(`^${variable}=(\\S+)$`, "m")],
    [".github/workflows/ci.yml", (variable) => new RegExp(`^  ${variable}: (\\S+)$`, "m")],
  ]
  for (const [file, spelled] of spellings) {
    test(`${file} logs each role in as itself, with a password, on the local stack's port: a plan that gives every role its login`, () => {
      const text = repositoryFile(file)
      const env = Object.fromEntries([OWNER, ...GRANTED_ROLES].map((role) => [role.urls.local, spelled(role.urls.local).exec(text)?.[1]]))
      assert.deepEqual(
        planLocalBootstrap(env).logins.map((login) => login.role),
        GRANTED_ROLES.map((role) => role.name),
      )
      for (const [variable, url] of Object.entries(env)) assert.equal(new URL(url ?? "").port, String(databasePort()), `${variable} names the local stack's port`)
    })
  }
})
