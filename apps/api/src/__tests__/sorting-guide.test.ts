import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { Project } from "@waste/contracts/organisation"
import { Page } from "@waste/contracts/pagination"
import { PublishedProject } from "@waste/contracts/public"
import { SortingGuideAnswer, SortingGuideItem } from "@waste/contracts/sorting-guide"
import { createDb, type Database } from "@waste/db/client"

import { Allowance, allowanceKey } from "../auth/public-door"
import { createApp } from "../app"
import { PUBLIC_CACHE } from "../routes/public"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const ItemPage = Page(SortingGuideItem)

/** A slug no other run of this file has taken: the key is unique across every company on the shared database. */
const freshSlug = (name: string) => `${name}-${testId().replaceAll("-", "").slice(-12)}`

describe("the sorting guide and the public door", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  let other: Call
  /** On the viewer role: configure.access alone, so every guide route is a 403. */
  let viewer: Call
  /** Anonymous, as the public door is called: no token at all. */
  let anyone: (path: string, headers?: Record<string, string>) => Promise<Response>

  let glass: WasteFraction
  let theirGlass: WasteFraction
  let slug: string
  let harborSlug: string
  let theirSlug: string

  type Schema<T> = { parse: (value: unknown) => T }
  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const item = (call: Call, projectId: string, name: string, values: Record<string, unknown> = {}) =>
    create(call, "/sorting-guide-items", { projectId, name, ...values }, SortingGuideItem)
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const publish = async (call: Call, projectId: string, publicSlug: string | null): Promise<Project> => {
    const response = await call(`/projects/${projectId}`, { method: "PATCH", body: { publicSlug } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Project.parse(await response.json())
  }
  const search = async (projectSlug: string, q: string, more = ""): Promise<SortingGuideAnswer> => {
    const response = await anyone(`/public/${projectSlug}/sorting-guide?q=${encodeURIComponent(q)}${more}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return SortingGuideAnswer.parse(await response.json())
  }
  const names = (answer: SortingGuideAnswer) => answer.matches.map((match) => match.name)

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    // The viewer reaches Copenhagen with configure.access alone: no grant on the guide.
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "configure.access", actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    anyone = async (path, headers = {}) => await app.request(path, { headers })

    glass = await create(olivia, "/waste-fractions", { key: "glass", name: "Glas og metal" }, WasteFraction)
    theirGlass = await create(other, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
    slug = freshSlug("kystbyen")
    harborSlug = freshSlug("harbor")
    theirSlug = freshSlug("theirs")
    await publish(olivia, a.projects.copenhagen.id, slug)
    await publish(other, b.projects.copenhagen.id, theirSlug)

    const copenhagen = a.projects.copenhagen.id
    await item(olivia, copenhagen, "Glasflaske", { synonyms: ["vinflaske", "syltetøjsglas"], wasteFractionId: glass.id, instructions: "Skyl den. Låget i metal.", status: "published" })
    await item(olivia, copenhagen, "Batterier", { synonyms: ["knapcelle"], status: "published" })
    await item(olivia, copenhagen, "Pizzabakke", { synonyms: ["pizza box"], status: "draft" })
    await item(olivia, copenhagen, "Glaskeramik", { status: "withdrawn" })
    await item(olivia, a.projects.harbor.id, "Glasskår", { status: "published" })
    await item(other, b.projects.copenhagen.id, "Glass jar", { wasteFractionId: theirGlass.id, status: "published" })
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  describe("the office's items", () => {
    test("POST mints the id, defaults to a draft with no synonyms, and reads back", async () => {
      const made = await item(olivia, a.projects.copenhagen.id, "Kaffegrums")
      assert.deepEqual([made.status, made.synonyms, made.wasteFractionId, made.instructions], ["draft", [], null, null])
      const response = await olivia(`/sorting-guide-items/${made.id}`)
      assert.deepEqual(SortingGuideItem.parse(await response.json()), made)
    })

    test("refuses another company's fraction at the field, a name the project's guide already has, and a project the caller does not work in", async () => {
      const foreign = await refused(await olivia("/sorting-guide-items", { method: "POST", body: { projectId: a.projects.copenhagen.id, name: "Syltetøjsglas", wasteFractionId: theirGlass.id } }), 400)
      assert.deepEqual(foreign.errors?.map((error) => error.path), ["wasteFractionId"])
      const taken = await refused(await olivia("/sorting-guide-items", { method: "POST", body: { projectId: a.projects.copenhagen.id, name: "Batterier" } }), 409)
      assert.equal(taken.detail, `This project's sorting guide already has an item called "Batterier"`)
      const elsewhere = await refused(await olivia("/sorting-guide-items", { method: "POST", body: { projectId: b.projects.copenhagen.id, name: "Anything" } }), 400)
      assert.deepEqual(elsewhere.errors?.map((error) => error.path), ["projectId"])
    })

    test("PATCH replaces the synonyms whole, clears with null, and withdraws without deleting; another company's item is a 404", async () => {
      const made = await item(olivia, a.projects.copenhagen.id, "Mælkekarton", { synonyms: ["karton", "juicekarton"], wasteFractionId: glass.id })
      const response = await olivia(`/sorting-guide-items/${made.id}`, { method: "PATCH", body: { synonyms: ["karton"], wasteFractionId: null, status: "withdrawn" } })
      assert.equal(response.status, 200)
      const patched = SortingGuideItem.parse(await response.json())
      assert.deepEqual([patched.synonyms, patched.wasteFractionId, patched.status], [["karton"], null, "withdrawn"])
      const [theirs] = ItemPage.parse(await (await other("/sorting-guide-items")).json()).items
      assert.ok(theirs)
      await refused(await olivia(`/sorting-guide-items/${theirs.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      await refused(await olivia(`/sorting-guide-items/${theirs.id}`), 404)
    })

    test("GET lists the caller's projects' items, narrowed by project and status; a role without the grant is refused", async () => {
      const published = ItemPage.parse(await (await olivia(`/sorting-guide-items?projectId=${a.projects.copenhagen.id}&status=published`)).json())
      assert.deepEqual(published.items.map((row) => row.name).sort(), ["Batterier", "Glasflaske"])
      const theirs = ItemPage.parse(await (await other("/sorting-guide-items")).json())
      assert.deepEqual(theirs.items.map((row) => row.name), ["Glass jar"])
      await refused(await viewer("/sorting-guide-items"), 403)
    })
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
      assert.equal(response.headers.get("cache-control"), PUBLIC_CACHE)
      assert.deepEqual(PublishedProject.parse(await response.json()), { slug, name: a.projects.copenhagen.name, language: "da", timezone: "Europe/Copenhagen" })
    })

    test("a slug nobody publishes under, and a path segment that is no slug, are the same 404", async () => {
      for (const path of [`/public/${freshSlug("nobody")}`, "/public/Not%20A%20Slug", "/public/ab", `/public/${freshSlug("nobody")}/sorting-guide?q=glas`]) {
        const problem = await refused(await anyone(path), 404)
        assert.match(problem.detail ?? "", /^No project is published as /, path)
      }
    })

    test("a search finds the project's published items, best first, with the fraction, the instructions and the spelling that matched", async () => {
      const answer = await search(slug, "glasflaske")
      assert.equal(answer.query, "glasflaske")
      assert.deepEqual(answer.matches, [
        {
          id: answer.matches[0]?.id ?? "",
          name: "Glasflaske",
          synonyms: ["vinflaske", "syltetøjsglas"],
          matched: "Glasflaske",
          fraction: { key: "glass", name: "Glas og metal" },
          instructions: "Skyl den. Låget i metal.",
        },
      ])
      const synonym = await search(slug, "knapcelle")
      assert.deepEqual(synonym.matches.map((match) => [match.name, match.matched, match.fraction]), [["Batterier", "knapcelle", null]])
    })

    test("never finds a draft, a withdrawn item, another project's or another company's, whatever the query", async () => {
      assert.deepEqual(names(await search(slug, "glas")), ["Glasflaske"], "not Glaskeramik (withdrawn) nor Glasskår (Harbor's)")
      assert.deepEqual(names(await search(slug, "pizza")), [], "a draft is the office's alone")
      assert.deepEqual(names(await search(slug, "jar")), [], "another company's")
      assert.deepEqual(names(await search(theirSlug, "glass")), ["Glass jar"])
    })

    test("Harbor's items reach the door only once Harbor publishes itself, and unpublishing closes the door at once", async () => {
      await refused(await anyone(`/public/${harborSlug}/sorting-guide?q=glas`), 404)
      await publish(olivia, a.projects.harbor.id, harborSlug)
      assert.deepEqual(names(await search(harborSlug, "glasskår")), ["Glasskår"])
      await publish(olivia, a.projects.harbor.id, null)
      await refused(await anyone(`/public/${harborSlug}/sorting-guide?q=glas`), 404)
    })

    test("a query of punctuation finds nothing; a missing or overlong query and a limit out of range are a 400; the limit bounds the answer", async () => {
      assert.deepEqual(names(await search(slug, " -- ")), [])
      await refused(await anyone(`/public/${slug}/sorting-guide`), 400)
      await refused(await anyone(`/public/${slug}/sorting-guide?q=${"x".repeat(101)}`), 400)
      await refused(await anyone(`/public/${slug}/sorting-guide?q=glas&limit=21`), 400)
      assert.equal((await search(slug, "glas", "&limit=1")).matches.length, 1)
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
