import assert from "node:assert/strict"
import { describe, test } from "node:test"

import * as z from "zod"

import { Host, parseEnvironment, Port, PostgresUrl, SessionUrl, wholeNumber } from "../env"

const Env = z.object({
  HOST: Host,
  PORT: Port(4000),
  DATABASE_URL: SessionUrl("the role's connection string", "the jobs need"),
  REPLICA_URL: PostgresUrl("the replica's connection string").optional(),
  POOL_MAX: wholeNumber(1, " of connections, at least 1"),
  IDLE_SECONDS: wholeNumber(0, " of seconds, 0 for never"),
})
const LOCAL = "postgresql://role:secret@127.0.0.1:54322/postgres"
const parse = (source: Record<string, string | undefined>) => parseEnvironment(Env, { DATABASE_URL: LOCAL, ...source })

/** The error a refused variable throws, with the message under its name. */
const refusing = (variable: string, message: string | RegExp) => (error: unknown) =>
  error instanceof Error && error.message.startsWith("Invalid environment:\n") && new RegExp(`→ at ${variable}`).test(error.message) && (typeof message === "string" ? error.message.includes(message) : message.test(error.message))

describe("parseEnvironment", () => {
  test("applies each default and carries nothing the declaration does not name", () => {
    assert.deepEqual(parse({ PATH: "/usr/bin", HOME: "/home/app" }), { HOST: "127.0.0.1", PORT: 4000, DATABASE_URL: LOCAL })
  })

  test("treats a set-but-empty variable as not set, so a default applies and a required one is missing", () => {
    assert.deepEqual(parse({ HOST: "", PORT: "", POOL_MAX: "" }), { HOST: "127.0.0.1", PORT: 4000, DATABASE_URL: LOCAL })
    assert.throws(() => parse({ DATABASE_URL: "" }), refusing("DATABASE_URL", "expected string, received undefined"))
  })

  test("names every bad variable in one error", () => {
    assert.throws(
      () => parse({ HOST: "[::1]", PORT: "0" }),
      (error: unknown) => refusing("HOST", "no spaces, brackets")(error) && refusing("PORT", "Too small")(error),
    )
  })
})

describe("the primitives", () => {
  test("HOST is an IP address or a host name, never a scheme, a bracket, whitespace or an IPv6 zone id", () => {
    for (const value of ["0.0.0.0", "::", "::1", "localhost", "api.internal", "waste_api"]) assert.equal(parse({ HOST: value }).HOST, value)
    for (const value of [" ", "127.0.0.1 ", "[::1]", "http://0.0.0.0", "fe80::1%lo0"]) {
      assert.throws(() => parse({ HOST: value }), refusing("HOST", "must be an IP address or a host name: no spaces, brackets, scheme or IPv6 zone id"), value)
    }
  })

  test("PORT is a whole number in 1..65535", () => {
    assert.equal(parse({ PORT: "8080" }).PORT, 8080)
    for (const value of ["abc", "80.5", " 80", "+80", "0x50"]) assert.throws(() => parse({ PORT: value }), refusing("PORT", "must be a whole number"), value)
    for (const value of ["0", "65536"]) assert.throws(() => parse({ PORT: value }), refusing("PORT", /Too (small|big)/), value)
  })

  test("a whole number is at least its minimum, absent unless set, and its refusal names its unit", () => {
    assert.deepEqual([parse({ POOL_MAX: "5" }).POOL_MAX, parse({ IDLE_SECONDS: "0" }).IDLE_SECONDS], [5, 0])
    assert.equal("POOL_MAX" in parse({}), false)
    for (const value of ["-1", "2.5", "five"]) assert.throws(() => parse({ POOL_MAX: value }), refusing("POOL_MAX", "must be a whole number of connections, at least 1"), value)
    assert.throws(() => parse({ POOL_MAX: "0" }), refusing("POOL_MAX", "Too small"))
    assert.throws(() => parse({ IDLE_SECONDS: "never" }), refusing("IDLE_SECONDS", "must be a whole number of seconds, 0 for never"))
  })

  test("a Postgres URL has the postgres or postgresql scheme and a host, and its refusal says whose it is", () => {
    for (const value of ["postgres://role@127.0.0.1/db", "postgresql://role.ref:secret@aws-0-eu-north-1.pooler.supabase.com:5432/postgres?sslmode=require", "postgresql://role@db.internal/postgres"]) {
      assert.equal(parse({ REPLICA_URL: value }).REPLICA_URL, value)
    }
    for (const value of ["mysql://root@127.0.0.1/db", "role:secret@127.0.0.1:54322/postgres", "postgresql://", "postgresql:///postgres", "http://127.0.0.1:54322/postgres", " postgresql://role@127.0.0.1/postgres", "postgresql://role@127.0.0.1:port/postgres"]) {
      assert.throws(() => parse({ REPLICA_URL: value }), refusing("REPLICA_URL", "must be a postgresql:// URL with a host, the replica's connection string"), value)
    }
  })

  test("a session URL is refused on the transaction pooler's port, saying who needs the session and where to find one", () => {
    const pooled = "postgresql://role.ref:secret@aws-0-eu-north-1.pooler.supabase.com:6543/postgres"
    assert.throws(() => parse({ DATABASE_URL: pooled }), refusing("DATABASE_URL", "port 6543 is the transaction pooler; the jobs need a session (the direct connection or the session pooler on port 5432)"))
    assert.equal(parse({ DATABASE_URL: pooled.replace("6543", "5432") }).DATABASE_URL, pooled.replace("6543", "5432"))
    assert.throws(() => parse({ DATABASE_URL: "not a url" }), refusing("DATABASE_URL", "must be a postgresql:// URL with a host"))
  })
})
