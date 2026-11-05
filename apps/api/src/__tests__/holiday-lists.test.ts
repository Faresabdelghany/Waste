import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { HolidayList } from "@waste/contracts/holiday-lists"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { NO_SUCH_HOLIDAY_LIST } from "../routes/holiday-lists"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const ListPage = Page(HolidayList)

describe("the holiday list endpoints (Settings › Holiday lists, 2026-11-05)", { skip: database.skip }, () => {
  let pool: Database
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let other: Call
  /** A role without `configure.calendars`: the 403s. */
  let ungranted: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const post = (call: Call, body: unknown) => call("/holiday-lists", { method: "POST", body })
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return readProblem(response)
  }
  const listed = async (call: Call) => ListPage.parse(await (await call("/holiday-lists")).json()).items

  test("adds a list by country and name with the days it starts with, by day; a country or a name taken is a 409 naming it", async () => {
    const norway = await created(
      olivia,
      "/holiday-lists",
      await post(olivia, { country: "NO", name: "Norwegian public holidays", holidays: [{ day: "2026-05-17", name: "Grunnlovsdag" }, { day: "2026-01-01", name: null }] }),
      HolidayList,
    )
    assert.deepEqual([norway.country, norway.name, norway.projectCount], ["NO", "Norwegian public holidays", 0])
    assert.deepEqual(norway.holidays, [{ day: "2026-01-01", name: null }, { day: "2026-05-17", name: "Grunnlovsdag" }], "read back by day")
    assert.deepEqual(HolidayList.parse(await (await olivia(`/holiday-lists/${norway.id}`)).json()), norway)
    assert.equal((await refused(await post(olivia, { country: "NO", name: "Norway again" }), 409)).detail, "This company already has a holiday list for NO")
    assert.equal((await refused(await post(olivia, { country: "SE", name: "Norwegian public holidays" }), 409)).detail, 'This company already has a holiday list called "Norwegian public holidays"')
    await refused(await post(olivia, { country: "no", name: "Lowercase" }), 400)
    await refused(await post(olivia, { country: "FI", name: "Twice", holidays: [{ day: "2026-12-06", name: null }, { day: "2026-12-06", name: "Itsenäisyyspäivä" }] }), 400)
    const theirs = await created(other, "/holiday-lists", await post(other, { country: "NO", name: "Norwegian public holidays" }), HolidayList)
    assert.notEqual(theirs.id, norway.id, "a country is one list's inside a company, and free in the next")
  })

  test("lists the company's lists with the projects resting on each; the seeded Danish list counts none until a project names it", async () => {
    const lists = await listed(olivia)
    const danish = lists.find((list) => list.name === "Danish public holidays")
    assert.ok(danish, "the tenant's Danish list")
    assert.equal(danish.projectCount, 0)
    const patched = await olivia(`/projects/${a.projects.copenhagen.id}`, { method: "PATCH", body: { holidayList: "Danish public holidays" } })
    assert.equal(patched.status, 200)
    assert.equal((await listed(olivia)).find((list) => list.id === danish.id)?.projectCount, 1)
  })

  test("replaces a list's days whole, and a rename follows to every project resting on it", async () => {
    const [danish] = (await listed(olivia)).filter((list) => list.name === "Danish public holidays")
    const put = await olivia(`/holiday-lists/${danish.id}/holidays`, { method: "PUT", body: { holidays: [{ day: "2026-12-25", name: "Juledag" }, { day: "2026-06-05", name: "Grundlovsdag" }] } })
    assert.equal(put.status, 200)
    assert.deepEqual(HolidayList.parse(await put.json()).holidays, [{ day: "2026-06-05", name: "Grundlovsdag" }, { day: "2026-12-25", name: "Juledag" }])
    const renamed = await olivia(`/holiday-lists/${danish.id}`, { method: "PATCH", body: { name: "Danske helligdage" } })
    assert.equal(HolidayList.parse(await renamed.json()).name, "Danske helligdage")
    const project = (await (await olivia(`/projects/${a.projects.copenhagen.id}`)).json()) as { holidayList: string | null }
    assert.equal(project.holidayList, "Danske helligdage")
    await refused(await olivia(`/holiday-lists/${danish.id}`, { method: "PATCH", body: {} }), 400)
  })

  test("a project names a list the company holds, or none: any other name is a 400 at holidayList, on a create and on a patch", async () => {
    const patch = await refused(await olivia(`/projects/${a.projects.cairo.id}`, { method: "PATCH", body: { holidayList: "Atlantis public holidays" } }), 400)
    assert.deepEqual(patch.errors?.map((error) => [error.path, error.message]), [["holidayList", NO_SUCH_HOLIDAY_LIST]])
    const create = await refused(
      await olivia("/projects", { method: "POST", body: { name: `Giza ${testId().slice(-6)}`, kind: "Municipality", language: "ar", currency: "EGP", timezone: "Africa/Cairo", status: "active", holidayList: "Atlantis public holidays" } }),
      400,
    )
    assert.deepEqual(create.errors?.map((error) => error.path), ["holidayList"])
    await refused(await olivia(`/projects/${testId()}`, { method: "PATCH", body: { holidayList: "Atlantis public holidays" } }), 404)
  })

  test("deletes a list no project rests on, with its days; one a project names is a 409", async () => {
    const [danish] = (await listed(olivia)).filter((list) => list.name === "Danske helligdage")
    assert.match((await refused(await olivia(`/holiday-lists/${danish.id}`, { method: "DELETE" }), 409)).detail ?? "", /A project rests on this holiday list/)
    const spare = await created(olivia, "/holiday-lists", await post(olivia, { country: "IS", name: "Icelandic public holidays", holidays: [{ day: "2026-06-17", name: "Þjóðhátíðardagurinn" }] }), HolidayList)
    const gone = await olivia(`/holiday-lists/${spare.id}`, { method: "DELETE" })
    assert.equal(gone.status, 204)
    await refused(await olivia(`/holiday-lists/${spare.id}`), 404)
  })

  test("answers 404 for another company's list and for an id nobody minted, and 403 without the grant", async () => {
    const [mine] = await listed(olivia)
    await refused(await other(`/holiday-lists/${mine.id}`), 404)
    await refused(await other(`/holiday-lists/${mine.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
    await refused(await other(`/holiday-lists/${mine.id}/holidays`, { method: "PUT", body: { holidays: [] } }), 404)
    await refused(await other(`/holiday-lists/${mine.id}`, { method: "DELETE" }), 404)
    await refused(await olivia(`/holiday-lists/${testId()}`), 404)
    assert.match((await refused(await ungranted("/holiday-lists"), 403)).detail ?? "", /view on configure\.calendars/)
  })
})
