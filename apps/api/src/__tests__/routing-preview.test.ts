// `POST /routing/preview` (#173, decided on #124 §4 and #132 §5): the guided
// setup's road through the routing adapter, interactive class, behind the
// quota engine the API holds — the answer the road, or the reason there is
// none, never a Plan or a job — cached by fingerprint across users, the
// directions reading written to the company's `routing_quota` row after a
// call, and a stored row newer than what the process learned taken before
// one (`refresh`). Each test builds its own app over a scripted fake, so one
// test's quota state is not another's, and the companies' rows are cleared
// between them.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, afterEach, before, describe, test } from "node:test"

import type { Position2D } from "@waste/contracts/geojson"
import { NO_ACTIVE_ACCOUNT } from "@waste/contracts/problem"
import { ROUTING_PREVIEW_POINTS_MAX, RoutingPreview } from "@waste/contracts/routing-preview"
import { createDb, type Database } from "@waste/db/client"
import { quotaRows, recordQuota } from "@waste/db/commands/routing-quota"
import { plan, routingQuota } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { FakeProvider, type FakeScript } from "@waste/routing/fake"
import type { RoutingProvider } from "@waste/routing/provider"
import { KEY_REFUSED, QuotaEngine, STANDARD_PLAN } from "@waste/routing/quota"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { MINUTE_SPENT, PREVIEW_CACHE_ENTRIES, PREVIEW_CACHE_MS, PreviewCache, PROVIDER_SILENT, QUOTA_SPENT } from "../routes/routing-preview"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys, signToken, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

const depot: Position2D = [12.5683, 55.6761]
const bin: Position2D = [12.575, 55.68]
const station: Position2D = [12.61, 55.71]
const along = (count: number): Position2D[] => Array.from({ length: count }, (_, index): Position2D => [12.5 + index / 10_000, 55.7])

const road = (provider = "fake"): RoutingPreview => ({ basis: "road", provider, legs: [], distanceMetres: 0, durationSeconds: 0 })

describe("the preview cache: fifty answers at most, each for a day, the least recently asked for let go first (#173)", () => {
  test("answers what it holds until a day after it was answered", () => {
    const cache = new PreviewCache()
    cache.set("a", road(), 0)
    assert.deepEqual(cache.get("a", PREVIEW_CACHE_MS - 1), road())
    assert.equal(cache.get("a", PREVIEW_CACHE_MS), undefined)
    assert.equal(PREVIEW_CACHE_MS, 24 * 60 * 60 * 1000)
  })

  test("holds fifty: the fifty-first lets go of the one least recently asked for", () => {
    const cache = new PreviewCache()
    for (let entry = 0; entry < PREVIEW_CACHE_ENTRIES; entry += 1) cache.set(`key-${entry}`, road(), 0)
    assert.ok(cache.get("key-0", 1), "asked for again: the most recently used now")
    cache.set("newest", road(), 2)
    assert.ok(cache.get("key-0", 3))
    assert.equal(cache.get("key-1", 3), undefined)
    assert.ok(cache.get("newest", 3))
    assert.equal(PREVIEW_CACHE_ENTRIES, 50)
  })
})

describe("POST /routing/preview (#173)", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
  })
  afterEach(async () => {
    for (const tenant of [a, b]) await withCompany(pool.db, tenant.companyId, (tx) => tx.delete(routingQuota).where(eq(routingQuota.companyId, tenant.companyId)))
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  /**
   * An app over its own provider and quota engine, which never waits, on a
   * clock the test moves. The clock starts a minute behind the database's,
   * so a row the database stamps after a call is newer than what the engine
   * learned from it; the jitter is none, so a resumption is the reset itself.
   */
  function previewing({ script = {}, provider }: { script?: FakeScript; provider?: RoutingProvider } = {}) {
    const clock = { now: Date.now() - 60_000 }
    const fake = new FakeProvider(script)
    const logged: unknown[] = []
    const engine = new QuotaEngine(provider ?? fake, { ...STANDARD_PLAN, waits: false, now: () => new Date(clock.now), random: () => 0, warn: () => undefined, error: () => undefined })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, routingEngine: engine, now: () => new Date(clock.now), log: (error) => void logged.push(error) })
    const preview = (call: Call, points: readonly Position2D[] | unknown) => call("/routing/preview", { method: "POST", body: { points } })
    return {
      app,
      fake,
      clock,
      logged,
      preview,
      olivia: callingAs(app, keys, a.users.olivia, a.companyId),
      otherCompany: callingAs(app, keys, b.users.olivia, b.companyId),
      viewer: callingAs(app, keys, a.users.viewer, a.companyId),
    }
  }

  const answerOf = async (response: Response): Promise<RoutingPreview> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RoutingPreview.parse(await response.json())
  }
  const storedRows = (companyId: string) => withCompany(pool.db, companyId, (tx) => quotaRows(tx, { companyId, provider: "fake" }))

  test("the road over the fake: one leg per consecutive pair of the body's points, a repeated point a zero leg, the totals their sums; no Plan written, the reading stored", async () => {
    const { fake, olivia, preview } = previewing()
    const answer = await answerOf(await preview(olivia, [depot, bin, bin, station]))
    assert.equal(answer.basis, "road")
    if (answer.basis !== "road") return
    assert.equal(answer.provider, "fake")
    assert.deepEqual(
      answer.legs.map((leg) => [leg.path.coordinates[0], leg.path.coordinates.at(-1)]),
      [
        [depot, bin],
        [bin, bin],
        [bin, station],
      ],
    )
    assert.deepEqual(answer.legs[1], { path: { type: "LineString", coordinates: [bin, bin] }, metres: 0, seconds: 0 })
    assert.ok(answer.distanceMetres > 0)
    assert.equal(answer.distanceMetres, answer.legs.reduce((sum, leg) => sum + leg.metres, 0))
    assert.equal(answer.durationSeconds, answer.legs.reduce((sum, leg) => sum + leg.seconds, 0))
    assert.equal(fake.calls.directions, 1, "one call, over the distinct points")
    const plans = await withCompany(pool.db, a.companyId, (tx) => tx.select({ id: plan.id }).from(plan).where(eq(plan.companyId, a.companyId)))
    assert.deepEqual(plans, [], "a Plan belongs to a Route; the preview has none")
    const [row] = await storedRows(a.companyId)
    assert.deepEqual([row.family, row.remaining, row.exhaustedAt, row.keyRefusedAt], ["directions", null, null, null], "the fake reports no limit, and the row says so")
  })

  test("the same points again are the cache's, for another person or another company alike; other points, or the same in another order, are a call of their own", async () => {
    const { fake, olivia, otherCompany, preview } = previewing()
    const first = await answerOf(await preview(olivia, [depot, bin, station]))
    assert.deepEqual(await answerOf(await preview(otherCompany, [depot, bin, station])), first)
    assert.equal(fake.calls.directions, 1)
    await answerOf(await preview(olivia, [station, bin, depot]))
    assert.equal(fake.calls.directions, 2, "the order is the request")
  })

  test("two requests for the same points at once share one call", async () => {
    const { fake, olivia, otherCompany, preview } = previewing()
    const [x, y] = await Promise.all([preview(olivia, [depot, station]), preview(otherCompany, [depot, station])])
    assert.deepEqual(await answerOf(x), await answerOf(y))
    assert.equal(fake.calls.directions, 1)
  })

  test("every point at one place is a road of zero legs, and no call", async () => {
    const { fake, olivia, preview } = previewing()
    assert.deepEqual(await answerOf(await preview(olivia, [bin, bin])), {
      basis: "road",
      provider: "fake",
      legs: [{ path: { type: "LineString", coordinates: [bin, bin] }, metres: 0, seconds: 0 }],
      distanceMetres: 0,
      durationSeconds: 0,
    })
    assert.equal(fake.calls.directions, 0)
  })

  test("the day's quota spent is no road: the estimate resuming at the provider's reset, the family stored exhausted and closed without a second 403, and nothing cached past the reset", async () => {
    const reset = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const { fake, clock, olivia, preview } = previewing({ script: { quota: { directions: { remaining: 3, limit: 2000, resetAt: reset.toISOString() } }, responses: { directions: [{ status: 403, quota: true }] } } })
    assert.deepEqual(await answerOf(await preview(olivia, [depot, station])), { basis: "estimate", provider: "fake", resumesAt: reset.toISOString(), reason: QUOTA_SPENT })
    const [row] = await storedRows(a.companyId)
    assert.equal(row.remaining, 0)
    assert.notEqual(row.exhaustedAt, null)
    assert.equal((await answerOf(await preview(olivia, [depot, bin, station]))).basis, "estimate")
    assert.equal(fake.calls.directions, 1, "the family stays closed until the reset")
    clock.now = reset.getTime() + 1_000
    assert.equal((await answerOf(await preview(olivia, [depot, station]))).basis, "road", "past the reset the first preview is the probe")
    assert.equal(fake.calls.directions, 2)
  })

  test("the worker's exhaustion, stored after this process learned the family, defers the preview without a call: the newer row is taken", async () => {
    const { fake, olivia, preview } = previewing()
    await answerOf(await preview(olivia, [depot, station]))
    const reset = new Date(Date.now() + 60 * 60 * 1000)
    await withCompany(pool.db, a.companyId, (tx) => recordQuota(tx, { companyId: a.companyId, provider: "fake", family: "directions" }, { remaining: 0, limit: 2000, resetAt: reset, exhaustedAt: new Date(), keyRefusedAt: null }))
    assert.deepEqual(await answerOf(await preview(olivia, [depot, bin, station])), { basis: "estimate", provider: "fake", resumesAt: reset.toISOString(), reason: QUOTA_SPENT })
    assert.equal(fake.calls.directions, 1)
  })

  test("a 429 is the minute's allowance: the estimate resuming when the window frees, one call and no wait inside the request", async () => {
    const { fake, clock, olivia, preview } = previewing({ script: { responses: { directions: [{ status: 429, retryAfterSeconds: 20 }] } } })
    const at = clock.now
    assert.deepEqual(await answerOf(await preview(olivia, [depot, station])), { basis: "estimate", provider: "fake", resumesAt: new Date(at + 20_000).toISOString(), reason: MINUTE_SPENT })
    assert.equal(fake.calls.directions, 1)
  })

  test("the key refused: the estimate with no resumption and the office's sentence, the refusal stored, and never cached, so the hour after it asks again", async () => {
    const { fake, clock, olivia, preview } = previewing({ script: { responses: { directions: [{ status: 401 }] } } })
    assert.deepEqual(await answerOf(await preview(olivia, [depot, station])), { basis: "estimate", provider: "fake", resumesAt: null, reason: KEY_REFUSED })
    const [row] = await storedRows(a.companyId)
    assert.notEqual(row.keyRefusedAt, null)
    clock.now += 61 * 60 * 1000
    assert.equal((await answerOf(await preview(olivia, [depot, station]))).basis, "road")
    assert.equal(fake.calls.directions, 2)
  })

  test("points the provider cannot route are no road, in its own words, and the cache keeps that: the same points ask nothing more", async () => {
    const sentence = "Could not find routable point within a radius of 350.0 meters of specified coordinate 1"
    const { fake, olivia, preview } = previewing({ script: { responses: { directions: [{ status: 404, sentence }] } } })
    const sea: Position2D = [12.9, 55.9]
    assert.deepEqual(await answerOf(await preview(olivia, [depot, sea])), { basis: "estimate", provider: "fake", resumesAt: null, reason: sentence })
    await answerOf(await preview(olivia, [depot, sea]))
    assert.equal(fake.calls.directions, 1)
  })

  test("a provider that does not answer is a 502 with a sentence, its cause logged, and nothing cached", async () => {
    let asked = 0
    const silent: RoutingProvider = {
      name: "fake",
      maxWaypoints: 50,
      measure: () => {
        asked += 1
        return Promise.reject(new Error("connect ECONNREFUSED"))
      },
      optimise: () => Promise.reject(new Error("not asked")),
    }
    const { logged, olivia, preview } = previewing({ provider: silent })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await preview(olivia, [depot, station])
      assert.equal(response.status, 502)
      assert.equal((await readProblem(response)).detail, PROVIDER_SILENT)
    }
    assert.equal(asked, 2)
    assert.equal(logged.length, 2)
  })

  test("a body that will not do is a 400 at its field, and asks nothing: one point, one too many, a third ordinate, a member it does not know", async () => {
    const { fake, olivia } = previewing()
    for (const body of [{ points: [depot] }, { points: along(ROUTING_PREVIEW_POINTS_MAX + 1) }, { points: [depot, [12.6, 55.7, 3]] }, { points: [depot, bin], profile: "driving-car" }]) {
      const response = await olivia("/routing/preview", { method: "POST", body })
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80))
      await readProblem(response)
    }
    assert.equal(fake.calls.directions, 0)
  })

  test("a role without view on route-studio.schemes is refused before any call, and so is a login with no account here, as every guard refuses it", async () => {
    const { app, fake, viewer, preview } = previewing()
    const refused = await preview(viewer, [depot, station])
    assert.equal(refused.status, 403)
    assert.match((await readProblem(refused)).detail ?? "", /route-studio\.schemes/)
    const stranger = await signToken(keys, { sub: randomUUID(), companyId: a.companyId, email: "nobody@example.com" })
    for (const [path, method] of [
      ["/me", "GET"],
      ["/routing/preview", "POST"],
    ] as const) {
      const response = await app.request(path, { method, headers: { authorization: `Bearer ${stranger}`, "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ points: [depot, station] }) } : {}) })
      assert.equal(response.status, 403, path)
      await readProblem(response, NO_ACTIVE_ACCOUNT)
    }
    assert.equal(fake.calls.directions, 0)
  })
})
