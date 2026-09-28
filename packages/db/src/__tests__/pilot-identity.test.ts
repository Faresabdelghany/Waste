import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { expectPilot, PAUSED_HINT, poolerUser, targetOfUrl, unreachableHint } from "../pilot/identity"

const REF = "abcdefghijklmnopqrst"
const HOST = "aws-0-eu-north-1.pooler.supabase.com"
const url = (user: string, password = "s3cret", host = HOST, port = "5432", database = "postgres") =>
  `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=require`

describe("poolerUser", () => {
  test("splits the pooler's user into its role and its Supabase project ref, and nothing else", () => {
    assert.deepEqual(poolerUser(`wms_api.${REF}`), { role: "wms_api", ref: REF })
    assert.equal(poolerUser("postgres"), undefined)
    assert.equal(poolerUser(`.${REF}`), undefined)
    assert.equal(poolerUser("postgres.short"), undefined)
  })
})

describe("targetOfUrl (Issue #152)", () => {
  test("reads the Supabase project from the session pooler's user or the direct host, and loopback as the local stack", () => {
    assert.deepEqual(targetOfUrl(url(`postgres.${REF}`)), { kind: "supabase", ref: REF })
    assert.deepEqual(targetOfUrl(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`), { kind: "supabase", ref: REF })
    assert.deepEqual(targetOfUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres"), { kind: "local" })
  })

  test("refuses a pooler URL that names no Supabase project and a host that is neither", () => {
    assert.throws(() => targetOfUrl(url("postgres")), /names no Supabase project/)
    assert.throws(() => targetOfUrl("postgresql://postgres:pw@db.example.com:5432/postgres"), /db\.example\.com is neither a Supabase project nor the local stack/)
  })
})

describe("expectPilot", () => {
  test("takes the Pilot's Supabase project when the workflow names it, and only the local stack when nothing does", () => {
    assert.deepEqual(expectPilot(url(`postgres.${REF}`), REF), { kind: "supabase", ref: REF })
    assert.deepEqual(expectPilot("postgresql://postgres:postgres@127.0.0.1:54322/postgres", undefined), { kind: "local" })
    assert.throws(() => expectPilot(url(`postgres.${"z".repeat(20)}`), REF), /Supabase project z{20}, not the Pilot's \(abcdefghijklmnopqrst\)/)
    assert.throws(() => expectPilot("postgresql://postgres:postgres@127.0.0.1:54322/postgres", REF), /the local stack, not the Pilot's/)
    assert.throws(() => expectPilot(url(`postgres.${REF}`), undefined), /PILOT_SUPABASE_REF is not set/)
    assert.throws(() => expectPilot(url(`postgres.${REF}`), "not-a-ref"), /not a Supabase project ref/)
  })
})

describe("unreachableHint", () => {
  const connectionError = (code: string, message = "connect failed") => Object.assign(new Error(message), { code })

  test("says a Supabase project that cannot be reached may be paused, and how to go on", () => {
    assert.equal(PAUSED_HINT, "The Free Supabase project may be paused: resume it in the dashboard and re-run the workflow.")
    for (const error of [connectionError("ECONNREFUSED"), connectionError("CONNECT_TIMEOUT"), connectionError("ENOTFOUND"), connectionError("XX000", "Tenant or user not found")]) {
      assert.equal(unreachableHint(url(`postgres.${REF}`), error), PAUSED_HINT, String(error))
    }
  })

  test("says nothing for the local stack, or for an error the database answered", () => {
    assert.equal(unreachableHint("postgresql://postgres:postgres@127.0.0.1:54322/postgres", connectionError("ECONNREFUSED")), undefined)
    assert.equal(unreachableHint(url(`postgres.${REF}`), connectionError("42501", "permission denied for table company")), undefined)
    assert.equal(unreachableHint("not a url", connectionError("ECONNREFUSED")), undefined)
  })
})
