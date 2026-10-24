import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { FEED_ADDRESSES_PER_CLIENT, FEED_REQUESTS_PER_ADDRESS, FeedAllowance, PUBLIC_REQUESTS_PER_MINUTE } from "../auth/public-door"

describe("FeedAllowance", () => {
  test("generous on one address and low across addresses, both bounds below a visitor's minute only where they should be", () => {
    assert.ok(FEED_REQUESTS_PER_ADDRESS >= PUBLIC_REQUESTS_PER_MINUTE, "a calendar service reading one feed for many subscribers is not held to a visitor's minute")
    assert.ok(FEED_ADDRESSES_PER_CLIENT < PUBLIC_REQUESTS_PER_MINUTE, "walking addresses through the feed is slower than through the pages")
  })

  test("one client reads one address's feed up to its bound a minute, and another address's feed beside it", () => {
    let at = new Date("2026-10-24T09:00:00.000Z")
    const allowance = new FeedAllowance(3, 5, () => at)
    for (let i = 0; i < 3; i++) assert.deepEqual(allowance.take("198.51.100.1", "a"), { allowed: true })
    assert.deepEqual(allowance.take("198.51.100.1", "a"), { allowed: false, retryAfterSeconds: 60 })
    assert.deepEqual(allowance.take("198.51.100.1", "b"), { allowed: true }, "another address is counted apart")
    assert.deepEqual(allowance.take("198.51.100.2", "a"), { allowed: true }, "another client too")
    at = new Date("2026-10-24T09:01:00.000Z")
    assert.deepEqual(allowance.take("198.51.100.1", "a"), { allowed: true }, "a new minute")
  })

  test("a client reads at most its bound of distinct addresses a minute, an address it already read this minute not counted again, an unknown one counted all the same", () => {
    let at = new Date("2026-10-24T09:00:00.000Z")
    const allowance = new FeedAllowance(10, 2, () => at)
    assert.equal(allowance.take("198.51.100.1", "01a0d2a4-a280-700c-8000-00000000000b").allowed, true)
    assert.equal(allowance.take("198.51.100.1", "not-an-address").allowed, true)
    at = new Date("2026-10-24T09:00:20.000Z")
    assert.deepEqual(allowance.take("198.51.100.1", "01a0d2a4-a280-700c-8000-00000000000c"), { allowed: false, retryAfterSeconds: 40 })
    assert.equal(allowance.take("198.51.100.1", "01A0D2A4-A280-700C-8000-00000000000B").allowed, true, "the same address, however it is spelled")
    assert.equal(allowance.take("198.51.100.2", "01a0d2a4-a280-700c-8000-00000000000c").allowed, true, "another client walks apart")
    at = new Date("2026-10-24T09:01:00.000Z")
    assert.equal(allowance.take("198.51.100.1", "01a0d2a4-a280-700c-8000-00000000000c").allowed, true, "a new minute")
  })

  test("an overlong address is counted by its first characters, so a client cannot grow what the allowance remembers", () => {
    const at = new Date("2026-10-24T09:00:00.000Z")
    const allowance = new FeedAllowance(1, 5, () => at)
    assert.equal(allowance.take("198.51.100.1", `${"x".repeat(64)}a`).allowed, true)
    assert.equal(allowance.take("198.51.100.1", `${"x".repeat(64)}b`).allowed, false)
  })
})
