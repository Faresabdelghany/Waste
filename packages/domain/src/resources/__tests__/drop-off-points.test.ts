import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NO_HOLIDAYS } from "../../route-schemes/occurrences"
import { exceptionIssues, hoursIssues, openingDaysOf, type DropOffOpening } from "../drop-off-points"

const centre: DropOffOpening = {
  openAlways: false,
  closedOnHolidays: true,
  hours: [
    { weekday: "monday", opensAt: "10:00", closesAt: "18:00" },
    { weekday: "saturday", opensAt: "13:00", closesAt: "17:00" },
    { weekday: "saturday", opensAt: "08:00", closesAt: "11:00" },
  ],
  exceptions: [],
}
/** Monday 21 December to Sunday 27 December 2026; Christmas Day is the Friday. */
const christmasWeek = { from: "2026-12-21", days: 7 }
const holidays = new Map([["2026-12-25", "Christmas Day"]])

describe("openingDaysOf", () => {
  test("a usual week: each day its weekday's windows, earliest first, and a day with none closed", () => {
    const week = openingDaysOf(centre, christmasWeek, NO_HOLIDAYS)
    assert.deepEqual(
      week.map((day) => [day.date, day.windows.map((window) => `${window.opensAt}–${window.closesAt}`), day.allDay, day.note]),
      [
        ["2026-12-21", ["10:00–18:00"], false, null],
        ["2026-12-22", [], false, null],
        ["2026-12-23", [], false, null],
        ["2026-12-24", [], false, null],
        ["2026-12-25", [], false, null],
        ["2026-12-26", ["08:00–11:00", "13:00–17:00"], false, null],
        ["2026-12-27", [], false, null],
      ],
    )
  })

  test("a holiday on the project's list closes a point that closes on holidays, named; one that does not keeps its hours", () => {
    const open = { ...centre, hours: [...centre.hours, { weekday: "friday" as const, opensAt: "10:00", closesAt: "16:00" }] }
    const closed = openingDaysOf(open, christmasWeek, holidays).find((day) => day.date === "2026-12-25")
    assert.deepEqual(closed, { date: "2026-12-25", windows: [], allDay: false, note: "Christmas Day" })
    const kept = openingDaysOf({ ...open, closedOnHolidays: false }, christmasWeek, holidays).find((day) => day.date === "2026-12-25")
    assert.deepEqual(kept, { date: "2026-12-25", windows: [{ opensAt: "10:00", closesAt: "16:00" }], allDay: false, note: null })
  })

  test("an exception wins over the holiday and the week: special hours, or closed all day, with its note", () => {
    const excepted: DropOffOpening = {
      ...centre,
      exceptions: [
        { date: "2026-12-21", opensAt: null, closesAt: null, note: "Closed for maintenance" },
        { date: "2026-12-24", opensAt: "09:00", closesAt: "12:00", note: "Christmas Eve" },
        { date: "2026-12-25", opensAt: "10:00", closesAt: "13:00", note: null },
      ],
    }
    const week = openingDaysOf(excepted, christmasWeek, holidays)
    assert.deepEqual(week[0], { date: "2026-12-21", windows: [], allDay: false, note: "Closed for maintenance" })
    assert.deepEqual(week[3], { date: "2026-12-24", windows: [{ opensAt: "09:00", closesAt: "12:00" }], allDay: false, note: "Christmas Eve" })
    assert.deepEqual(week[4], { date: "2026-12-25", windows: [{ opensAt: "10:00", closesAt: "13:00" }], allDay: false, note: null })
  })

  test("a point open always is open all day, unless an exception or a holiday it closes on says otherwise", () => {
    const bank: DropOffOpening = { openAlways: true, closedOnHolidays: false, hours: [], exceptions: [{ date: "2026-12-22", opensAt: null, closesAt: null, note: "Emptied today" }] }
    const week = openingDaysOf(bank, christmasWeek, holidays)
    assert.deepEqual(week[0], { date: "2026-12-21", windows: [], allDay: true, note: null })
    assert.deepEqual(week[1], { date: "2026-12-22", windows: [], allDay: false, note: "Emptied today" })
    assert.deepEqual(week[4], { date: "2026-12-25", windows: [], allDay: true, note: null })
    assert.deepEqual(openingDaysOf({ ...bank, closedOnHolidays: true }, christmasWeek, holidays)[4], { date: "2026-12-25", windows: [], allDay: false, note: "Christmas Day" })
  })

  test("reads across a month and a year", () => {
    assert.deepEqual(
      openingDaysOf(centre, { from: "2026-12-31", days: 3 }, NO_HOLIDAYS).map((day) => day.date),
      ["2026-12-31", "2027-01-01", "2027-01-02"],
    )
  })
})

describe("hoursIssues and exceptionIssues", () => {
  test("a window opens before it closes, on the clock, and windows of one weekday never overlap", () => {
    assert.deepEqual(hoursIssues(centre.hours), [])
    assert.deepEqual(hoursIssues([{ weekday: "monday", opensAt: "18:00", closesAt: "10:00" }]), ["Monday: a window must open before it closes (18:00–10:00)"])
    assert.deepEqual(hoursIssues([{ weekday: "monday", opensAt: "10:00", closesAt: "10:00" }]), ["Monday: a window must open before it closes (10:00–10:00)"])
    assert.deepEqual(hoursIssues([{ weekday: "tuesday", opensAt: "25:00", closesAt: "26:00" }]), ["Tuesday: a time is HH:MM on the clock (25:00–26:00)"])
    assert.deepEqual(
      hoursIssues([
        { weekday: "saturday", opensAt: "08:00", closesAt: "12:00" },
        { weekday: "saturday", opensAt: "11:00", closesAt: "14:00" },
        { weekday: "sunday", opensAt: "12:00", closesAt: "14:00" },
      ]),
      ["Saturday: 08:00–12:00 and 11:00–14:00 overlap"],
    )
    assert.deepEqual(
      hoursIssues([
        { weekday: "saturday", opensAt: "08:00", closesAt: "12:00" },
        { weekday: "saturday", opensAt: "12:00", closesAt: "14:00" },
      ]),
      [],
      "one window may close as the next opens",
    )
  })

  test("an exception is one per date, its times both given or neither, and opens before it closes", () => {
    assert.deepEqual(exceptionIssues([{ date: "2026-12-24", opensAt: "09:00", closesAt: "12:00", note: null }]), [])
    assert.deepEqual(
      exceptionIssues([
        { date: "2026-12-24", opensAt: "09:00", closesAt: null, note: null },
        { date: "2026-12-31", opensAt: "12:00", closesAt: "09:00", note: null },
        { date: "2026-12-31", opensAt: null, closesAt: null, note: null },
      ]),
      ["2026-12-24: give both times, or neither for closed all day", "2026-12-31: a window must open before it closes (12:00–09:00)", "2026-12-31: one exception a date"],
    )
  })
})
