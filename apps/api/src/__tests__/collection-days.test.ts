import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { AddressMatches, PublicCollectionDays } from "@waste/contracts/public"
import { createDb, type Database } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { containerType, product, wasteFraction } from "@waste/db/schema/catalogue"
import { collectionCalendar, collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { customer, property } from "@waste/db/schema/customers"
import { route } from "@waste/db/schema/execution"
import { generationMatch, generationRun } from "@waste/db/schema/generation"
import { project } from "@waste/db/schema/organisation"
import { collectionGroup, collectionGroupContainer, routeScheme } from "@waste/db/schema/route-schemes"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { Allowance, FeedAllowance } from "../auth/public-door"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

/** Monday 5 October 2026, morning in Copenhagen: the first day every window here starts on. */
const NOW = new Date("2026-10-05T08:00:00.000Z")
const freshSlug = (name: string) => `${name}-${testId().replaceAll("-", "").slice(-12)}`

describe("the collection days by address on the public door", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let slug: string
  let theirSlug: string
  const ids = {
    glass: testId(),
    residual: testId(),
    binType: testId(),
    customer: testId(),
    parkvej1: testId(),
    parkvej3: testId(),
    harborProperty: testId(),
    product: testId(),
    agreement: testId(),
    subscription: testId(),
    glassBin: testId(),
    residualBin: testId(),
    scheme: testId(),
    glassGroup: testId(),
    residualGroup: testId(),
    run: testId(),
    calendar: testId(),
    heldRoute: testId(),
    theirProperty: testId(),
  }

  const get = async (path: string) => await app.request(path)
  const days = async (path: string): Promise<PublicCollectionDays> => {
    const response = await get(path)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PublicCollectionDays.parse(await response.json())
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    slug = freshSlug("days")
    theirSlug = freshSlug("their-days")
    const copenhagen = a.projects.copenhagen.id
    const companyId = a.companyId

    await withCompany(pool.db, companyId, async (tx) => {
      await tx.update(project).set({ publicSlug: slug, holidayList: "Danish public holidays" }).where(eq(project.id, copenhagen))
      await tx.update(project).set({ publicSlug: null }).where(eq(project.id, a.projects.harbor.id))
      await tx.insert(wasteFraction).values([
        { id: ids.glass, companyId, key: "glass", name: "Glass" },
        { id: ids.residual, companyId, key: "residual", name: "Residual" },
      ])
      await tx.insert(containerType).values({ id: ids.binType, companyId, name: "240 L" })
      await tx.insert(customer).values({ id: ids.customer, companyId, kind: "person", name: "Mikkel Sørensen", status: "active" })
      await tx.insert(property).values([
        { id: ids.parkvej1, companyId, projectId: copenhagen, name: "Parkvej 1", address: "Parkvej 1, 2100 København Ø", kind: "residential", status: "active" },
        { id: ids.parkvej3, companyId, projectId: copenhagen, name: "Parkvej 3", address: "Parkvej 3, 2100 København Ø", kind: "residential", status: "active" },
        { id: ids.harborProperty, companyId, projectId: a.projects.harbor.id, name: "Havnen 1", address: "Parkvej 9, Havnen", kind: "commercial", status: "active" },
      ])
      await tx.insert(product).values({ id: ids.product, companyId, projectId: copenhagen, name: "Bin collection", kind: "container-collection", status: "active", unit: "pickup" })
      await tx.insert(agreement).values({ id: ids.agreement, companyId, projectId: copenhagen, validFrom: "2026-01-01", number: `AGR-${testId().slice(-6)}`, customerId: ids.customer, payerCustomerId: ids.customer, status: "active", billingCadence: "monthly", currency: "DKK" })
      // Parkvej 1 holds the subscription; Parkvej 3 holds none, so it has nothing to collect.
      await tx.insert(subscription).values({ id: ids.subscription, companyId, projectId: copenhagen, validFrom: "2026-01-01", agreementId: ids.agreement, productId: ids.product, propertyId: ids.parkvej1 })
      await tx.insert(container).values([
        { id: ids.glassBin, companyId, projectId: copenhagen, label: "BIN-G", containerTypeId: ids.binType, ownership: "company" },
        { id: ids.residualBin, companyId, projectId: copenhagen, label: "BIN-R", containerTypeId: ids.binType, ownership: "company" },
      ])
      await tx.insert(containerServicePlacement).values([
        { companyId, projectId: copenhagen, validFrom: "2026-01-01", containerId: ids.glassBin, subscriptionId: ids.subscription, wasteFractionId: ids.glass },
        { companyId, projectId: copenhagen, validFrom: "2026-01-01", containerId: ids.residualBin, subscriptionId: ids.subscription, wasteFractionId: ids.residual },
      ])
      // Mondays and Thursdays from October; a manual group on Thursdays lists the glass bin, a rule group on Mondays matched the residual one.
      await tx.insert(routeScheme).values({ id: ids.scheme, companyId, projectId: copenhagen, validFrom: "2026-10-01", name: `Centrum ${testId().slice(-6)}`, serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday", "thursday"], holidayPolicy: "skip", status: "validated" })
      await tx.insert(collectionGroup).values([
        { id: ids.glassGroup, companyId, projectId: copenhagen, routeSchemeId: ids.scheme, name: "Glass Thursdays", position: 1, days: ["thursday"], stopSource: "manual" },
        { id: ids.residualGroup, companyId, projectId: copenhagen, routeSchemeId: ids.scheme, name: "Residual Mondays", position: 2, days: ["monday"], stopSource: "rule" },
      ])
      await tx.insert(collectionGroupContainer).values({ companyId, projectId: copenhagen, collectionGroupId: ids.glassGroup, containerId: ids.glassBin, position: 1 })
      await tx.insert(generationRun).values({ id: ids.run, companyId, projectId: copenhagen, routeSchemeId: ids.scheme, trigger: "on-demand", windowFrom: "2026-10-05", windowTo: "2026-10-11", status: "succeeded" })
      await tx.insert(generationMatch).values({ companyId, projectId: copenhagen, collectionGroupId: ids.residualGroup, generationRunId: ids.run, ruleSignature: "test", containerIds: [ids.residualBin] })
      // Thursday 15 October is a holiday: the skip policy leaves it out.
      await tx.insert(collectionCalendar).values({ id: ids.calendar, companyId, projectId: copenhagen, validFrom: "2026-01-01", name: `Holidays ${testId().slice(-6)}` })
      await tx.insert(collectionCalendarHoliday).values({ companyId, projectId: copenhagen, collectionCalendarId: ids.calendar, day: "2026-10-15", name: "Testdag" })
      // The office held Monday 12 October's residual route on Tuesday the 13th.
      await tx.insert(route).values({ id: ids.heldRoute, companyId, projectId: copenhagen, routeSchemeId: ids.scheme, collectionGroupId: ids.residualGroup, serviceDate: "2026-10-12", operatingDate: "2026-10-13", number: Number(String(Date.now()).slice(-6)), status: "planned", heldAt: NOW })
    })
    await withCompany(pool.db, b.companyId, async (tx) => {
      await tx.update(project).set({ publicSlug: theirSlug }).where(eq(project.id, b.projects.copenhagen.id))
      await tx.insert(property).values({ id: ids.theirProperty, companyId: b.companyId, projectId: b.projects.copenhagen.id, name: "Their Parkvej", address: "Parkvej 1, Elsewhere", kind: "residential", status: "active" })
    })
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  describe("GET /public/:slug/addresses", () => {
    test("finds the project's addresses with something collected, by address, the address alone", async () => {
      const response = await get(`/public/${slug}/addresses?q=parkvej`)
      assert.equal(response.status, 200)
      const found = AddressMatches.parse(await response.json())
      assert.deepEqual(found.project, { slug, name: "Copenhagen Central", language: "da", timezone: "Europe/Copenhagen" }, "the project searched, so a page asks once")
      assert.deepEqual(found.addresses, [{ id: ids.parkvej1, address: "Parkvej 1, 2100 København Ø" }], "not Parkvej 3 (nothing collected), not Harbor's (unpublished), not the other company's")
    })

    test("needs three characters, and never lists", async () => {
      await assertRefused(await get(`/public/${slug}/addresses?q=pa`), 400)
      await assertRefused(await get(`/public/${slug}/addresses`), 400)
      await assertRefused(await get(`/public/${slug}/addresses?q=%20%20%20`), 400)
    })
  })

  describe("GET /public/:slug/addresses/:id/collection-days", () => {
    test("the address's days as generation plans them: the groups' days, a holiday skipped, a held route on the office's day", async () => {
      const answer = await days(`/public/${slug}/addresses/${ids.parkvej1}/collection-days?weeks=2`)
      assert.deepEqual([answer.from, answer.to], ["2026-10-05", "2026-10-18"])
      assert.deepEqual(answer.address, { id: ids.parkvej1, address: "Parkvej 1, 2100 København Ø" })
      assert.equal(answer.project.slug, slug)
      assert.deepEqual(
        answer.days.map((day) => [day.date, day.serviceDate, day.fractions.join("+"), day.status]),
        [
          ["2026-10-05", "2026-10-05", "Residual", "collected"],
          ["2026-10-08", "2026-10-08", "Glass", "collected"],
          ["2026-10-13", "2026-10-12", "Residual", "collected"],
          ["2026-10-15", "2026-10-15", "Glass", "skipped"],
        ],
      )
      assert.equal(answer.days[2]?.note, "Moved to Tue 13 Oct", "the office's move says so")
      assert.equal(answer.days[3]?.note, "Skipped · Testdag")
      assert.deepEqual(Object.keys(answer.days[0] ?? {}).sort(), ["date", "fractions", "note", "serviceDate", "status"], "dates, fractions and the note, nothing else")
    })

    test("defaults to eight weeks, refuses more than 26, and is a 404 for an address that is not the project's or has nothing collected", async () => {
      const eight = await days(`/public/${slug}/addresses/${ids.parkvej1}/collection-days`)
      assert.equal(eight.to, "2026-11-29")
      await assertRefused(await get(`/public/${slug}/addresses/${ids.parkvej1}/collection-days?weeks=27`), 400)
      for (const other of [ids.parkvej3, ids.harborProperty, ids.theirProperty, testId()]) {
        const problem = await assertRefused(await get(`/public/${slug}/addresses/${other}/collection-days`), 404)
        assert.match(problem.detail ?? "", /^No address with something to collect/)
      }
      await assertRefused(await get(`/public/${theirSlug}/addresses/${ids.parkvej1}/collection-days`), 404)
    })
  })

  describe("GET /public/:slug/addresses/:id/collection-days.ics", () => {
    test("a calendar feed: one all-day event per day, a stable UID naming no internal id, the skipped day cancelled, the project's timezone", async () => {
      const response = await get(`/public/${slug}/addresses/${ids.parkvej1}/collection-days.ics?weeks=2`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get("content-type") ?? "", /^text\/calendar/)
      const lines = (await response.text()).split("\r\n")
      assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 4)
      const uid = createHash("sha256").update(`${ids.glassGroup}|2026-10-08`).digest("hex").slice(0, 32)
      assert.ok(lines.includes(`UID:${uid}@${slug}`), "the route's identity, hashed")
      assert.ok(!lines.some((line) => line.includes(ids.glassGroup) || line.includes(ids.residualGroup)), "no internal id leaves the door")
      assert.ok(lines.includes("SEQUENCE:1"), "the moved and the cancelled days")
      assert.ok(lines.includes("DTSTART;VALUE=DATE:20261013"), "the held day")
      assert.ok(lines.includes("SUMMARY:No collection: Glass"))
      assert.ok(lines.includes("STATUS:CANCELLED"))
      assert.ok(lines.includes("X-WR-TIMEZONE:Europe/Copenhagen"))
      assert.ok(!lines.some((line) => line.includes("Mikkel")), "no customer data")
    })
  })
})

describe("an address's feed behind its own allowance", { skip: database.skip }, () => {
  // Counted apart from the pages, per client and address and per client across
  // addresses: a calendar service reading many residents' feeds from one address
  // is not held to a visitor's minute, and the feed walks addresses no faster.
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let slug: string
  let address: string

  before(async () => {
    pool = createDb(database.url!, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    slug = freshSlug("feed")
    address = testId()
    await withCompany(pool.db, a.companyId, async (tx) => {
      await tx.update(project).set({ publicSlug: slug }).where(eq(project.id, a.projects.copenhagen.id))
    })
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    await pool?.close()
  })

  test("a client past a visitor's minute still reads one feed, up to the feed's bound for that address, and walks only the feed's few addresses", async () => {
    const limited = createApp({
      probe: pool,
      pool,
      verifier: keys.verifier,
      now: () => NOW,
      publicAllowance: new Allowance(1, () => NOW),
      feedAllowance: new FeedAllowance(3, 2, () => NOW),
      trustedProxies: 1,
    })
    const from = (client: string, path: string) => limited.request(path, { headers: { "x-forwarded-for": client } })
    const feed = (id: string) => `/public/${slug}/addresses/${id}/collection-days.ics`
    assert.equal((await from("198.51.100.1", `/public/${slug}`)).status, 200)
    assert.equal((await from("198.51.100.1", `/public/${slug}`)).status, 429, "the visitor's minute is spent")
    for (let i = 0; i < 3; i++) assert.equal((await from("198.51.100.1", feed(address))).status, 404, "an address with nothing collected, read through the feed's own allowance")
    const over = await from("198.51.100.1", feed(address))
    assert.equal(over.status, 429, "the feed's bound for one address")
    assert.equal(over.headers.get("retry-after"), "60")
    assert.equal((await from("198.51.100.1", feed(testId()))).status, 404, "a second address")
    assert.equal((await from("198.51.100.1", feed(testId()))).status, 429, "a third is past the addresses one client reads a minute")
    assert.equal((await from("198.51.100.1", feed("not-an-id"))).status, 429, "a malformed address counts the same: the door counts before the path is read")
    assert.equal((await from("198.51.100.2", feed(address))).status, 404, "another client reads apart")
  })
})

async function assertRefused(response: Response, status: number) {
  assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
  return await readProblem(response)
}
