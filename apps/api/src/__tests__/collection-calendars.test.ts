import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { CollectionCalendar, ONE_HOLIDAY_PER_DAY, OUTSIDE_CALENDAR_PERIOD } from "@waste/contracts/collection-calendars"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const CollectionCalendarPage = Page(CollectionCalendar)

const MODULE = "configure.calendars"

const CALENDAR_RUNNING = "This project already has a calendar in force over that period; a project has one calendar at a time"
/** The contracts' sentence: the create schema says it where it sees the period, the PUT route where only the stored row does. */
const OUTSIDE = OUTSIDE_CALENDAR_PERIOD

/**
 * A project has one calendar in force at a time, so every calendar of
 * Copenhagen Central in this file takes a year of its own: the per-year
 * records tile the timeline, and a test that wrote a second 2026 would be
 * refused by the rule another test proves.
 */
const year = (y: number) => ({ validFrom: `${y}-01-01`, validTo: `${y + 1}-01-01` })

describe("the collection calendar endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  /** The Service Provider Manager, granted view: a role that reaches no project of the company. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  /** The other company's. */
  let theirCalendar: CollectionCalendar

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    theirCalendar = await create(other, {
      projectId: b.projects.copenhagen.id,
      name: "Their 2026",
      holidays: [{ day: "2026-12-25", name: "Christmas Day" }],
      ...year(2026),
    })
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  /** A calendar body a caller may send: one year of Copenhagen Central, named for the year unless a test says otherwise. */
  const body = (y: number, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    name: `Copenhagen Central ${y}`,
    ...year(y),
    ...values,
  })

  const create = async (call: Call, values: unknown): Promise<CollectionCalendar> => {
    const response = await call("/collection-calendars", { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return CollectionCalendar.parse(await response.json())
  }
  const calendar = (y: number, values: Record<string, unknown> = {}) => create(olivia, body(y, values))
  const one = async (call: Call, id: string): Promise<CollectionCalendar> => {
    const response = await call(`/collection-calendars/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionCalendar.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<CollectionCalendar> => {
    const response = await call(`/collection-calendars/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionCalendar.parse(await response.json())
  }
  const put = async (call: Call, id: string, holidays: unknown): Promise<CollectionCalendar> => {
    const response = await call(`/collection-calendars/${id}/holidays`, { method: "PUT", body: { holidays } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionCalendar.parse(await response.json())
  }
  const page = async (call: Call, query = "") => {
    const response = await call(`/collection-calendars${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return CollectionCalendarPage.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  describe("POST /collection-calendars", () => {
    test("mints the id, keeps the period, and answers the holidays it started with by day", async () => {
      const created = await calendar(2026, {
        holidays: [
          { day: "2026-12-25", name: "Christmas Day" },
          { day: "2026-06-05", name: "Grundlovsdag" },
          { day: "2026-05-01", name: null },
        ],
      })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal(created.projectId, a.projects.copenhagen.id)
      assert.deepEqual([created.validFrom, created.validTo], ["2026-01-01", "2027-01-01"])
      assert.deepEqual(
        created.holidays,
        [
          { day: "2026-05-01", name: null },
          { day: "2026-06-05", name: "Grundlovsdag" },
          { day: "2026-12-25", name: "Christmas Day" },
        ],
        "by day, whatever order the body spelled them in; a name nobody gave is null",
      )
      assert.deepEqual(await one(olivia, created.id), created)

      const bare = await calendar(2027)
      assert.deepEqual(bare.holidays, [], "no holidays when the body names none")
      // In Cairo, whose timeline no other test of this file uses: an open calendar would overlap every later year of Copenhagen's.
      const running = await calendar(2040, { projectId: a.projects.cairo.id, name: "Cairo 2040 onwards", validTo: undefined })
      assert.equal(running.validTo, null, "a calendar with no end is one that is still running")
    })

    test("refuses a holiday outside the calendar's period by entry — the schema's own check, since a create body carries the period — and writes nothing", async () => {
      const problem = await refused(
        await olivia("/collection-calendars", {
          method: "POST",
          body: body(2028, {
            holidays: [
              { day: "2028-06-05", name: "Grundlovsdag" },
              { day: "2029-01-01", name: "New Year's Day" },
              { day: "2027-12-31", name: "The day before" },
            ],
          }),
        }),
        400,
      )
      assert.deepEqual(problem.errors, [
        { path: "holidays.1.day", message: OUTSIDE },
        { path: "holidays.2.day", message: OUTSIDE },
      ])
      assert.equal((await page(olivia, "?limit=200")).items.some((row) => row.name === "Copenhagen Central 2028"), false)
    })

    test("refuses two holidays on one day, at the schema, naming the list", async () => {
      const problem = await refused(
        await olivia("/collection-calendars", {
          method: "POST",
          body: body(2028, { holidays: [{ day: "2028-12-25", name: "Christmas Day" }, { day: "2028-12-25", name: "Also Christmas" }] }),
        }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "holidays", message: ONE_HOLIDAY_PER_DAY }])
    })

    test("refuses a period overlapping the project's other calendar with its sentence, and takes the next year back to back", async () => {
      await calendar(2029)
      const problem = await refused(
        await olivia("/collection-calendars", { method: "POST", body: body(2029, { name: "Copenhagen Central 2029/30", validFrom: "2029-07-01", validTo: "2030-07-01" }) }),
        409,
      )
      assert.equal(problem.detail, CALENDAR_RUNNING)
      assert.doesNotMatch(problem.detail ?? "", /no_overlap/)
      const next = await calendar(2030)
      assert.equal(next.validFrom, "2030-01-01", "the day one calendar ends is the day the next may begin")
      const harbor = await calendar(2029, { projectId: a.projects.harbor.id, name: "Harbor 2029" })
      assert.equal(harbor.projectId, a.projects.harbor.id, "another project's calendar over the same year is another project's")
    })

    test("refuses a name the project already uses, and lets another project use it", async () => {
      await calendar(2031)
      const problem = await refused(await olivia("/collection-calendars", { method: "POST", body: body(2032, { name: "Copenhagen Central 2031" }) }), 409)
      assert.equal(problem.detail, 'This project already has a collection calendar called "Copenhagen Central 2031"')
      assert.doesNotMatch(problem.detail ?? "", /_key/)
      const harbor = await calendar(2031, { projectId: a.projects.harbor.id })
      assert.equal(harbor.name, "Copenhagen Central 2031")
    })

    test("refuses a project the caller does not work in, a member the server owns, and a period that ends where it starts", async () => {
      const foreign = await refused(await olivia("/collection-calendars", { method: "POST", body: body(2033, { projectId: b.projects.copenhagen.id }) }), 400)
      assert.deepEqual(foreign.errors, [{ path: "projectId", message: "Not a project this account works in" }])
      const owned = await refused(await olivia("/collection-calendars", { method: "POST", body: body(2033, { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
      const empty = await refused(await olivia("/collection-calendars", { method: "POST", body: body(2033, { validTo: "2033-01-01" }) }), 400)
      assert.deepEqual(empty.errors?.map((error) => error.path), ["validTo"])
    })

    test("refuses a role that may view but not create", async () => {
      const problem = await refused(await lars("/collection-calendars", { method: "POST", body: body(2034) }), 403)
      assert.match(problem.detail ?? "", /create on configure\.calendars/)
    })
  })

  describe("GET /collection-calendars", () => {
    test("answers the company's calendars in id order with their holidays, and holds nothing of another company's", async () => {
      const mine = await calendar(2035, { holidays: [{ day: "2035-06-05", name: "Grundlovsdag" }] })
      const { items } = await page(olivia, "?limit=200")
      const ids = items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.deepEqual(items.find((row) => row.id === mine.id), mine, "a row in the list carries its holidays, like the row on its own")
      assert.ok(!ids.includes(theirCalendar.id))
      assert.deepEqual((await page(other, "?limit=200")).items, [theirCalendar])
    })

    test("filters by project and by the day the period covers: one calendar of a project on a day, none in a gap", async () => {
      const first = await calendar(2036)
      const second = await calendar(2038)
      const harbor = await calendar(2036, { projectId: a.projects.harbor.id, name: "Harbor 2036" })

      const byProject = await page(olivia, `?limit=200&projectId=${a.projects.harbor.id}`)
      assert.ok(byProject.items.some((row) => row.id === harbor.id))
      for (const row of byProject.items) assert.equal(row.projectId, a.projects.harbor.id)

      assert.deepEqual((await page(olivia, `?limit=200&validOn=2036-03-01&projectId=${a.projects.copenhagen.id}`)).items.map((row) => row.id), [first.id])
      assert.deepEqual((await page(olivia, `?limit=200&validOn=2038-12-31&projectId=${a.projects.copenhagen.id}`)).items.map((row) => row.id), [second.id])
      assert.deepEqual((await page(olivia, `?limit=200&validOn=2037-06-01&projectId=${a.projects.copenhagen.id}`)).items, [], "no calendar covers the gap between them")
      assert.deepEqual((await page(olivia, `?limit=200&validOn=2037-01-01&projectId=${a.projects.copenhagen.id}`)).items, [], "validTo is the first day out of force")
      const onTheDay = (await page(olivia, "?limit=200&validOn=2036-03-01")).items.map((row) => row.id).sort()
      assert.deepEqual(onTheDay, [first.id, harbor.id].sort(), "one per project")
      assert.deepEqual((await refused(await olivia("/collection-calendars?validOn=2036-02-30"), 400)).errors?.map((error) => error.path), ["validOn"])
    })

    test("shows an account only the projects it works in, and answers an empty page to one that works in none", async () => {
      const here = await calendar(2039)
      const elsewhere = await calendar(2039, { projectId: a.projects.harbor.id, name: "Harbor 2039" })
      const seen = (await page(viewer, "?limit=200")).items
      assert.ok(seen.some((row) => row.id === here.id))
      assert.ok(!seen.some((row) => row.id === elsewhere.id))
      for (const row of seen) assert.equal(row.projectId, a.projects.copenhagen.id)

      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null }, "a service provider's account works in no project and reads none of this")
      const problem = await refused(await viewer(`/collection-calendars?projectId=${a.projects.harbor.id}`), 400)
      assert.deepEqual(problem.errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("refuses a role without configure.calendars view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/collection-calendars"), 403)).detail ?? "", /view on configure\.calendars/)
      assert.equal((await app.request("/collection-calendars")).status, 401)
    })
  })

  describe("GET /collection-calendars/:id", () => {
    test("answers 404 for another company's, for one in a project the caller does not work in, and for an id nobody minted", async () => {
      const foreign = await refused(await olivia(`/collection-calendars/${theirCalendar.id}`), 404)
      assert.match(foreign.detail ?? "", /collection calendar/i)
      assert.deepEqual(await one(other, theirCalendar.id), theirCalendar, "still there for its own company")

      const elsewhere = await calendar(2041, { projectId: a.projects.harbor.id, name: "Harbor 2041" })
      await refused(await viewer(`/collection-calendars/${elsewhere.id}`), 404)
      await refused(await lars(`/collection-calendars/${elsewhere.id}`), 404)
      assert.equal((await one(olivia, elsewhere.id)).name, "Harbor 2041")
      await refused(await olivia(`/collection-calendars/${testId()}`), 404)
      assert.deepEqual((await refused(await olivia("/collection-calendars/not-a-uuid"), 400)).errors?.map((error) => error.path), ["id"])
    })
  })

  describe("PATCH /collection-calendars/:id", () => {
    test("changes what the body names, leaves the holidays, and moves the stamp", async () => {
      const created = await calendar(2042, { holidays: [{ day: "2042-06-05", name: "Grundlovsdag" }] })
      const changed = await patch(olivia, created.id, { name: "Copenhagen Central 2042 (revised)", validTo: "2042-12-01" })
      assert.equal(changed.name, "Copenhagen Central 2042 (revised)")
      assert.deepEqual([changed.validFrom, changed.validTo], ["2042-01-01", "2042-12-01"])
      assert.deepEqual(changed.holidays, created.holidays, "a patch is not how a set changes")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)
      const reopened = await patch(olivia, created.id, { validTo: null })
      assert.equal(reopened.validTo, null, "a null takes the end off again")
      assert.equal((await patch(olivia, created.id, { validTo: "2043-01-01" })).validTo, "2043-01-01")
    })

    test("refuses an end before the stored start, which the body alone cannot see", async () => {
      const created = await calendar(2044, { validFrom: "2044-07-01" })
      const problem = await refused(await olivia(`/collection-calendars/${created.id}`, { method: "PATCH", body: { validTo: "2044-04-01" } }), 400)
      assert.deepEqual(problem.errors?.map((error) => error.path), ["validTo"])
      assert.match(problem.errors?.[0].message ?? "", /comes after validFrom/)
      assert.equal((await one(olivia, created.id)).validTo, "2045-01-01")
    })

    test("refuses a shortening that would leave a holiday outside, counting it, and writes nothing", async () => {
      const created = await calendar(2046, { holidays: [{ day: "2046-12-25", name: "Christmas Day" }] })
      const shortened = await refused(await olivia(`/collection-calendars/${created.id}`, { method: "PATCH", body: { validTo: "2046-12-01" } }), 409)
      assert.equal(shortened.detail, "1 holiday falls outside the new period; remove it first")
      const moved = await refused(await olivia(`/collection-calendars/${created.id}`, { method: "PATCH", body: { validFrom: "2046-12-26" } }), 409)
      assert.equal(moved.detail, "1 holiday falls outside the new period; remove it first")
      const stored = await one(olivia, created.id)
      assert.deepEqual([stored.validFrom, stored.validTo], ["2046-01-01", "2047-01-01"])
      assert.equal(stored.updatedAt, created.updatedAt, "a refused patch does not move the stamp")

      await put(olivia, created.id, [])
      const ended = await patch(olivia, created.id, { validTo: "2046-12-01" })
      assert.equal(ended.validTo, "2046-12-01", "an end the holidays now fit inside is taken")
      const onTheLastDay = await patch(olivia, created.id, { validTo: "2047-01-01" })
      const boundary = await put(olivia, created.id, [{ day: "2046-12-31", name: "New Year's Eve" }])
      assert.equal(boundary.holidays.length, 1, "the last day of the period is inside it")
      assert.ok(onTheLastDay.updatedAt < boundary.updatedAt)
    })

    test("counts the holidays in the way, and the sentence reads as a plural once there is more than one", async () => {
      const created = await calendar(2048, {
        holidays: [
          { day: "2048-06-05", name: "Grundlovsdag" },
          { day: "2048-12-24", name: "Christmas Eve" },
          { day: "2048-12-25", name: "Christmas Day" },
        ],
      })
      const problem = await refused(await olivia(`/collection-calendars/${created.id}`, { method: "PATCH", body: { validTo: "2048-12-25" } }), 409)
      assert.equal(problem.detail, "1 holiday falls outside the new period; remove it first")
      const two = await refused(await olivia(`/collection-calendars/${created.id}`, { method: "PATCH", body: { validTo: "2048-12-01" } }), 409)
      assert.equal(two.detail, "2 holidays fall outside the new period; remove them first")
    })

    test("refuses a period that overlaps the project's other calendar, and a rename onto a name the project uses", async () => {
      await calendar(2050)
      const later = await calendar(2051)
      const overlap = await refused(await olivia(`/collection-calendars/${later.id}`, { method: "PATCH", body: { validFrom: "2050-07-01" } }), 409)
      assert.equal(overlap.detail, CALENDAR_RUNNING)
      const name = await refused(await olivia(`/collection-calendars/${later.id}`, { method: "PATCH", body: { name: "Copenhagen Central 2050" } }), 409)
      assert.equal(name.detail, 'This project already has a collection calendar called "Copenhagen Central 2050"')
      assert.deepEqual([(await one(olivia, later.id)).validFrom, (await one(olivia, later.id)).name], ["2051-01-01", "Copenhagen Central 2051"])
    })

    test("refuses another company's calendar, one out of the caller's projects, an empty patch, and a role that may view but not edit", async () => {
      await refused(await olivia(`/collection-calendars/${theirCalendar.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirCalendar.id)).name, "Their 2026")
      const elsewhere = await calendar(2052, { projectId: a.projects.harbor.id, name: "Harbor 2052" })
      await refused(await viewer(`/collection-calendars/${elsewhere.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.deepEqual((await refused(await olivia(`/collection-calendars/${elsewhere.id}`, { method: "PATCH", body: {} }), 400)).errors?.map((error) => error.path), [""])
      const owned = await refused(await olivia(`/collection-calendars/${elsewhere.id}`, { method: "PATCH", body: { holidays: [] } }), 400)
      assert.ok(owned.errors?.some((error) => /holidays/.test(error.message)), "the holidays are a set, and a set is not a field of the patch")
      assert.match((await refused(await lars(`/collection-calendars/${elsewhere.id}`, { method: "PATCH", body: { name: "x" } }), 403)).detail ?? "", /edit on configure\.calendars/)
    })
  })

  describe("PUT /collection-calendars/:id/holidays", () => {
    test("replaces the whole list, answers it by day, and moves the calendar's stamp", async () => {
      const created = await calendar(2054, { holidays: [{ day: "2054-06-05", name: "Grundlovsdag" }] })
      const replaced = await put(olivia, created.id, [
        { day: "2054-12-25", name: "Christmas Day" },
        { day: "2054-01-01", name: "New Year's Day" },
        { day: "2054-04-06", name: null },
      ])
      assert.deepEqual(replaced.holidays, [
        { day: "2054-01-01", name: "New Year's Day" },
        { day: "2054-04-06", name: null },
        { day: "2054-12-25", name: "Christmas Day" },
      ])
      assert.ok(replaced.updatedAt > created.updatedAt, "the set is part of the calendar on the wire")
      assert.deepEqual(await one(olivia, created.id), replaced)
      const emptied = await put(olivia, created.id, [])
      assert.deepEqual(emptied.holidays, [], "an empty list is a year without holidays")
      assert.ok(emptied.updatedAt > replaced.updatedAt)
    })

    test("refuses a day outside the calendar's period by entry, and leaves the calendar as it was, stamp included", async () => {
      const created = await calendar(2056, { holidays: [{ day: "2056-06-05", name: "Grundlovsdag" }] })
      const problem = await refused(
        await olivia(`/collection-calendars/${created.id}/holidays`, {
          method: "PUT",
          body: { holidays: [{ day: "2056-12-25", name: "Christmas Day" }, { day: "2057-01-01", name: "New Year's Day" }, { day: "2055-12-31", name: null }] },
        }),
        400,
      )
      assert.deepEqual(problem.errors, [
        { path: "holidays.1.day", message: OUTSIDE },
        { path: "holidays.2.day", message: OUTSIDE },
      ])
      assert.deepEqual(await one(olivia, created.id), created, "a body with one bad entry leaves the record exactly as it was")
    })

    test("refuses the same day twice, a missing list and a member the body does not own, at the schema", async () => {
      const created = await calendar(2058)
      const twice = await refused(
        await olivia(`/collection-calendars/${created.id}/holidays`, { method: "PUT", body: { holidays: [{ day: "2058-12-25", name: "a" }, { day: "2058-12-25", name: "b" }] } }),
        400,
      )
      assert.deepEqual(twice.errors, [{ path: "holidays", message: ONE_HOLIDAY_PER_DAY }])
      assert.deepEqual((await refused(await olivia(`/collection-calendars/${created.id}/holidays`, { method: "PUT", body: {} }), 400)).errors?.map((error) => error.path), ["holidays"])
      const owned = await refused(await olivia(`/collection-calendars/${created.id}/holidays`, { method: "PUT", body: { holidays: [], name: "x" } }), 400)
      assert.ok(owned.errors?.some((error) => /name/.test(error.message)), JSON.stringify(owned.errors))
      assert.deepEqual((await one(olivia, created.id)).holidays, [])
    })

    test("answers 404 for another company's calendar and for one out of the caller's projects, and 403 for a role that may view but not edit", async () => {
      await refused(await olivia(`/collection-calendars/${theirCalendar.id}/holidays`, { method: "PUT", body: { holidays: [] } }), 404)
      assert.deepEqual((await one(other, theirCalendar.id)).holidays, theirCalendar.holidays, "and it still has its holidays")
      const elsewhere = await calendar(2060, { projectId: a.projects.harbor.id, name: "Harbor 2060" })
      await refused(await viewer(`/collection-calendars/${elsewhere.id}/holidays`, { method: "PUT", body: { holidays: [] } }), 404)
      await refused(await olivia(`/collection-calendars/${testId()}/holidays`, { method: "PUT", body: { holidays: [] } }), 404)
      assert.match((await refused(await lars(`/collection-calendars/${elsewhere.id}/holidays`, { method: "PUT", body: { holidays: [] } }), 403)).detail ?? "", /edit on configure\.calendars/)
    })
  })
})
