// A Route Scheme's Seasons through the API (O17 of #290): written with the
// scheme, replaced whole by a patch, read back by the day they start, refused
// where they overlap or a daily scheme would carry them, and applied by the
// occurrence read, the same `generateOccurrences` the generation job calls.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import { Page } from "@waste/contracts/pagination"
import { Occurrence, RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database } from "@waste/db/client"
import { routeSchemeSeason } from "@waste/db/schema/route-schemes"
import { isoWeek } from "@waste/domain/route-schemes/recurrence"
import { eq } from "drizzle-orm"
import * as z from "zod"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const Occurrences = z.array(Occurrence)

const SUMMER = { name: "Summer", startsOn: "05-01", endsOn: "10-01", frequency: "weekly", weekRotation: null }
const WINTER = { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks", weekRotation: "odd" }

describe("a route scheme's seasons", { skip: database.skip }, () => {
  let pool: Database
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let other: Call
  let residual: WasteFraction

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    residual = await created(olivia, "/waste-fractions", await olivia("/waste-fractions", { method: "POST", body: { key: "garden", name: "Garden waste" } }), WasteFraction)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  /** A draft garden-waste scheme on Mondays, even weeks all year but where its seasons say otherwise. */
  const body = (name: string, values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    name,
    serviceType: "container-collection",
    frequency: "every-2-weeks",
    weekRotation: "even",
    serviceDays: ["monday"],
    validFrom: "2026-01-01",
    collectionGroups: [{ name: "Garden", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [residual.id], containerTypeIds: [], vehicleTypeId: null } }],
    ...values,
  })
  const post = (values: unknown) => olivia("/route-schemes", { method: "POST", body: values })
  const scheme = async (name: string, values: Record<string, unknown> = {}) => created(olivia, "/route-schemes", await post(body(name, values)), RouteScheme)
  const patch = (id: string, values: unknown) => olivia(`/route-schemes/${id}`, { method: "PATCH", body: values })
  const ok = async (response: Response): Promise<RouteScheme> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return RouteScheme.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const occurrences = async (id: string, from: string, to: string) => {
    const response = await olivia(`/route-schemes/${id}/occurrences?from=${from}&to=${to}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Occurrences.parse(await response.json())
  }

  test("a create writes them, and every read answers them by the day they start", async () => {
    const written = await scheme("Garden with seasons", { seasons: [WINTER, SUMMER] })
    assert.deepEqual(written.seasons, [SUMMER, WINTER])
    const read = await ok(await olivia(`/route-schemes/${written.id}`))
    assert.deepEqual(read.seasons, [SUMMER, WINTER])
    const page = Page(RouteScheme).parse(await (await olivia(`/route-schemes?projectId=${a.projects.copenhagen.id}`)).json())
    assert.deepEqual(page.items.find((item) => item.id === written.id)?.seasons, [SUMMER, WINTER])
    assert.deepEqual((await scheme("Garden without")).seasons, [], "none when absent")
  })

  test("the occurrence read runs each season at its cadence and names it on the row", async () => {
    const written = await scheme("Garden by season", { seasons: [SUMMER, WINTER] })
    const rows = await occurrences(written.id, "2026-01-01", "2026-12-31")
    const july = rows.filter((row) => row.date.startsWith("2026-07"))
    assert.deepEqual(july.map((row) => row.date), ["2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27"], "every Monday in summer")
    assert.ok(july.every((row) => row.season === "Summer"))
    const december = rows.filter((row) => row.date.startsWith("2026-12"))
    assert.ok(december.length > 0 && december.every((row) => row.season === "Winter" && isoWeek(row.date) % 2 === 1), "odd weeks in winter")
    const october = rows.filter((row) => row.date.startsWith("2026-10"))
    assert.ok(october.length > 0 && october.every((row) => row.season === undefined && isoWeek(row.date) % 2 === 0), "the scheme's even weeks between")
  })

  test("a patch replaces the set whole, an empty one clears it, and leaving it out keeps it", async () => {
    const written = await scheme("Garden replaced", { seasons: [SUMMER] })
    assert.deepEqual((await ok(await patch(written.id, { seasons: [WINTER] }))).seasons, [WINTER])
    assert.deepEqual((await ok(await patch(written.id, { name: "Garden renamed" }))).seasons, [WINTER], "a patch without seasons leaves them")
    const [before] = await pool.db.select({ id: routeSchemeSeason.id }).from(routeSchemeSeason).where(eq(routeSchemeSeason.routeSchemeId, written.id))
    assert.deepEqual((await ok(await patch(written.id, { seasons: [WINTER] }))).seasons, [WINTER])
    const [after] = await pool.db.select({ id: routeSchemeSeason.id }).from(routeSchemeSeason).where(eq(routeSchemeSeason.routeSchemeId, written.id))
    assert.equal(after?.id, before?.id, "the set restated as it stands is not written again")
    assert.deepEqual((await ok(await patch(written.id, { seasons: [] }))).seasons, [])
    assert.deepEqual((await ok(await olivia(`/route-schemes/${written.id}`))).seasons, [])
    const rows = await occurrences(written.id, "2026-07-01", "2026-07-31")
    assert.ok(rows.every((row) => row.season === undefined && isoWeek(row.date) % 2 === 0))
  })

  test("seasons that overlap, share a name or name 29 February are refused at the field", async () => {
    const overlap = await refused(await post(body("Garden overlap", { seasons: [SUMMER, { ...WINTER, startsOn: "09-15" }] })), 400)
    assert.deepEqual(overlap.errors?.map((error) => error.path), ["seasons.1"])
    const leap = await refused(await post(body("Garden leap", { seasons: [{ ...SUMMER, startsOn: "02-29" }] })), 400)
    assert.deepEqual(leap.errors?.map((error) => error.path), ["seasons.0.startsOn"])
    const daily = await refused(await post(body("Garden daily", { frequency: "daily", weekRotation: null, serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], seasons: [SUMMER] })), 400)
    assert.deepEqual(daily.errors?.map((error) => error.path), ["seasons"])
  })

  test("a patch turning a scheme with seasons daily is refused against the stored seasons, and nothing is written", async () => {
    const written = await scheme("Garden kept", { seasons: [SUMMER] })
    const problem = await refused(await patch(written.id, { frequency: "daily", weekRotation: null, serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] }), 400)
    assert.deepEqual(problem.errors?.map((error) => error.path), ["seasons"])
    const read = await ok(await olivia(`/route-schemes/${written.id}`))
    assert.equal(read.frequency, "every-2-weeks")
    assert.deepEqual(read.seasons, [SUMMER])
    // Turning daily and clearing the seasons in one patch is taken.
    const daily = await ok(await patch(written.id, { frequency: "daily", weekRotation: null, serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], seasons: [] }))
    assert.equal(daily.frequency, "daily")
    assert.deepEqual(daily.seasons, [])
  })

  test("another company's scheme has no seasons to read or replace here", async () => {
    const written = await scheme("Garden fenced", { seasons: [SUMMER] })
    await refused(await other(`/route-schemes/${written.id}`, { method: "PATCH", body: { seasons: [] } }), 404)
    assert.deepEqual((await ok(await olivia(`/route-schemes/${written.id}`))).seasons, [SUMMER])
  })
})
