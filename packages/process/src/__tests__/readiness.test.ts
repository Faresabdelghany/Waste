import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { describe, test } from "node:test"

import { bounded, CHECK_TIMEOUT_MS } from "../readiness"

describe("bounded", () => {
  test("answers the probe's value when it settles inside the bound", async () => {
    assert.equal(await bounded(Promise.resolve("ok"), "unreachable", 50), "ok")
  })

  test("answers the failed value when the probe rejects, whatever the reason", async () => {
    assert.equal(await bounded(Promise.reject(new Error("connection terminated")), "unreachable", 1_000), "unreachable")
  })

  test("answers the failed value when the bound passes first, and absorbs the probe's late rejection", async () => {
    let settled = false
    const late = sleep(40).then(() => {
      settled = true
      throw new Error("long after the bound")
    })
    assert.equal(await bounded(late, "unreachable", 10), "unreachable")
    assert.equal(settled, false, "the bound answered, not the probe")
    // The late rejection lands here. Unhandled, Node would fail this file.
    await sleep(80)
    assert.equal(settled, true)
  })

  test("bounds a probe at two seconds by default: under every common balancer's probe timeout", () => {
    assert.equal(CHECK_TIMEOUT_MS, 2_000)
  })
})
