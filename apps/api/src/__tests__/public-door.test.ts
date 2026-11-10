// A project's public slug and the public door it opens (Issue #293,
// ADR-0010): publishing reads back on the project and a slug is one project's
// across every company; `GET /public/:slug` names the published project with
// no token, its branding with it, and a slug nobody publishes under is a 404;
// and the allowance every public read is counted against. The Collection
// Days' and the Drop-off Points' own reads are their suites'.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Project } from "@waste/contracts/organisation"
import { PublishedProject } from "@waste/contracts/public"
import { createDb, type Database } from "@waste/db/client"

import { Allowance, allowanceKey } from "../auth/public-door"
import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

/** A slug no other run of this file has taken: the key is unique across every company on the shared database. */
const freshSlug = (name: string) => `${name}-${testId().replaceAll("-", "").slice(-12)}`

const UNBRANDED = { brandColor: null, logoUrl: null, accessibilityStatementUrl: null }

describe("a project's public slug and the public door", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let other: Call
  /** Anonymous, as the public door is called: no token at all. */
  let anyone: (path: string, headers?: Record<string, string>) => Promise<Response>

  let slug: string
  let harborSlug: string
  let theirSlug: string

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const publish = async (call: Call, projectId: string, publicSlug: string | null): Promise<Project> => {
    const response = await call(`/projects/${projectId}`, { method: "PATCH", body: { publicSlug } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Project.parse(await response.json())
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    anyone = async (path, headers = {}) => await app.request(path, { headers })

    slug = freshSlug("kystbyen")
    harborSlug = freshSlug("harbor")
    theirSlug = freshSlug("theirs")
    await publish(olivia, a.projects.copenhagen.id, slug)
    await publish(other, b.projects.copenhagen.id, theirSlug)
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  describe("a project's public slug", () => {
    test("publishing reads back on the project; a slug another project holds, in any company, is a 409 naming the slug alone", async () => {
      const project = Project.parse(await (await olivia(`/projects/${a.projects.copenhagen.id}`)).json())
      assert.equal(project.publicSlug, slug)
      const taken = await refused(await olivia(`/projects/${a.projects.harbor.id}`, { method: "PATCH", body: { publicSlug: theirSlug } }), 409)
      assert.equal(taken.detail, `Another project already publishes itself as ${JSON.stringify(theirSlug)}; choose another slug`)
      const shape = await refused(await olivia(`/projects/${a.projects.harbor.id}`, { method: "PATCH", body: { publicSlug: "Not A Slug" } }), 400)
      assert.deepEqual(shape.errors?.map((error) => error.path), ["publicSlug"])
    })
  })

  describe("the public door", () => {
    test("GET /public/:slug names the published project with no token, by slug and never by id, and may be cached for a minute", async () => {
      const response = await anyone(`/public/${slug}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("cache-control"), "public, max-age=60")
      assert.deepEqual(PublishedProject.parse(await response.json()), { slug, name: a.projects.copenhagen.name, language: "da", timezone: "Europe/Copenhagen", branding: UNBRANDED })
    })

    test("a project's branding reaches its public pages as it set it, and none again once it clears it (M22)", async () => {
      const branding = { brandColor: "#1f6f3f", logoUrl: "https://kommune.example/logo.svg", accessibilityStatementUrl: "https://kommune.example/tilgaengelighed" }
      assert.equal((await olivia(`/projects/${a.projects.copenhagen.id}/branding`, { method: "PUT", body: branding })).status, 200)
      try {
        assert.deepEqual(PublishedProject.parse(await (await anyone(`/public/${slug}`)).json()).branding, branding)
      } finally {
        assert.equal((await olivia(`/projects/${a.projects.copenhagen.id}/branding`, { method: "PUT", body: UNBRANDED })).status, 200)
      }
      assert.deepEqual(PublishedProject.parse(await (await anyone(`/public/${slug}`)).json()).branding, UNBRANDED)
    })

    test("a slug nobody publishes under, and a path segment that is no slug, are the same 404", async () => {
      for (const path of [`/public/${freshSlug("nobody")}`, "/public/Not%20A%20Slug", "/public/ab", `/public/${freshSlug("nobody")}/drop-off-points`]) {
        const problem = await refused(await anyone(path), 404)
        assert.match(problem.detail ?? "", /^No project is published as /, path)
      }
    })

    test("Harbor reaches the door only once it publishes itself, and unpublishing closes the door at once", async () => {
      await refused(await anyone(`/public/${harborSlug}`), 404)
      await publish(olivia, a.projects.harbor.id, harborSlug)
      assert.equal(PublishedProject.parse(await (await anyone(`/public/${harborSlug}`)).json()).name, a.projects.harbor.name)
      await publish(olivia, a.projects.harbor.id, null)
      await refused(await anyone(`/public/${harborSlug}`), 404)
    })
  })

  describe("the allowance", () => {
    test("a client past its requests for the minute is a 429 with Retry-After; another client, and the next minute, are not", async () => {
      let at = new Date("2026-10-24T09:00:00.000Z")
      const limited = createApp({ probe: pool, pool, verifier: keys.verifier, publicAllowance: new Allowance(2, () => at), trustedProxies: 1 })
      const from = (address: string) => limited.request(`/public/${slug}`, { headers: { "x-forwarded-for": `203.0.113.9, ${address}` } })
      assert.equal((await from("198.51.100.1")).status, 200)
      assert.equal((await from("198.51.100.1")).status, 200)
      const over = await from("198.51.100.1")
      assert.equal(over.status, 429)
      assert.equal(over.headers.get("retry-after"), "60")
      assert.match((await readProblem(over)).detail ?? "", /^Too many requests from this address/)
      assert.equal((await from("198.51.100.2")).status, 200, "behind one trusted proxy the last entry is the client: the proxy appended it")
      at = new Date("2026-10-24T09:01:00.000Z")
      assert.equal((await from("198.51.100.1")).status, 200, "a new minute")
    })

    test("with no proxy trusted, the header is the client's own word and is ignored: the socket's peer is the client", async () => {
      const at = new Date("2026-10-24T09:00:00.000Z")
      const direct = createApp({ probe: pool, pool, verifier: keys.verifier, publicAllowance: new Allowance(1, () => at), peer: () => "192.0.2.7" })
      const forging = (address: string) => direct.request(`/public/${slug}`, { headers: { "x-forwarded-for": address } })
      assert.equal((await forging("198.51.100.1")).status, 200)
      assert.equal((await forging("198.51.100.2")).status, 429, "a fresh header is the same peer")
    })

    test("behind two trusted proxies the client is the second entry from the end; a header shorter than that falls back to the peer", async () => {
      const at = new Date("2026-10-24T09:00:00.000Z")
      const behindTwo = createApp({ probe: pool, pool, verifier: keys.verifier, publicAllowance: new Allowance(1, () => at), peer: () => "192.0.2.8", trustedProxies: 2 })
      const from = (header: string) => behindTwo.request(`/public/${slug}`, { headers: { "x-forwarded-for": header } })
      assert.equal((await from("6.6.6.6, 198.51.100.1, 10.0.0.1")).status, 200)
      assert.equal((await from("7.7.7.7, 198.51.100.1, 10.0.0.2")).status, 429, "what the client wrote before the proxies' entries is not the client")
      assert.equal((await from("198.51.100.3")).status, 200, "one entry is not two proxies: the peer, counted fresh")
      assert.equal((await from("198.51.100.4")).status, 429, "the same peer again")
    })

    test("an IPv6 client is counted by its /64, an IPv4-mapped one as its IPv4", () => {
      assert.equal(allowanceKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64")
      assert.equal(allowanceKey("2001:0db8:0001:0002:bbbb:cccc:dddd:9"), "2001:db8:1:2::/64")
      assert.equal(allowanceKey("2001:db8::1"), "2001:db8:0:0::/64")
      assert.equal(allowanceKey("::1"), "0:0:0:0::/64")
      assert.equal(allowanceKey("fe80::1%en0"), "fe80:0:0:0::/64")
      assert.equal(allowanceKey("::ffff:198.51.100.1"), "198.51.100.1")
      assert.equal(allowanceKey("198.51.100.1"), "198.51.100.1")
    })
  })
})
