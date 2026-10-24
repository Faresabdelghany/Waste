// The day a route runs against its project's calendar (O5 of #290): a holiday
// is non-working unless the route's scheme collects on holidays, a weekend
// day unless the scheme serves that weekday, and for the office's ad-hoc
// route, which has no scheme, both always are.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { SchemeCalendar } from "../../route-schemes/occurrences"
import { confirmNonWorkingDay, nonWorkingDay, operatingDayReading, type OperatingDayScheme } from "../operating-day"

// Copenhagen rests on Saturday and Sunday; Christmas Day 2026 is a Friday.
const calendar: SchemeCalendar = { weekend: ["saturday", "sunday"], holidays: new Map([["2026-12-25", "Christmas Day"]]) }
const weekdays: OperatingDayScheme = { holidayPolicy: "shift-next", serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"] }

describe("a route's operating day by its project's calendar", () => {
  test("a weekday off the holiday list is a working day, for a scheme's route and the office's own alike", () => {
    assert.deepEqual(operatingDayReading(calendar, "2026-12-23", weekdays), { kind: "working" })
    assert.deepEqual(operatingDayReading(calendar, "2026-12-23", null), { kind: "working" })
  })

  test("a holiday is non-working unless the scheme collects on holidays", () => {
    assert.deepEqual(operatingDayReading(calendar, "2026-12-25", weekdays), { kind: "holiday", name: "Christmas Day" })
    assert.deepEqual(operatingDayReading(calendar, "2026-12-25", { ...weekdays, holidayPolicy: "skip" }), { kind: "holiday", name: "Christmas Day" })
    assert.deepEqual(operatingDayReading(calendar, "2026-12-25", { ...weekdays, holidayPolicy: "collect" }), { kind: "working" })
    assert.deepEqual(operatingDayReading(calendar, "2026-12-25", null), { kind: "holiday", name: "Christmas Day" }, "an ad-hoc route has no policy to collect by")
  })

  test("a weekend day is non-working unless the scheme serves that weekday: a scheme serving Saturdays collects on Saturdays", () => {
    assert.deepEqual(operatingDayReading(calendar, "2026-12-26", weekdays), { kind: "weekend", weekday: "saturday" })
    assert.deepEqual(operatingDayReading(calendar, "2026-12-26", { ...weekdays, serviceDays: [...weekdays.serviceDays, "saturday"] }), { kind: "working" })
    assert.deepEqual(operatingDayReading(calendar, "2026-12-27", null), { kind: "weekend", weekday: "sunday" })
    // Egypt rests on Friday and Saturday: its Sunday is a working day.
    assert.deepEqual(operatingDayReading({ weekend: ["friday", "saturday"], holidays: new Map() }, "2026-12-27", null), { kind: "working" })
  })

  test("the sentences name the day for what it is, and the refusal says what to do", () => {
    assert.equal(nonWorkingDay("2026-12-25", { kind: "holiday", name: "Christmas Day" }), "Fri 25 Dec is Christmas Day, a holiday on the project's calendar")
    assert.equal(nonWorkingDay("2026-12-26", { kind: "weekend", weekday: "saturday" }), "Sat 26 Dec is a Saturday of the project's weekend")
    assert.equal(confirmNonWorkingDay("RC-1042", "2026-12-26", { kind: "weekend", weekday: "saturday" }), "Sat 26 Dec is a Saturday of the project's weekend; confirm the move to run route RC-1042 on a non-working day")
  })
})
