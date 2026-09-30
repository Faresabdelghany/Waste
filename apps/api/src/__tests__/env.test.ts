import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { parseEnv } from "../env"

const LOCAL = "postgresql://wms_api:wms_api@127.0.0.1:54322/postgres"
const SUPABASE = "https://ztmisreemxepvjxelbql.supabase.co"
const base = { DATABASE_URL: LOCAL, SUPABASE_URL: SUPABASE }
const expected = { HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: LOCAL, SUPABASE_URL: SUPABASE }

describe("parseEnv", () => {
  test("binds to localhost on 3001 when only the database and the Supabase project are given", () => {
    assert.deepEqual(parseEnv(base), expected)
  })

  test("reads HOST and PORT from the process environment", () => {
    assert.deepEqual(parseEnv({ ...base, HOST: "0.0.0.0", PORT: "8080" }), { ...expected, HOST: "0.0.0.0", PORT: 8080 })
  })

  test("treats an empty variable as not set", () => {
    assert.deepEqual(parseEnv({ ...base, HOST: "", PORT: "" }), expected)
  })

  test("carries nothing it does not know: the process environment is large", () => {
    assert.deepEqual(parseEnv({ ...base, PATH: "/usr/bin", HOME: "/home/api", PORT: "1" }), { ...expected, PORT: 1 })
  })

  test("accepts an IP address or a host name for HOST", () => {
    for (const value of ["0.0.0.0", "::", "::1", "localhost", "api.internal", "waste_api"]) {
      assert.equal(parseEnv({ ...base, HOST: value }).HOST, value)
    }
  })

  test("refuses a HOST with whitespace, brackets, a scheme or an IPv6 zone id, and names the variable", () => {
    for (const value of [" ", "127.0.0.1 ", "[::1]", "http://0.0.0.0", "fe80::1%lo0"]) {
      assert.throws(() => parseEnv({ ...base, HOST: value }), (error: unknown) => error instanceof Error && /HOST/.test(error.message), value)
    }
  })

  test("refuses a port that is not a whole number in 1..65535 and names the variable", () => {
    for (const value of ["0", "65536", "abc", "80.5", " 80", "+80", "0x50"]) {
      assert.throws(() => parseEnv({ ...base, PORT: value }), (error: unknown) => error instanceof Error && /PORT/.test(error.message), value)
    }
  })

  test("refuses to start without DATABASE_URL, and names it: a process without a database is not the API", () => {
    for (const source of [{}, { DATABASE_URL: "" }, { HOST: "0.0.0.0", PORT: "8080" }]) {
      assert.throws(() => parseEnv(source), (error: unknown) => error instanceof Error && /DATABASE_URL/.test(error.message))
    }
  })

  test("accepts a postgresql:// or postgres:// URL for DATABASE_URL, the pooler's user spelling and query included", () => {
    for (const value of [
      LOCAL,
      "postgres://wms_api:secret@127.0.0.1:54322/postgres",
      "postgresql://wms_api.abcdefghijklmnop:secret@aws-1-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=require",
      "postgresql://wms_api@db.internal/postgres",
    ]) {
      assert.equal(parseEnv({ ...base, DATABASE_URL: value }).DATABASE_URL, value)
    }
  })

  test("refuses a DATABASE_URL that is not a Postgres URL with a host, and names the variable", () => {
    for (const value of [
      "mysql://root@127.0.0.1/db",
      "wms_api:wms_api@127.0.0.1:54322/postgres",
      "postgresql://",
      "postgresql:///postgres",
      "http://127.0.0.1:54322/postgres",
      " postgresql://wms_api@127.0.0.1/postgres",
      "postgresql://wms_api@127.0.0.1:port/postgres",
    ]) {
      assert.throws(() => parseEnv({ ...base, DATABASE_URL: value }), (error: unknown) => error instanceof Error && /DATABASE_URL/.test(error.message), value)
    }
  })

  test("refuses to start without SUPABASE_URL, and names it: the token issuer and its keys come from it", () => {
    for (const source of [{ DATABASE_URL: LOCAL }, { DATABASE_URL: LOCAL, SUPABASE_URL: "" }]) {
      assert.throws(() => parseEnv(source), (error: unknown) => error instanceof Error && /SUPABASE_URL/.test(error.message))
    }
  })

  test("accepts an http or https origin for SUPABASE_URL: the hosted project, or a local Auth server", () => {
    for (const value of [SUPABASE, "http://127.0.0.1:54321", "http://localhost:54321", "https://auth.internal"]) {
      assert.equal(parseEnv({ ...base, SUPABASE_URL: value }).SUPABASE_URL, value)
    }
  })

  test("refuses a SUPABASE_URL with a trailing slash, a path, a query, a fragment, credentials, another scheme or no host, and names the variable", () => {
    for (const value of [
      `${SUPABASE}/`,
      `${SUPABASE}/auth/v1`,
      `${SUPABASE}?x=1`,
      `${SUPABASE}#x`,
      "https://user:secret@ztmisreemxepvjxelbql.supabase.co",
      "postgresql://ztmisreemxepvjxelbql.supabase.co",
      "ztmisreemxepvjxelbql.supabase.co",
      "https://",
      ` ${SUPABASE}`,
    ]) {
      assert.throws(() => parseEnv({ ...base, SUPABASE_URL: value }), (error: unknown) => error instanceof Error && /SUPABASE_URL/.test(error.message), value)
    }
  })

  test("says in its message that the trailing slash is refused, not stripped", () => {
    assert.throws(() => parseEnv({ ...base, SUPABASE_URL: `${SUPABASE}/` }), /without a trailing slash/)
  })

  test("reads DATABASE_POOL_MAX, the request pool's size (#149), as a whole number of at least one, absent — postgres.js's default — unless set", () => {
    assert.deepEqual(parseEnv(base), expected, "unset: not carried")
    assert.deepEqual(parseEnv({ ...base, DATABASE_POOL_MAX: "" }), expected, "empty: not set")
    assert.equal(parseEnv({ ...base, DATABASE_POOL_MAX: "5" }).DATABASE_POOL_MAX, 5)
    for (const value of ["0", "-1", "2.5", "five", " 5"]) {
      assert.throws(() => parseEnv({ ...base, DATABASE_POOL_MAX: value }), (error: unknown) => error instanceof Error && /DATABASE_POOL_MAX/.test(error.message), value)
    }
  })

  test("names the routing provider and carries its key, since the guided setup's preview calls the provider from the API (#173)", () => {
    assert.deepEqual(parseEnv({ ...base, ROUTING_PROVIDER: "openrouteservice", OPENROUTESERVICE_API_KEY: "test-only-not-a-key" }), {
      ...expected,
      ROUTING_PROVIDER: "openrouteservice",
      OPENROUTESERVICE_API_KEY: "test-only-not-a-key",
    })
  })

  test("reads ROUTING_PREVIEW_CALLS_PER_MINUTE, the preview's own pacing (#173), as a whole number of at least one, absent — the preview's 10 — unless set; the worker's ROUTING_CALLS_PER_MINUTE is not the API's", () => {
    assert.deepEqual(parseEnv({ ...base, ROUTING_PREVIEW_CALLS_PER_MINUTE: "" }), expected, "empty: not set")
    assert.equal(parseEnv({ ...base, ROUTING_PREVIEW_CALLS_PER_MINUTE: "5" }).ROUTING_PREVIEW_CALLS_PER_MINUTE, 5)
    assert.deepEqual(parseEnv({ ...base, ROUTING_CALLS_PER_MINUTE: "30" }), expected, "the worker's knob is dropped here")
    for (const value of ["0", "-1", "2.5", "ten"]) {
      assert.throws(() => parseEnv({ ...base, ROUTING_PREVIEW_CALLS_PER_MINUTE: value }), (error: unknown) => error instanceof Error && /ROUTING_PREVIEW_CALLS_PER_MINUTE/.test(error.message), value)
    }
  })
})
