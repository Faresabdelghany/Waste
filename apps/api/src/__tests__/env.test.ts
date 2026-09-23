import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { parseEnv } from "../env"

const LOCAL = "postgresql://wms_api:wms_api@127.0.0.1:54322/postgres"
const base = { DATABASE_URL: LOCAL }

describe("parseEnv", () => {
  test("binds to localhost on 3001 when only the database is given", () => {
    assert.deepEqual(parseEnv(base), { HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: LOCAL })
  })

  test("reads HOST and PORT from the process environment", () => {
    assert.deepEqual(parseEnv({ ...base, HOST: "0.0.0.0", PORT: "8080" }), { HOST: "0.0.0.0", PORT: 8080, DATABASE_URL: LOCAL })
  })

  test("treats an empty variable as not set", () => {
    assert.deepEqual(parseEnv({ ...base, HOST: "", PORT: "" }), { HOST: "127.0.0.1", PORT: 3001, DATABASE_URL: LOCAL })
  })

  test("carries nothing it does not know: the process environment is large", () => {
    assert.deepEqual(parseEnv({ ...base, PATH: "/usr/bin", HOME: "/home/api", PORT: "1" }), { HOST: "127.0.0.1", PORT: 1, DATABASE_URL: LOCAL })
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
      assert.equal(parseEnv({ DATABASE_URL: value }).DATABASE_URL, value)
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
      assert.throws(() => parseEnv({ DATABASE_URL: value }), (error: unknown) => error instanceof Error && /DATABASE_URL/.test(error.message), value)
    }
  })
})
