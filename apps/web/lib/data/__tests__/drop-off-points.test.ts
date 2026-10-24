import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { exceptionsOf, exceptionsText, exceptionsToSave, weeklyHoursOf, weeklyHoursText } from "../drop-off-points"

describe("weeklyHoursOf and weeklyHoursText", () => {
  test("a line a day or a run of days, then its windows; a time may drop its leading zero", () => {
    assert.deepEqual(weeklyHoursOf("Mon–Wed 10:00–18:00\nSat 9:00-12:00, 13:00–17:00"), [
      { weekday: "monday", opensAt: "10:00", closesAt: "18:00" },
      { weekday: "tuesday", opensAt: "10:00", closesAt: "18:00" },
      { weekday: "wednesday", opensAt: "10:00", closesAt: "18:00" },
      { weekday: "saturday", opensAt: "09:00", closesAt: "12:00" },
      { weekday: "saturday", opensAt: "13:00", closesAt: "17:00" },
    ])
    assert.deepEqual(weeklyHoursOf("Thursday, sun 12:00–16:00"), [
      { weekday: "thursday", opensAt: "12:00", closesAt: "16:00" },
      { weekday: "sunday", opensAt: "12:00", closesAt: "16:00" },
    ])
    assert.deepEqual(weeklyHoursOf("  \n"), [], "no lines, no hours")
  })

  test("a line it cannot read whole, and hours the domain refuses, are told by line or in the domain's words; nothing on a line is skipped", () => {
    const line = "give the days, then their hours and nothing else, such as Mon–Fri 10:00–18:00 or Sat 09:00–12:00, 13:00–17:00"
    assert.deepEqual(weeklyHoursOf("Mon–Fri"), { message: `Line 1: ${line}` })
    assert.deepEqual(weeklyHoursOf("Mon 10:00–12:00 Tue 13:00–15:00"), { message: `Line 1: ${line}` }, "a second run of days on one line")
    assert.deepEqual(weeklyHoursOf("Sat 09:00–12:00, 13:00-1700"), { message: `Line 1: ${line}` }, "a malformed second window")
    assert.deepEqual(weeklyHoursOf("Mon 10:00–12:00 until Easter"), { message: `Line 1: ${line}` }, "stray words after the hours")
    assert.deepEqual(weeklyHoursOf(", 10:00–12:00"), { message: "Line 1: name the days before the hours, such as Mon–Fri or Sat, Sun" })
    assert.deepEqual(weeklyHoursOf("Funday 10:00–18:00"), { message: "Line 1: \"Funday\" is not a day of the week" })
    assert.deepEqual(weeklyHoursOf("Mon 18:00–10:00"), { message: "Monday: a window must open before it closes (18:00–10:00)" })
    assert.deepEqual(weeklyHoursOf("Sat 08:00–12:00\nSat 11:00–14:00"), { message: "Saturday: 08:00–12:00 and 11:00–14:00 overlap" })
  })

  test("written back a line per run of days with the same windows, weekday order, and read back the same", () => {
    const hours = weeklyHoursOf("Mon–Fri 10:00–18:00\nSat 09:00–12:00, 13:00–17:00\nSun 10:00–14:00")
    assert.ok(Array.isArray(hours))
    const text = weeklyHoursText(hours)
    assert.equal(text, "Mon–Fri 10:00–18:00\nSat 09:00–12:00, 13:00–17:00\nSun 10:00–14:00")
    assert.deepEqual(weeklyHoursOf(text), hours)
    assert.equal(weeklyHoursText([{ weekday: "tuesday", opensAt: "10:00", closesAt: "12:00" }, { weekday: "thursday", opensAt: "10:00", closesAt: "12:00" }]), "Tue, Thu 10:00–12:00")
  })
})

describe("exceptionsOf, exceptionsText and exceptionsToSave", () => {
  test("a date, closed or its window, and a note", () => {
    assert.deepEqual(exceptionsOf("2026-12-24 09:00–12:00 Christmas Eve\n2026-12-25 closed Christmas Day\n2027-01-01 closed"), [
      { date: "2026-12-24", opensAt: "09:00", closesAt: "12:00", note: "Christmas Eve" },
      { date: "2026-12-25", opensAt: null, closesAt: null, note: "Christmas Day" },
      { date: "2027-01-01", opensAt: null, closesAt: null, note: null },
    ])
    assert.equal(exceptionsText(exceptionsOf("2026-12-25 Closed Christmas Day\n2026-12-24 9:00–12:00") as never), "2026-12-24 09:00–12:00\n2026-12-25 closed Christmas Day")
  })

  test("a line it cannot read, a date that is none, and a second exception of a date", () => {
    assert.deepEqual(exceptionsOf("24 December closed"), { message: "Line 1: begin with the date, such as 2026-12-24, then closed or the hours" })
    assert.deepEqual(exceptionsOf("2026-02-30 closed"), { message: "Line 1: 2026-02-30 is not a date" })
    assert.deepEqual(exceptionsOf("2026-12-24 Christmas Eve"), { message: "Line 1: after the date, write closed or the hours, such as 09:00–12:00" })
    assert.deepEqual(exceptionsOf("2026-12-24 closed\n2026-12-24 09:00–12:00"), { message: "2026-12-24: one exception a date" })
    assert.deepEqual(exceptionsOf("2026-12-24 09:00–12:00, 14:00–16:00"), { message: "Line 1: an exception is closed or one window, such as 09:00–12:00, then its note" }, "a second window is never saved as a note")
    assert.deepEqual(exceptionsOf("2026-12-24 closed from 14:00"), { message: "Line 1: an exception is closed or one window, such as 09:00–12:00, then its note" })
  })

  test("a day gone by is history: one the point held is dropped, one typed for it is refused rather than quietly lost", () => {
    const set = exceptionsOf("2026-10-23 closed\n2026-10-24 closed\n2026-12-24 09:00–12:00") as Parameters<typeof exceptionsToSave>[0]
    assert.deepEqual(
      (exceptionsToSave(set, "2026-10-24", new Set(["2026-10-23"])) as { date: string }[]).map((exception) => exception.date),
      ["2026-10-24", "2026-12-24"],
    )
    assert.deepEqual(exceptionsToSave(set, "2026-10-24", new Set()), { message: "2026-10-23 has gone by: an exception is for today or a day ahead" })
  })
})
