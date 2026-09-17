import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { HealthResponse } from "@waste/contracts/health"

import { createApp } from "../app"
import { listen } from "../listen"

describe("listen", () => {
  test("serves the app on the given host and an ephemeral port, and closes on request", async () => {
    const listening = await listen(createApp(), { host: "127.0.0.1", port: 0 })
    assert.match(listening.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    const response = await fetch(`${listening.url}/healthz`)
    assert.equal(response.status, 200)
    HealthResponse.parse(await response.json())
    await listening.close()
    await assert.rejects(fetch(`${listening.url}/healthz`))
  })

  test("fails instead of hanging when the port is taken", async () => {
    const first = await listen(createApp(), { host: "127.0.0.1", port: 0 })
    const port = Number(new URL(first.url).port)
    try {
      await assert.rejects(listen(createApp(), { host: "127.0.0.1", port }), /EADDRINUSE/)
    } finally {
      await first.close()
    }
  })
})
