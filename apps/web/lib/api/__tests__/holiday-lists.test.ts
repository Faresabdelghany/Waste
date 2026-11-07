// The company's Holiday Lists on the Pilot (2026-11-05): a list read as the
// record the pane and resolveProjectCalendar read, its writes as the bodies
// the contracts take, and the update's two requests in order.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { HolidayListCreate, HolidayListHolidaysSet, HolidayListPatch, type HolidayList } from "@waste/contracts/holiday-lists"
import { holidayListEntries, isHolidayListRecord } from "@/lib/prototype/route-schemes/holiday-list-records"
import { resolveProjectCalendar } from "@/lib/prototype/route-schemes/project-calendar"

import { type BusinessRecord } from "../../data/business-modules"
import { createHolidayListRecord, nextYearEntries, withHolidayListDraft, withHolidayListEntries } from "../../data/holiday-lists"
import { NOTHING_RESOLVED, type MappingContext } from "../records/adapter"
import { holidayListAdapter } from "../records/holiday-lists"
import { collectionCalendarsModule } from "../records/planning"
import { bodyOf, clientOver, json, scripted } from "./scripted-fetch"

const NOW = new Date("2026-11-05T12:00:00Z")
const context: MappingContext = { resolve: NOTHING_RESOLVED, now: NOW }

const danish: HolidayList = {
  id: "01a0d2a4-a280-702f-8000-000000000001",
  createdAt: "2026-11-05T09:00:00.000Z",
  updatedAt: "2026-11-05T09:30:00.000Z",
  country: "DK",
  name: "Danish public holidays",
  holidays: [
    { day: "2026-06-05", name: "Grundlovsdag" },
    { day: "2026-12-25", name: null },
  ],
  projectCount: 1,
}

describe("a holiday list read", () => {
  test("is the calendars module's second kind, its days spelled as a calendar's, named by the list or by its country's known list", () => {
    assert.ok(collectionCalendarsModule.resources.includes(holidayListAdapter))
    const record = holidayListAdapter.toRecord(danish, context)
    assert.equal(record.id, `holiday-list-${danish.id}`)
    assert.ok(isHolidayListRecord(record))
    assert.deepEqual([record.name, record.facts.Country, record.facts.Projects], ["Danish public holidays", "DK", "1"])
    assert.deepEqual(holidayListEntries(record), [
      { date: "2026-06-05", name: "Grundlovsdag" },
      { date: "2026-12-25", name: "Christmas Day" },
    ])
  })

  test("is what a project resting on it reads its holidays from", () => {
    const list = holidayListAdapter.toRecord(danish, context)
    const project = { id: "project-copenhagen", name: "Copenhagen Central", submittedValues: { holidayList: "Danish public holidays" } } as unknown as BusinessRecord
    const calendar = resolveProjectCalendar("project-copenhagen", { projects: [project], calendars: [list] })
    assert.deepEqual([...(calendar.list?.dates.entries() ?? [])], [
      ["2026-06-05", "Grundlovsdag"],
      ["2026-12-25", "Christmas Day"],
    ])
  })
})

describe("a holiday list written", () => {
  test("a new list is the create body the contracts take, with the days it starts with", () => {
    const record = createHolidayListRecord({ country: "NO", name: " Norwegian public holidays " }, [{ date: "2026-05-17", name: "Grunnlovsdag" }], { actorName: "Olivia", now: 1 })
    assert.ok(holidayListAdapter.owns(record), "the minted record is the adapter's by its kind")
    const body = holidayListAdapter.toCreateBody?.(record, context)
    assert.deepEqual(HolidayListCreate.parse(body), { country: "NO", name: "Norwegian public holidays", holidays: [{ day: "2026-05-17", name: "Grunnlovsdag" }] })
  })

  test("a rename and the days are two requests, the list first; nothing moved is no request", async () => {
    const before = holidayListAdapter.toRecord(danish, context)
    assert.equal(holidayListAdapter.toPatchBody(before, before, context), null)
    const renamed = withHolidayListDraft(before, { country: "DK", name: "Danske helligdage" })
    const after = withHolidayListEntries(renamed, [...holidayListEntries(renamed), { date: "2026-12-24", name: "Juleaftensdag" }])
    const body = holidayListAdapter.toPatchBody(before, after, context) as { list: unknown; holidays: unknown }
    assert.deepEqual(HolidayListPatch.parse(body.list), { name: "Danske helligdage" })
    HolidayListHolidaysSet.parse({ holidays: body.holidays })
    const { fetch, calls } = scripted([() => json({ ...danish, name: "Danske helligdage" }), () => json({ ...danish, name: "Danske helligdage" })])
    await holidayListAdapter.update(clientOver(fetch), danish.id, body)
    assert.deepEqual(
      calls.map((call) => [call.init.method, call.url]),
      [
        ["PATCH", `http://api.test/holiday-lists/${danish.id}`],
        ["PUT", `http://api.test/holiday-lists/${danish.id}/holidays`],
      ],
    )
    assert.deepEqual(bodyOf(calls[1]), {
      holidays: [
        { day: "2026-06-05", name: "Grundlovsdag" },
        { day: "2026-12-24", name: "Juleaftensdag" },
        { day: "2026-12-25", name: "Christmas Day" },
      ],
    })
  })

  test("next year's holidays from this year's: a fixed day keeps its day, a moveable feast lands on its day, a day already held is left out", () => {
    const list = holidayListAdapter.toRecord(
      {
        ...danish,
        holidays: [
          { day: "2026-04-05", name: "Easter Sunday" },
          { day: "2026-12-25", name: "Christmas Day" },
          { day: "2027-12-25", name: "Christmas Day" },
        ],
      },
      context,
    )
    assert.deepEqual(nextYearEntries(list, 2026), [{ date: "2027-03-28", name: "Easter Sunday" }])
  })
})
