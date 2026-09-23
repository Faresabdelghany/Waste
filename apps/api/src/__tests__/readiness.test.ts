import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"

import { checkDatabase, DATABASE_CHECK_TIMEOUT_MS, probePoolOptions } from "../readiness"
import { databaseUnderTest } from "./database"
import { REFUSED_URL, silentServer } from "./unreachable"

const database = databaseUnderTest()

/** A `sql` that hands out the one probe given, so a test can watch what the check does with it. */
const sqlOf = (probe: unknown) => (() => probe) as unknown as Database["sql"]

/** A probe that would blow up if the check ever cancelled it. */
const neverCancelled = { cancel: () => assert.fail("the check must leave a probe it overtook alone; see the header of readiness.ts") }

describe("checkDatabase", () => {
  test("answers ok when the database answers", { skip: database.skip }, async () => {
    const client = createDb(database.url, probePoolOptions())
    try {
      assert.equal(await checkDatabase(client.sql), "ok")
    } finally {
      await client.close()
    }
  })

  test("answers unreachable at once when the dial is refused", async () => {
    const client = createDb(REFUSED_URL, probePoolOptions())
    try {
      const started = Date.now()
      assert.equal(await checkDatabase(client.sql), "unreachable")
      assert.ok(Date.now() - started < 1_000, "a refused dial must not wait for the bound")
    } finally {
      await client.close()
    }
  })

  test("answers unreachable when the bound passes with the dial still hanging", async () => {
    const server = await silentServer()
    const client = createDb(server.url, { max: 1 })
    try {
      const started = Date.now()
      assert.equal(await checkDatabase(client.sql, { timeoutMs: 200 }), "unreachable")
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 150 && elapsed < 2_000, `answered after ${elapsed} ms`)
    } finally {
      // The pool first: its one connection is hung by construction, so there
      // is nothing to drain, and ending it before the server drops the socket
      // leaves postgres.js nothing to reconnect.
      await client.sql.end({ timeout: 0 })
      await server.close()
    }
  })

  test("bounds the probe at two seconds by default: under every common balancer's probe timeout", () => {
    assert.equal(DATABASE_CHECK_TIMEOUT_MS, 2_000)
  })

  test("leaves a probe the bound overtook to settle on its own, never cancelling it, and absorbs its late rejection", async () => {
    let settled = false
    const late = {
      ...neverCancelled,
      then: (_resolve: unknown, reject: (error: unknown) => unknown) =>
        sleep(40).then(() => {
          settled = true
          return reject(new Error("CONNECT_TIMEOUT, long after the bound"))
        }),
    }
    assert.equal(await checkDatabase(sqlOf(late), { timeoutMs: 10 }), "unreachable")
    assert.equal(settled, false)
    // The late rejection lands here. Unhandled, Node would fail this file.
    await sleep(80)
    assert.equal(settled, true)
  })

  test("answers ok from a probe that settles inside the bound, and stops its timer", async () => {
    const answered = {
      ...neverCancelled,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve([{ "?column?": 1 }]).then(resolve),
    }
    assert.equal(await checkDatabase(sqlOf(answered), { timeoutMs: 20 }), "ok")
  })

  test("answers unreachable when the probe rejects, whatever the reason", async () => {
    const rejecting = {
      ...neverCancelled,
      then: (_resolve: unknown, reject: (error: unknown) => unknown) =>
        Promise.reject(new Error("terminating connection due to administrator command")).then(undefined, reject),
    }
    assert.equal(await checkDatabase(sqlOf(rejecting)), "unreachable")
  })
})

describe("probePoolOptions", () => {
  test("one connection, a dial that gives up with the bound, one second before the next dial after a failure", () => {
    assert.deepEqual(probePoolOptions(2_000), { max: 1, connectTimeoutSeconds: 2, backoffSeconds: 1 })
    assert.deepEqual(probePoolOptions(), probePoolOptions(DATABASE_CHECK_TIMEOUT_MS))
    assert.equal(probePoolOptions(500).connectTimeoutSeconds, 0.5)
  })

  test("a hung dial on a probe pool ends with the bound even when the check itself is given longer", async () => {
    const server = await silentServer()
    const client = createDb(server.url, probePoolOptions(300))
    try {
      const started = Date.now()
      assert.equal(await checkDatabase(client.sql, { timeoutMs: 5_000 }), "unreachable")
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 250 && elapsed < 2_000, `the dial gave up after ${elapsed} ms`)
    } finally {
      await client.sql.end({ timeout: 0 })
      await server.close()
    }
  })
})
