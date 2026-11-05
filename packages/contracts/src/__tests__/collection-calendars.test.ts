import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CollectionCalendar, CollectionCalendarCreate, CollectionCalendarListQuery, CollectionCalendarPatch } from "../collection-calendars"
import { HOLIDAYS_MAX, HolidayListHoliday, HolidayListHolidaysSet, ONE_LISTED_HOLIDAY_PER_DAY } from "../holiday-lists"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMPS = { createdAt: "2026-09-24T13:41:00.000Z", updatedAt: "2026-09-24T13:41:00.000Z" }
const BACKWARDS = "validTo is the first day out of force, so it comes after validFrom"

const holidays = [
  { day: "2026-01-01", name: "Nytårsdag" },
  { day: "2026-06-05", name: "Grundlovsdag" },
  { day: "2026-12-24", name: null },
]
const calendar = { id: ID, projectId: OTHER, name: "Copenhagen Central 2026", validFrom: "2026-01-01", validTo: "2027-01-01", ...STAMPS }

/** N holidays on N distinct days, for the bound. */
const manyHolidays = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, 1 + i))
    return { day: date.toISOString().slice(0, 10), name: null }
  })

describe("CollectionCalendar", () => {
  test("is the row on the wire and the period it tiles; the weekend, the timezone and the holidays are not the calendar's", () => {
    assert.deepEqual(CollectionCalendar.parse(calendar), calendar)
    const open = { ...calendar, validTo: null }
    assert.deepEqual(CollectionCalendar.parse(open), open)
    for (const dropped of ["weekStart", "timezone", "holidays"]) assert.equal(Object.keys(CollectionCalendar.shape).includes(dropped), false, dropped)
    assert.deepEqual(refusal(CollectionCalendar.safeParse({ ...calendar, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })
})

describe("CollectionCalendarCreate and CollectionCalendarPatch", () => {
  const body = { projectId: OTHER, name: "Copenhagen Central 2026", validFrom: "2026-01-01", validTo: "2027-01-01" }

  test("write the name and the period, read an absent end as open, and mint nothing", () => {
    assert.deepEqual(CollectionCalendarCreate.parse(body), body)
    refusesWhatTheServerOwns(CollectionCalendarCreate, body)
    for (const key of ["projectId", "name", "validFrom"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(CollectionCalendarCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("refuse a backwards period, and holidays by name: a project's are its holiday list's", () => {
    assert.deepEqual(refusal(CollectionCalendarCreate.safeParse({ ...body, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    assert.match(refusal(CollectionCalendarCreate.safeParse({ ...body, holidays }))[0].message, /holidays/)
  })

  test("change the name and the period, never the holidays or the project; a patch with both days holds them against each other", () => {
    assert.deepEqual(CollectionCalendarPatch.parse({ name: "Copenhagen Central, 2026" }), { name: "Copenhagen Central, 2026" })
    assert.deepEqual(CollectionCalendarPatch.parse({ validTo: null }), { validTo: null })
    refusesAnEmptyPatch(CollectionCalendarPatch)
    assert.match(refusal(CollectionCalendarPatch.safeParse({ name: "x", holidays }))[0].message, /holidays/)
    assert.match(refusal(CollectionCalendarPatch.safeParse({ name: "x", projectId: OTHER }))[0].message, /projectId/)
    assert.deepEqual(refusal(CollectionCalendarPatch.safeParse({ validFrom: "2026-02-01", validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    assert.deepEqual(CollectionCalendarPatch.parse({ validTo: "2020-01-01" }), { validTo: "2020-01-01" }, "half a period is the route's to judge")
  })
})

describe("CollectionCalendarListQuery", () => {
  test("takes a page, the project and the day to read the period against", () => {
    assert.deepEqual(CollectionCalendarListQuery.parse({}), { limit: 50 })
    assert.deepEqual(CollectionCalendarListQuery.parse({ projectId: OTHER, validOn: "2026-06-05", limit: "5" }), { projectId: OTHER, validOn: "2026-06-05", limit: 5 })
    assert.equal(CollectionCalendarListQuery.safeParse({ validOn: "June" }).success, false)
  })
})

// A holiday is a day of the company's Holiday List (2026-11-05), the entry the calendar once carried.
describe("HolidayListHoliday and HolidayListHolidaysSet", () => {
  test("a day and a name, the name null where nobody gave one; nothing the server owns", () => {
    assert.deepEqual(HolidayListHoliday.parse(holidays[0]), holidays[0])
    assert.deepEqual(HolidayListHoliday.parse(holidays[2]), holidays[2])
    assert.equal(HolidayListHoliday.safeParse({ day: "2026-06-05" }).success, false, "the name is said, as a label or as null")
    assert.match(refusal(HolidayListHoliday.safeParse({ ...holidays[0], id: ID }))[0].message, /id/)
    assert.equal(HolidayListHoliday.safeParse({ day: "2026-06-05T00:00:00Z", name: null }).success, false)
  })

  test("the whole set, empty allowed, each day once, at most 400", () => {
    assert.deepEqual(HolidayListHolidaysSet.parse({ holidays }), { holidays })
    assert.deepEqual(HolidayListHolidaysSet.parse({ holidays: [] }), { holidays: [] })
    assert.deepEqual(refusal(HolidayListHolidaysSet.safeParse({ holidays: [holidays[1], holidays[1]] })), [{ path: "holidays", message: ONE_LISTED_HOLIDAY_PER_DAY }])
    assert.equal(HolidayListHolidaysSet.safeParse({ holidays: manyHolidays(HOLIDAYS_MAX) }).success, true)
    assert.deepEqual(refusal(HolidayListHolidaysSet.safeParse({ holidays: manyHolidays(HOLIDAYS_MAX + 1) })).map((issue) => issue.path), ["holidays"])
    assert.match(refusal(HolidayListHolidaysSet.safeParse({ holidays, name: "x" }))[0].message, /name/)
  })
})
