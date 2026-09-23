import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"

import { checkDatabase, DATABASE_CHECK_TIMEOUT_MS } from "../readiness"
import { databaseUnderTest } from "./database"
import { refusedUrl, silentServer } from "./unreachable"

const database = databaseUnderTest()

/** A `sql` that hands out the one probe given, so a test can watch what the check does with it. */
const sqlOf = (probe: unknown) => (() => probe) as unknown as Database["sql"]

describe("checkDatabase", () => {
  test("answers ok when the database answers", { skip: database.skip }, async () => {
    const client = createDb(database.url, { max: 1 })
    try {
      assert.equal(await checkDatabase(client.sql), "ok")
    } finally {
      await client.close()
    }
  })

  test("answers unreachable at once when the connection is refused", async () => {
    const client = createDb(await refusedUrl(), { max: 1 })
    try {
      const started = Date.now()
      assert.equal(await checkDatabase(client.sql), "unreachable")
      assert.ok(Date.now() - started < 1_000, "a refused connection must not wait for the bound")
    } finally {
      await client.close()
    }
  })

  test("answers unreachable when the bound passes with the connection still hanging", async () => {
    const server = await silentServer()
    const client = createDb(server.url, { max: 1 })
    try {
      const started = Date.now()
      assert.equal(await checkDatabase(client.sql, { timeoutMs: 200 }), "unreachable")
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 150 && elapsed < 2_000, `answered after ${elapsed} ms`)
    } finally {
      await server.close()
      // The one connection is hung by construction, so there is nothing to
      // drain: end the pool at once instead of waiting out close()'s grace.
      await client.sql.end({ timeout: 0 })
    }
  })

  test("bounds the probe at two seconds by default: a balancer's check interval, not a query timeout", () => {
    assert.equal(DATABASE_CHECK_TIMEOUT_MS, 2_000)
  })

  test("cancels a probe the bound overtook, so hung probes do not pile up in the pool, and leaves an answered one alone", async () => {
    let cancelled = 0
    const pending = { then: () => new Promise(() => {}), cancel: () => void (cancelled += 1) }
    assert.equal(await checkDatabase(sqlOf(pending), { timeoutMs: 20 }), "unreachable")
    assert.equal(cancelled, 1)

    const answered = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve([{ "?column?": 1 }]).then(resolve),
      cancel: () => void (cancelled += 1),
    }
    assert.equal(await checkDatabase(sqlOf(answered), { timeoutMs: 20 }), "ok")
    assert.equal(cancelled, 1)
  })

  test("answers unreachable when the probe rejects, whatever the reason", async () => {
    const rejecting = {
      then: (_resolve: unknown, reject: (error: unknown) => unknown) =>
        Promise.reject(new Error("terminating connection due to administrator command")).then(undefined, reject),
      cancel: () => {},
    }
    assert.equal(await checkDatabase(sqlOf(rejecting)), "unreachable")
  })
})
