import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { planPilotLogins } from "../pilot/credentials"
import { expectPilot, targetOfUrl } from "../pilot/identity"

const REF = "abcdefghijklmnopqrst"
const HOST = "aws-0-eu-north-1.pooler.supabase.com"
const url = (user: string, password = "s3cret", host = HOST, port = "5432", database = "postgres") =>
  `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=require`

describe("targetOfUrl (Issue #152)", () => {
  test("reads the Supabase project from the session pooler's user or the direct host, and loopback as the local stack", () => {
    assert.deepEqual(targetOfUrl(url(`postgres.${REF}`)), { kind: "supabase", ref: REF })
    assert.deepEqual(targetOfUrl(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`), { kind: "supabase", ref: REF })
    assert.deepEqual(targetOfUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres"), { kind: "local" })
  })

  test("refuses a pooler URL that names no project and a host that is neither", () => {
    assert.throws(() => targetOfUrl(url("postgres")), /names no Supabase project/)
    assert.throws(() => targetOfUrl("postgresql://postgres:pw@db.example.com:5432/postgres"), /db\.example\.com is neither a Supabase project nor the local stack/)
  })
})

describe("expectPilot", () => {
  test("takes the Pilot's project when the workflow names it, and only the local stack when nothing does", () => {
    assert.deepEqual(expectPilot(url(`postgres.${REF}`), REF), { kind: "supabase", ref: REF })
    assert.deepEqual(expectPilot("postgresql://postgres:postgres@127.0.0.1:54322/postgres", undefined), { kind: "local" })
    assert.throws(() => expectPilot(url(`postgres.${"z".repeat(20)}`), REF), /Supabase project z{20}, not the Pilot's \(abcdefghijklmnopqrst\)/)
    assert.throws(() => expectPilot("postgresql://postgres:postgres@127.0.0.1:54322/postgres", REF), /the local stack, not the Pilot's/)
    assert.throws(() => expectPilot(url(`postgres.${REF}`), undefined), /PILOT_SUPABASE_REF is not set/)
    assert.throws(() => expectPilot(url(`postgres.${REF}`), "not-a-ref"), /not a Supabase project ref/)
  })
})

describe("planPilotLogins (grant-logins)", () => {
  const expected = { ref: REF, host: HOST }
  const urls = {
    adminUrl: url(`postgres.${REF}`, "0wner%40pw"),
    apiUrl: url(`wms_api.${REF}`, "api%2Fpass"),
    workerUrl: url(`wms_worker.${REF}`, "w0rker"),
  }

  test("takes each app role's password, percent-decoded, and names every secret to mask", () => {
    assert.deepEqual(planPilotLogins(urls, expected), {
      logins: [
        { role: "wms_api", password: "api/pass" },
        { role: "wms_worker", password: "w0rker" },
      ],
      secrets: ["0wner@pw", "api/pass", "w0rker"],
    })
  })

  test("refuses a URL for another host, port, database, role or project, and one without a password, naming the variable and never the URL", () => {
    const refusals: [Partial<typeof urls>, RegExp][] = [
      [{ apiUrl: url(`wms_api.${REF}`, "p", "aws-1-eu-north-1.pooler.supabase.com") }, /^PILOT_DATABASE_URL: host is not the Pilot's session pooler$/],
      [{ workerUrl: url(`wms_worker.${REF}`, "p", HOST, "6543") }, /^PILOT_WORKER_DATABASE_URL: port 6543 is not the session pooler's 5432$/],
      [{ apiUrl: url(`wms_api.${REF}`, "p", HOST, "5432", "other") }, /^PILOT_DATABASE_URL: database is not postgres$/],
      [{ apiUrl: url(`wms_worker.${REF}`) }, /^PILOT_DATABASE_URL: logs in as wms_worker, not wms_api$/],
      [{ workerUrl: url(`wms_worker.${"z".repeat(20)}`) }, /^PILOT_WORKER_DATABASE_URL: names another Supabase project$/],
      [{ adminUrl: url(`wms_api.${REF}`) }, /^PILOT_DATABASE_ADMIN_URL: logs in as wms_api, not postgres$/],
      [{ apiUrl: `postgresql://wms_api.${REF}@${HOST}:5432/postgres` }, /^PILOT_DATABASE_URL: carries no password$/],
      [{ apiUrl: "not a url" }, /^PILOT_DATABASE_URL: not a postgresql:\/\/ URL$/],
    ]
    for (const [override, reason] of refusals) {
      assert.throws(() => planPilotLogins({ ...urls, ...override }, expected), (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, reason)
        assert.doesNotMatch(error.message, /s3cret|0wner|w0rker|api%2Fpass/)
        return true
      })
    }
  })
})
