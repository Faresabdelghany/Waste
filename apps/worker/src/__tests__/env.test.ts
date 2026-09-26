import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { parseEnv, TRANSACTION_POOLER_PORT } from "../env"

const WORKER = "postgresql://wms_worker:secret@127.0.0.1:54322/postgres"
const API = "postgresql://wms_api:secret@127.0.0.1:54322/postgres"
const base = { WORKER_DATABASE_URL: WORKER, DATABASE_URL: API }
const expected = { HOST: "127.0.0.1", PORT: 3002, WORKER_DATABASE_URL: WORKER, DATABASE_URL: API }

const naming = (variable: string) => (error: unknown) => error instanceof Error && error.message.includes(variable)

describe("parseEnv", () => {
  test("binds the probes to localhost on 3002, one above the API, when only the two database URLs are given", () => {
    assert.deepEqual(parseEnv(base), expected)
  })

  test("reads HOST and PORT from the process environment, and treats an empty variable as not set", () => {
    assert.deepEqual(parseEnv({ ...base, HOST: "0.0.0.0", PORT: "8080" }), { ...expected, HOST: "0.0.0.0", PORT: 8080 })
    assert.deepEqual(parseEnv({ ...base, HOST: "", PORT: "" }), expected)
  })

  test("carries nothing it does not know: the process environment is large", () => {
    assert.deepEqual(parseEnv({ ...base, PATH: "/usr/bin", HOME: "/home/worker", SUPABASE_URL: "https://x.supabase.co" }), expected)
  })

  test("refuses a HOST with whitespace, brackets, a scheme or an IPv6 zone id, and a PORT outside 1..65535, naming the variable", () => {
    for (const value of [" ", "[::1]", "http://0.0.0.0", "fe80::1%lo0"]) {
      assert.throws(() => parseEnv({ ...base, HOST: value }), naming("HOST"), value)
    }
    for (const value of ["0", "65536", "abc", "80.5", "+80"]) {
      assert.throws(() => parseEnv({ ...base, PORT: value }), naming("PORT"), value)
    }
  })

  test("refuses to start without WORKER_DATABASE_URL or without DATABASE_URL, naming the one missing: a process without its two roles is not the worker", () => {
    assert.throws(() => parseEnv({ DATABASE_URL: API }), naming("WORKER_DATABASE_URL"))
    assert.throws(() => parseEnv({ WORKER_DATABASE_URL: WORKER }), naming("DATABASE_URL"))
    assert.throws(() => parseEnv({ ...base, WORKER_DATABASE_URL: "" }), naming("WORKER_DATABASE_URL"))
    assert.throws(() => parseEnv({}), (error: unknown) => naming("WORKER_DATABASE_URL")(error) && naming("DATABASE_URL")(error), "both named at once")
  })

  test("accepts a postgresql:// or postgres:// URL with a host for either, the session pooler's user spelling and query included", () => {
    for (const value of [
      WORKER,
      "postgres://wms_worker:secret@127.0.0.1:54322/postgres",
      "postgresql://wms_worker.abcdefghijklmnop:secret@aws-0-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=require",
      "postgresql://wms_worker@db.internal/postgres",
    ]) {
      assert.equal(parseEnv({ ...base, WORKER_DATABASE_URL: value }).WORKER_DATABASE_URL, value)
      assert.equal(parseEnv({ ...base, DATABASE_URL: value }).DATABASE_URL, value)
    }
  })

  test("refuses a URL that is not a Postgres URL with a host, naming the variable", () => {
    for (const value of ["mysql://root@127.0.0.1/db", "wms_worker:x@127.0.0.1:54322/postgres", "postgresql://", "postgresql:///postgres", "http://127.0.0.1:54322/postgres", "postgresql://wms_worker@127.0.0.1:port/postgres"]) {
      assert.throws(() => parseEnv({ ...base, WORKER_DATABASE_URL: value }), naming("WORKER_DATABASE_URL"), value)
      assert.throws(() => parseEnv({ ...base, DATABASE_URL: value }), naming("DATABASE_URL"), value)
    }
  })

  test("refuses the transaction pooler, port 6543, on either URL, naming the variable and the session alternative: pg-boss keeps state on its connection", () => {
    assert.equal(TRANSACTION_POOLER_PORT, "6543")
    const pooled = "postgresql://wms_worker.ref:secret@aws-0-eu-north-1.pooler.supabase.com:6543/postgres"
    assert.throws(() => parseEnv({ ...base, WORKER_DATABASE_URL: pooled }), (error: unknown) => naming("WORKER_DATABASE_URL")(error) && /6543 is the transaction pooler.*session pooler on port 5432/s.test((error as Error).message))
    assert.throws(() => parseEnv({ ...base, DATABASE_URL: pooled.replace("wms_worker", "wms_api") }), (error: unknown) => naming("DATABASE_URL")(error) && /6543 is the transaction pooler/.test((error as Error).message))
    // The session pooler on 5432 and the local stack on 54322 pass.
    assert.equal(parseEnv({ ...base, WORKER_DATABASE_URL: pooled.replace("6543", "5432") }).WORKER_DATABASE_URL, pooled.replace("6543", "5432"))
  })
})
