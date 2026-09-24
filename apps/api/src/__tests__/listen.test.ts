import assert from "node:assert/strict"
import { once } from "node:events"
import net from "node:net"
import { after, describe, test } from "node:test"

import { HealthResponse } from "@waste/contracts/health"
import { createDb } from "@waste/db/client"

import { createApp } from "../app"
import { listen } from "../listen"
import { neverVerifies } from "./tokens"
import { REFUSED_URL } from "./unreachable"

const loopback = { host: "127.0.0.1", port: 0 }

/** A pool nothing connects to: these tests bind, ask /healthz at most, and close. */
const idle = createDb(REFUSED_URL, { max: 1 })
after(() => idle.close())
const deps = { probe: idle, pool: idle, verifier: neverVerifies }

describe("listen", () => {
  test("serves the app on the given host and an ephemeral port, and closes on request", async (t) => {
    const listening = await listen(createApp(deps), loopback)
    t.after(() => listening.close())
    assert.match(listening.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${listening.url}/healthz`)
    assert.equal(response.status, 200)
    HealthResponse.parse(await response.json())
    await listening.close()
    await assert.rejects(fetch(`${listening.url}/healthz`))
  })

  test("fails instead of hanging when the port is taken", async (t) => {
    const first = await listen(createApp(deps), loopback)
    t.after(() => first.close())
    const port = Number(new URL(first.url).port)
    await assert.rejects(listen(createApp(deps), { host: "127.0.0.1", port }), /EADDRINUSE/)
  })

  test("closes once: every call shares the one shutdown and settles", async () => {
    const listening = await listen(createApp(deps), loopback)
    const first = listening.close()
    const second = listening.close()
    assert.equal(first, second)
    await first
    await listening.close()
  })

  test("close lets go of an idle keep-alive connection at once", async () => {
    const listening = await listen(createApp(deps), { ...loopback, graceMs: 5_000 })
    await (await fetch(`${listening.url}/healthz`)).json()
    const started = Date.now()
    await listening.close()
    assert.ok(Date.now() - started < 1_000, "an idle connection must not hold the server until the grace period ends")
  })

  test("close cuts a connection that never finishes its request when the grace period ends", async () => {
    const listening = await listen(createApp(deps), { ...loopback, graceMs: 200 })
    const { port } = listening.server.address() as net.AddressInfo
    const stalled = net.connect({ host: "127.0.0.1", port })
    await once(stalled, "connect")
    stalled.write("GET /healthz HTTP/1.1\r\nHost: x\r\n")
    await new Promise((resolve) => setTimeout(resolve, 50))
    const started = Date.now()
    await Promise.all([listening.close(), once(stalled, "close")])
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 150 && elapsed < 2_000, `closed after ${elapsed} ms`)
  })

  test("leaves the global Request and Response alone", async (t) => {
    const { Request, Response } = globalThis
    const listening = await listen(createApp(deps), loopback)
    t.after(() => listening.close())
    assert.equal(globalThis.Request, Request)
    assert.equal(globalThis.Response, Response)
  })

  test("stops listening for bind errors once bound, so a later server error is not swallowed", async (t) => {
    const listening = await listen(createApp(deps), loopback)
    t.after(() => listening.close())
    assert.equal(listening.server.listenerCount("error"), 0)
  })
})
