import assert from "node:assert/strict"
import { once } from "node:events"
import net from "node:net"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "../client"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

describe("createDb", { skip: database.skip }, () => {
  let connection: Database

  before(() => {
    connection = createDb(database.adminUrl)
  })
  after(() => connection.close())

  test("answers a query through Drizzle and through the raw client", async () => {
    const [row] = await connection.sql<{ answer: number }[]>`select 1 as answer`
    assert.equal(row.answer, 1)
    const result = await connection.db.execute<{ answer: number }>("select 2 as answer")
    assert.equal(result[0]?.answer, 2)
  })

  test("the raw face shares Drizzle's codecs: temporal values arrive as Postgres text, not Date", async () => {
    // Drizzle rewires the postgres.js instance it is given so that it can do
    // the mapping itself; the raw face is the same instance, so a test or a
    // script reading `now()` through it gets the server's text form and sends
    // dates as strings. Pinned here so the header's promise stays true.
    const [row] = await connection.sql<{ now: unknown; day: unknown }[]>`select now() as now, current_date as day`
    assert.equal(typeof row.now, "string")
    assert.equal(typeof row.day, "string")
    assert.match(String(row.day), /^\d{4}-\d{2}-\d{2}$/)
  })

  test("searchPath goes out as a startup parameter and outranks the role's setting", async () => {
    const pinned = createDb(database.adminUrl, { max: 1, searchPath: "wms, extensions" })
    try {
      const [row] = await pinned.sql<{ path: string; source: string }[]>`
        select current_setting('search_path') as path, (select source from pg_settings where name = 'search_path') as source`
      assert.deepEqual({ path: row.path, source: row.source }, { path: "wms, extensions", source: "client" })
    } finally {
      await pinned.close()
    }
  })

  test("close() is idempotent", async () => {
    const connection = createDb(database.adminUrl)
    await connection.sql`select 1`
    await connection.close()
    await connection.close()
  })
})

/** A loopback server that accepts connections and never answers them. */
async function silentServer() {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => sockets.add(socket))
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as net.AddressInfo
  return {
    url: `postgresql://nobody:nobody@127.0.0.1:${port}/none`,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      server.close()
      await once(server, "close")
    },
  }
}

const code = (error: unknown) => (error as { code?: string }).code

describe("createDb's dial options, which need no database", () => {
  test("connectTimeoutSeconds fails a dial that hangs, at the timeout, with CONNECT_TIMEOUT", async () => {
    const server = await silentServer()
    const hung = createDb(server.url, { max: 1, connectTimeoutSeconds: 0.2 })
    try {
      const started = Date.now()
      await assert.rejects(hung.sql`select 1`, (error: unknown) => code(error) === "CONNECT_TIMEOUT")
      const elapsed = Date.now() - started
      assert.ok(elapsed >= 150 && elapsed < 2_000, `failed after ${elapsed} ms`)
    } finally {
      // Nothing to drain on a connection that never opened: end at once.
      await hung.sql.end({ timeout: 0 })
      await server.close()
    }
  })

  test("backoffSeconds is the fixed wait before the dial after a failure", async () => {
    // Port 1 (tcpmux) needs root to bind and nothing binds it: refused at once.
    const refused = createDb("postgresql://nobody:nobody@127.0.0.1:1/none", { max: 1, backoffSeconds: 0.3 })
    try {
      await assert.rejects(refused.sql`select 1`, (error: unknown) => code(error) === "ECONNREFUSED")
      const started = Date.now()
      await assert.rejects(refused.sql`select 1`, (error: unknown) => code(error) === "ECONNREFUSED")
      const elapsed = Date.now() - started
      // postgres.js's own backoff would wait 15 to 30 ms after one failure.
      assert.ok(elapsed >= 250 && elapsed < 2_000, `the second dial came after ${elapsed} ms`)
    } finally {
      await refused.close()
    }
  })
})
