import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  CollectionCalendar,
  CollectionCalendarCreate,
  CollectionCalendarHoliday,
  CollectionCalendarHolidaysSet,
  CollectionCalendarListQuery,
  CollectionCalendarPatch,
  HOLIDAYS_MAX,
  ONE_HOLIDAY_PER_DAY,
  OUTSIDE_CALENDAR_PERIOD,
  withinPeriod,
} from "../collection-calendars"
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
const calendar = { id: ID, projectId: OTHER, name: "Copenhagen Central 2026", holidays, validFrom: "2026-01-01", validTo: "2027-01-01", ...STAMPS }

/** N holidays on N distinct days of one year, for the bound. */
const manyHolidays = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, 1 + i))
    return { day: date.toISOString().slice(0, 10), name: null }
  })

describe("CollectionCalendarHoliday", () => {
  test("is a day and a name, the name null where nobody gave one; nothing the server owns", () => {
    assert.deepEqual(CollectionCalendarHoliday.parse(holidays[0]), holidays[0])
    assert.deepEqual(CollectionCalendarHoliday.parse(holidays[2]), holidays[2])
    assert.equal(CollectionCalendarHoliday.safeParse({ day: "2026-06-05" }).success, false, "the name is said, as a label or as null")
    assert.match(refusal(CollectionCalendarHoliday.safeParse({ ...holidays[0], id: ID }))[0].message, /id/)
    assert.equal(CollectionCalendarHoliday.safeParse({ day: "2026-06-05T00:00:00Z", name: null }).success, false)
  })
})

describe("CollectionCalendar", () => {
  test("is the row on the wire with its holidays and the period it tiles; the weekend and the timezone are the project's", () => {
    assert.deepEqual(CollectionCalendar.parse(calendar), calendar)
    const open = { ...calendar, holidays: [], validTo: null }
    assert.deepEqual(CollectionCalendar.parse(open), open)
    for (const dropped of ["weekStart", "timezone"]) assert.equal(Object.keys(CollectionCalendar.shape).includes(dropped), false, dropped)
    assert.deepEqual(refusal(CollectionCalendar.safeParse({ ...calendar, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
  })

  test("reads back however many holidays it grew to: the bound is a body's", () => {
    assert.equal(CollectionCalendar.safeParse({ ...calendar, holidays: manyHolidays(HOLIDAYS_MAX + 1) }).success, true)
  })
})

describe("CollectionCalendarCreate and CollectionCalendarPatch", () => {
  const body = { projectId: OTHER, name: "Copenhagen Central 2026", validFrom: "2026-01-01", validTo: "2027-01-01" }

  test("start with no holidays unless given, read an absent end as open, and mint nothing", () => {
    assert.deepEqual(CollectionCalendarCreate.parse(body), { ...body, holidays: [] })
    assert.deepEqual(CollectionCalendarCreate.parse({ ...body, holidays }), { ...body, holidays })
    assert.match(CollectionCalendarCreate.shape.holidays.description ?? "", /none when absent/)
    refusesWhatTheServerOwns(CollectionCalendarCreate, body)
    for (const key of ["projectId", "name", "validFrom"]) {
      const without: Record<string, unknown> = { ...body }
      delete without[key]
      assert.deepEqual(refusal(CollectionCalendarCreate.safeParse(without)).map((issue) => issue.path), [key])
    }
  })

  test("hold each holiday inside the period the same body gives, refused at that entry's day; the set body has no period and leaves it to the route", () => {
    const outside = (n: number) => ({ path: `holidays.${n}.day`, message: OUTSIDE_CALENDAR_PERIOD })
    const stray = [holidays[0], { day: "2025-12-31", name: "The day before" }, { day: "2027-01-01", name: "The first day out" }]
    assert.deepEqual(refusal(CollectionCalendarCreate.safeParse({ ...body, holidays: stray })), [outside(1), outside(2)])
    assert.equal(CollectionCalendarCreate.safeParse({ ...body, holidays: [{ day: "2026-12-31", name: null }] }).success, true, "the last day inside the half-open period")
    assert.equal(CollectionCalendarCreate.safeParse({ ...body, validTo: null, holidays: [{ day: "2031-06-05", name: null }] }).success, true, "an open end covers every later day")
    assert.equal(CollectionCalendarHolidaysSet.safeParse({ holidays: stray }).success, true)
    assert.equal(withinPeriod({ validFrom: "2026-01-01", validTo: "2027-01-01" }, "2027-01-01"), false)
    assert.equal(withinPeriod({ validFrom: "2026-01-01", validTo: null }, "2099-12-31"), true)
  })

  test("refuse a backwards period, two holidays on one day, and more than 400 of them", () => {
    assert.deepEqual(refusal(CollectionCalendarCreate.safeParse({ ...body, validTo: "2026-01-01" })), [{ path: "validTo", message: BACKWARDS }])
    assert.deepEqual(refusal(CollectionCalendarCreate.safeParse({ ...body, holidays: [holidays[0], { day: "2026-01-01", name: "Twice" }] })), [
      { path: "holidays", message: ONE_HOLIDAY_PER_DAY },
    ])
    // Four hundred days from New Year run past the year, so the bound is proved on an open-ended period, where every later day is inside.
    assert.equal(CollectionCalendarCreate.safeParse({ ...body, validTo: null, holidays: manyHolidays(HOLIDAYS_MAX) }).success, true)
    assert.deepEqual(refusal(CollectionCalendarCreate.safeParse({ ...body, validTo: null, holidays: manyHolidays(HOLIDAYS_MAX + 1) })).map((issue) => issue.path), ["holidays"])
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

describe("CollectionCalendarHolidaysSet", () => {
  test("is the whole list, empty allowed, each day once, at most 400", () => {
    assert.deepEqual(CollectionCalendarHolidaysSet.parse({ holidays }), { holidays })
    assert.deepEqual(CollectionCalendarHolidaysSet.parse({ holidays: [] }), { holidays: [] })
    assert.deepEqual(refusal(CollectionCalendarHolidaysSet.safeParse({ holidays: [holidays[1], holidays[1]] })), [{ path: "holidays", message: ONE_HOLIDAY_PER_DAY }])
    assert.deepEqual(refusal(CollectionCalendarHolidaysSet.safeParse({ holidays: manyHolidays(HOLIDAYS_MAX + 1) })).map((issue) => issue.path), ["holidays"])
    assert.match(refusal(CollectionCalendarHolidaysSet.safeParse({ holidays, name: "x" }))[0].message, /name/)
  })
})

describe("CollectionCalendarListQuery", () => {
  test("takes a page, the project and the day to read the period against", () => {
    assert.deepEqual(CollectionCalendarListQuery.parse({}), { limit: 50 })
    assert.deepEqual(CollectionCalendarListQuery.parse({ projectId: OTHER, validOn: "2026-06-05", limit: "5" }), { projectId: OTHER, validOn: "2026-06-05", limit: 5 })
    assert.equal(CollectionCalendarListQuery.safeParse({ validOn: "June" }).success, false)
  })
})
