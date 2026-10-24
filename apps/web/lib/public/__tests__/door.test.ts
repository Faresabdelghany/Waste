import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { readDoor, readPublishedProject, searchSortingGuide, visitorOf } from "../door"

type Asked = { url: string; headers: Record<string, string> }

/** A fetch that answers `response` and remembers what it was asked. */
const answering = (response: () => Response | Promise<Response>) => {
  const asked: Asked[] = []
  const fetching = (async (input: string | URL | Request, init?: RequestInit) => {
    asked.push({ url: String(input), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) })
    return response()
  }) as typeof fetch
  return { asked, fetching }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

describe("visitorOf", () => {
  test("is the header's last entry, trimmed, or null for none", () => {
    assert.equal(visitorOf("6.6.6.6, 198.51.100.1 "), "198.51.100.1")
    assert.equal(visitorOf("198.51.100.1"), "198.51.100.1")
    assert.equal(visitorOf(null), null)
    assert.equal(visitorOf(" , "), null)
  })
})

describe("readDoor", () => {
  test("asks the API's origin for the public path, naming the visitor by the entry this server's own proxy wrote", async () => {
    const { asked, fetching } = answering(() => json({ slug: "kystbyen", name: "Kystbyen", language: "da", timezone: "Europe/Copenhagen" }))
    const answer = await readPublishedProject("kystbyen", { origin: "http://api.test/", forwardedFor: "6.6.6.6, 198.51.100.1", fetch: fetching })
    assert.deepEqual(answer, { kind: "ok", body: { slug: "kystbyen", name: "Kystbyen", language: "da", timezone: "Europe/Copenhagen" } })
    assert.equal(asked[0]?.url, "http://api.test/public/kystbyen")
    assert.equal(asked[0]?.headers["x-forwarded-for"], "198.51.100.1", "what the visitor wrote before the proxy's entry is dropped here")
  })

  test("sends no X-Forwarded-For where the visitor's request had none", async () => {
    const { asked, fetching } = answering(() => json({ query: "x", matches: [] }))
    await searchSortingGuide("kystbyen", "pizza bakke & co", { origin: "http://api.test", forwardedFor: null, fetch: fetching })
    assert.equal(asked[0]?.url, "http://api.test/public/kystbyen/sorting-guide?q=pizza%20bakke%20%26%20co")
    assert.equal(asked[0]?.headers["x-forwarded-for"], undefined)
  })

  test("a 404 is a project nobody publishes under the slug", async () => {
    const { fetching } = answering(() => json({ status: 404 }, 404))
    assert.deepEqual(await readDoor("nobody", { origin: "http://api.test", forwardedFor: null, fetch: fetching }), { kind: "not-published" })
  })

  test("a 429 is the visitor's allowance spent, for the seconds Retry-After names or a minute", async () => {
    const named = answering(() => json({ status: 429 }, 429, { "retry-after": "17" }))
    assert.deepEqual(await readDoor("kystbyen", { origin: "http://api.test", forwardedFor: null, fetch: named.fetching }), { kind: "too-many", retryAfterSeconds: 17 })
    const unnamed = answering(() => json({ status: 429 }, 429))
    assert.deepEqual(await readDoor("kystbyen", { origin: "http://api.test", forwardedFor: null, fetch: unnamed.fetching }), { kind: "too-many", retryAfterSeconds: 60 })
  })

  test("no origin, a 400 or a 5xx, a body that is not JSON, and no answer at all are each the door unreachable", async () => {
    assert.deepEqual(await readDoor("kystbyen", { origin: undefined, forwardedFor: null }), { kind: "unavailable" })
    assert.deepEqual(await readDoor("kystbyen", { origin: "", forwardedFor: null }), { kind: "unavailable" })
    for (const status of [400, 500, 503]) {
      const { fetching } = answering(() => json({ status }, status))
      assert.deepEqual(await readDoor("kystbyen", { origin: "http://api.test", forwardedFor: null, fetch: fetching }), { kind: "unavailable" }, String(status))
    }
    const garbled = answering(() => new Response("<html>", { status: 200 }))
    assert.deepEqual(await readDoor("kystbyen", { origin: "http://api.test", forwardedFor: null, fetch: garbled.fetching }), { kind: "unavailable" })
    const silent = answering(() => Promise.reject(new TypeError("fetch failed")))
    assert.deepEqual(await readDoor("kystbyen", { origin: "http://api.test", forwardedFor: null, fetch: silent.fetching }), { kind: "unavailable" })
  })
})
