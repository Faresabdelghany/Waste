import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { DropOffPoint } from "@waste/contracts/drop-off-points"
import type { Point } from "@waste/contracts/geojson"
import { Page } from "@waste/contracts/pagination"
import { PublicDropOffPoints } from "@waste/contracts/public"
import { createDb, type Database } from "@waste/db/client"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { collectionCalendar, collectionCalendarHoliday } from "@waste/db/schema/collection-calendars"
import { project } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { eq } from "drizzle-orm"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { nextMillisecond } from "./clock"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const DropOffPointPage = Page(DropOffPoint)
const MODULE = "resources.drop-off-points"

/** Monday 21 December 2026, morning in Copenhagen: the public map's week runs to Sunday the 27th, Christmas Day the Friday. */
const NOW = new Date("2026-12-21T08:00:00.000Z")
const amager: Point = { type: "Point", coordinates: [12.6105, 55.6521] }

describe("the drop-off point endpoints and the public map", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only. */
  let viewer: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call
  let slug: string
  const ids = { glass: testId(), batteries: testId(), theirs: testId(), calendar: testId() }

  before(async () => {
    pool = createDb(database.url!, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
    slug = `drop-off-${testId().replaceAll("-", "").slice(-12)}`
    const copenhagen = a.projects.copenhagen.id
    await withCompany(pool.db, a.companyId, async (tx) => {
      await tx.insert(wasteFraction).values([
        { id: ids.glass, companyId: a.companyId, key: "glass", name: "Glas" },
        { id: ids.batteries, companyId: a.companyId, key: "batteries", name: "Batterier" },
      ])
      await tx.update(project).set({ publicSlug: slug, holidayList: "Danish public holidays" }).where(eq(project.id, copenhagen))
      await tx.insert(collectionCalendar).values({ id: ids.calendar, companyId: a.companyId, projectId: copenhagen, validFrom: "2026-01-01", name: `Holidays ${testId().slice(-6)}` })
      await tx.insert(collectionCalendarHoliday).values({ companyId: a.companyId, projectId: copenhagen, collectionCalendarId: ids.calendar, day: "2026-12-25", name: "Juledag" })
    })
    await withCompany(pool.db, b.companyId, async (tx) => {
      await tx.insert(wasteFraction).values({ id: ids.theirs, companyId: b.companyId, key: "glass", name: "Glass" })
    })
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const body = (projectId: string, code: string, values: Record<string, unknown> = {}) => ({
    projectId,
    code,
    name: `Genbrugsstation ${code}`,
    kind: "recycling-centre",
    address: `${code}, Kraftværksvej 31, 2300 København S`,
    location: amager,
    ...values,
  })
  const create = async (call: Call, values: unknown): Promise<DropOffPoint> => created(call, "/drop-off-points", await call("/drop-off-points", { method: "POST", body: values }), DropOffPoint)
  const point = (code: string, values: Record<string, unknown> = {}) => create(olivia, body(a.projects.copenhagen.id, code, values))
  const one = async (call: Call, id: string): Promise<DropOffPoint> => {
    const response = await call(`/drop-off-points/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return DropOffPoint.parse(await response.json())
  }
  const put = async (id: string, set: string, value: unknown, call: Call = olivia) => call(`/drop-off-points/${id}/${set}`, { method: "PUT", body: value })
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return readProblem(response)
  }

  describe("the office's routes", () => {
    test("a new point is a draft with the sets it starts with, answered as the next read gives them", async () => {
      const made = await point(`GS-${testId().slice(-4)}`, {
        wasteFractionIds: [ids.glass, ids.batteries],
        hours: [
          { weekday: "saturday", opensAt: "13:00", closesAt: "17:00" },
          { weekday: "monday", opensAt: "10:00", closesAt: "18:00" },
          { weekday: "saturday", opensAt: "08:00", closesAt: "11:00" },
        ],
        exceptions: [{ date: "2026-12-24", opensAt: "09:00", closesAt: "12:00", note: "Juleaften" }],
      })
      assert.equal(made.status, "draft")
      assert.deepEqual([made.openAlways, made.closedOnHolidays], [false, false])
      assert.deepEqual(made.wasteFractionIds, [ids.glass, ids.batteries].sort())
      assert.deepEqual(
        made.hours.map((window) => `${window.weekday} ${window.opensAt}`),
        ["monday 10:00", "saturday 08:00", "saturday 13:00"],
      )
      assert.deepEqual(await one(olivia, made.id), made)
    })

    test("the code and the name are each one point's inside a project, and free in the next", async () => {
      const code = `GS-${testId().slice(-4)}`
      await point(code)
      const again = await refused(await olivia("/drop-off-points", { method: "POST", body: body(a.projects.copenhagen.id, code, { name: "Another" }) }), 409)
      assert.match(again.detail ?? "", /already has a drop-off point coded/)
      await create(olivia, body(a.projects.harbor.id, code))
    })

    test("a fraction of another company, a point off the globe and hours the rules refuse are 400s at their fields", async () => {
      const theirs = await refused(await olivia("/drop-off-points", { method: "POST", body: body(a.projects.copenhagen.id, "GS-X1", { wasteFractionIds: [ids.theirs] }) }), 400)
      assert.deepEqual(theirs.errors?.map((error) => error.path), ["wasteFractionIds.0"])
      const off = await refused(await olivia("/drop-off-points", { method: "POST", body: body(a.projects.copenhagen.id, "GS-X2", { location: { type: "Point", coordinates: [200, 95] } }) }), 400)
      assert.deepEqual(off.errors?.map((error) => error.path), ["location.coordinates.0", "location.coordinates.1"])
      const made = await point(`GS-${testId().slice(-4)}`)
      const overlap = await refused(
        await put(made.id, "hours", {
          hours: [
            { weekday: "saturday", opensAt: "08:00", closesAt: "12:00" },
            { weekday: "saturday", opensAt: "11:00", closesAt: "14:00" },
          ],
        }),
        400,
      )
      assert.deepEqual(overlap.errors, [{ path: "hours", message: "Saturday: 08:00–12:00 and 11:00–14:00 overlap" }])
    })

    test("each set is replaced whole through its own route, the point's stamp moving with it", async () => {
      const made = await point(`GS-${testId().slice(-4)}`, { wasteFractionIds: [ids.glass] })
      await nextMillisecond()
      const fractions = DropOffPoint.parse(await (await put(made.id, "fractions", { wasteFractionIds: [ids.batteries] })).json())
      assert.deepEqual(fractions.wasteFractionIds, [ids.batteries])
      assert.ok(fractions.updatedAt > made.updatedAt)
      const hours = DropOffPoint.parse(await (await put(made.id, "hours", { hours: [{ weekday: "tuesday", opensAt: "12:00", closesAt: "18:00" }] })).json())
      assert.deepEqual(hours.hours, [{ weekday: "tuesday", opensAt: "12:00", closesAt: "18:00" }])
      const exceptions = DropOffPoint.parse(
        await (
          await put(made.id, "exceptions", {
            exceptions: [
              { date: "2026-12-31", opensAt: "09:00", closesAt: "13:00", note: null },
              { date: "2026-12-24", opensAt: null, closesAt: null, note: "Juleaften" },
            ],
          })
        ).json(),
      )
      assert.deepEqual(
        exceptions.exceptions.map((exception) => exception.date),
        ["2026-12-24", "2026-12-31"],
      )
      assert.deepEqual(await one(olivia, made.id), exceptions)
      const cleared = DropOffPoint.parse(await (await put(made.id, "hours", { hours: [] })).json())
      assert.deepEqual([cleared.hours, cleared.wasteFractionIds], [[], [ids.batteries]], "a set's PUT touches that set alone")
    })

    test("a patch changes what it names, never the project, the code or a set", async () => {
      // In the unpublished project, so the point it makes active stays off the public map below.
      const made = await create(olivia, body(a.projects.harbor.id, `GS-${testId().slice(-4)}`))
      const active = await olivia(`/drop-off-points/${made.id}`, { method: "PATCH", body: { status: "active", publicNote: "Husk ID." } })
      assert.equal(active.status, 200)
      assert.deepEqual(
        (({ status, publicNote }) => ({ status, publicNote }))(DropOffPoint.parse(await active.json())),
        { status: "active", publicNote: "Husk ID." },
      )
      await refused(await olivia(`/drop-off-points/${made.id}`, { method: "PATCH", body: { code: "GS-NEW" } }), 400)
      await refused(await olivia(`/drop-off-points/${made.id}`, { method: "PATCH", body: { hours: [] } }), 400)
    })

    test("the project fence: a point outside the caller's projects is a 404, a project outside them a 400, another company's nothing", async () => {
      const harbor = await create(olivia, body(a.projects.harbor.id, `GS-${testId().slice(-4)}`))
      await refused(await viewer(`/drop-off-points/${harbor.id}`), 404)
      await refused(await put(harbor.id, "hours", { hours: [] }, viewer), 404)
      const named = await refused(await viewer("/drop-off-points", { method: "POST", body: body(a.projects.harbor.id, "GS-V1") }), 400)
      assert.deepEqual(named.errors?.map((error) => error.path), ["projectId"])
      await refused(await other(`/drop-off-points/${harbor.id}`), 404)
      const page = DropOffPointPage.parse(await (await viewer(`/drop-off-points?projectId=${a.projects.copenhagen.id}&limit=200`)).json())
      assert.ok(page.items.every((item) => item.projectId === a.projects.copenhagen.id))
    })

    test("a role without the grant is refused, each action its own", async () => {
      await refused(await ungranted("/drop-off-points"), 403)
      await refused(await ungranted("/drop-off-points", { method: "POST", body: body(b.projects.copenhagen.id, "GS-U1") }), 403)
    })

    test("the list narrows by status and kind, with each point's sets", async () => {
      const bank = await point(`BB-${testId().slice(-4)}`, { kind: "bring-bank", openAlways: true, wasteFractionIds: [ids.glass] })
      const page = DropOffPointPage.parse(await (await olivia(`/drop-off-points?projectId=${a.projects.copenhagen.id}&kind=bring-bank&limit=200`)).json())
      assert.deepEqual(
        page.items.map((item) => [item.id, item.kind, item.wasteFractionIds]),
        [[bank.id, "bring-bank", [ids.glass]]],
      )
    })
  })

  describe("GET /public/:slug/drop-off-points", () => {
    let centre: DropOffPoint
    let bank: DropOffPoint

    before(async () => {
      centre = await point(`GS-PUB-${testId().slice(-4)}`, {
        name: "A Genbrugsstation Amager",
        status: "active",
        closedOnHolidays: true,
        publicNote: "Husk ID.",
        notes: "The office's own",
        wasteFractionIds: [ids.batteries, ids.glass],
        hours: [
          { weekday: "monday", opensAt: "10:00", closesAt: "18:00" },
          { weekday: "friday", opensAt: "10:00", closesAt: "18:00" },
        ],
        exceptions: [{ date: "2026-12-24", opensAt: "09:00", closesAt: "12:00", note: "Juleaften" }],
      })
      bank = await point(`BB-PUB-${testId().slice(-4)}`, { name: "B Glascontainer Holmbladsgade", kind: "bring-bank", status: "active", openAlways: true, wasteFractionIds: [ids.glass] })
      await point(`GS-DRAFT-${testId().slice(-4)}`, { name: "C Draft", wasteFractionIds: [ids.glass] })
      await create(olivia, body(a.projects.harbor.id, `GS-HARBOR-${testId().slice(-4)}`, { status: "active", wasteFractionIds: [ids.glass] }))
    })

    const map = async (query = "") => {
      const response = await app.request(`/public/${slug}/drop-off-points${query}`)
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      assert.equal(response.headers.get("cache-control"), "public, max-age=60")
      return PublicDropOffPoints.parse(await response.json())
    }

    test("the project's active points by name, each with its week: exceptions and the project's holidays applied, never a code or the office's notes", async () => {
      const found = await map()
      assert.equal(found.from, "2026-12-21")
      assert.deepEqual(found.fraction, null)
      assert.equal(found.truncated, false, "a project's points, all of them, under the map's bound")
      assert.deepEqual(
        found.points.map((entry) => entry.id),
        [centre.id, bank.id],
        "not the draft, not the unpublished project's",
      )
      const [first, second] = found.points
      assert.deepEqual(first?.fractions, ["Batterier", "Glas"])
      assert.equal(first?.publicNote, "Husk ID.")
      assert.deepEqual(
        first?.week.map((day) => [day.date, day.windows.map((window) => `${window.opensAt}–${window.closesAt}`).join(" "), day.note]),
        [
          ["2026-12-21", "10:00–18:00", null],
          ["2026-12-22", "", null],
          ["2026-12-23", "", null],
          ["2026-12-24", "09:00–12:00", "Juleaften"],
          ["2026-12-25", "", "Juledag"],
          ["2026-12-26", "", null],
          ["2026-12-27", "", null],
        ],
      )
      assert.ok(second?.week.every((day) => day.allDay), "open always, holidays included, since it does not close on them")
      const raw = (await (await app.request(`/public/${slug}/drop-off-points`)).json()) as { points: Record<string, unknown>[] }
      assert.ok(raw.points.every((entry) => !("code" in entry) && !("notes" in entry) && !("status" in entry)), "no code, no office notes, no status")
      assert.ok(!JSON.stringify(raw).includes("The office's own"))
    })

    test("by the guide's fraction key: the points taking it, named; an unknown key finds none", async () => {
      const batteries = await map("?fraction=batteries")
      assert.deepEqual(batteries.fraction, { key: "batteries", name: "Batterier" })
      assert.deepEqual(
        batteries.points.map((entry) => entry.id),
        [centre.id],
      )
      const nothing = await map("?fraction=textiles")
      assert.deepEqual([nothing.fraction, nothing.points], [null, []])
      const malformed = await app.request(`/public/${slug}/drop-off-points?fraction=Glass%20jars`)
      assert.equal(malformed.status, 400)
    })

    test("an unpublished slug is a 404", async () => {
      assert.equal((await app.request("/public/no-such-door/drop-off-points")).status, 404)
    })
  })
})
