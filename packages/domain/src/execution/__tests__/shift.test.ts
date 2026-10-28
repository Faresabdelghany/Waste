import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  BREAK_FITS,
  BREAK_WINDOW_NEEDS_MINUTES,
  BREAK_WITHIN_SHIFT,
  departureOf,
  routeShift,
  secondsOfDay,
  SHIFT_ENDS_AFTER_IT_STARTS,
  shiftProblem,
  stopWindow,
  timeOfDay,
  WINDOW_CLOSES_AFTER_IT_OPENS,
  type DriverShift,
} from "../shift"

const day: DriverShift = { from: "07:00", to: "15:00", breakMinutes: 30, breakWindow: { from: "11:00", to: "12:30" } }

describe("a time of day (O14 of #290)", () => {
  test("is seconds from midnight, with or without Postgres's seconds", () => {
    assert.equal(secondsOfDay("07:30"), 27_000)
    assert.equal(secondsOfDay("07:30:15"), 27_015)
    assert.throws(() => secondsOfDay("7.30"))
  })

  test("is spelled back as HH:MM within the day", () => {
    assert.equal(timeOfDay(27_000), "07:30")
    assert.equal(timeOfDay(27_059), "07:30")
    assert.equal(timeOfDay(86_400 + 3_600), "01:00")
  })
})

describe("a driver's shift", () => {
  test("holds with a break inside a window inside the shift, and without any break", () => {
    assert.equal(shiftProblem(day), null)
    assert.equal(shiftProblem({ ...day, breakMinutes: null, breakWindow: null }), null)
    assert.equal(shiftProblem({ ...day, breakWindow: null }), null)
  })

  test("ends after it starts, on the same day", () => {
    assert.deepEqual(shiftProblem({ ...day, from: "22:00", to: "06:00" }), { sentence: SHIFT_ENDS_AFTER_IT_STARTS, path: "to" })
    assert.deepEqual(shiftProblem({ ...day, to: "07:00" }), { sentence: SHIFT_ENDS_AFTER_IT_STARTS, path: "to" })
  })

  test("gives its break's window only with the minutes, ordered and inside the shift", () => {
    assert.deepEqual(shiftProblem({ ...day, breakMinutes: null }), { sentence: BREAK_WINDOW_NEEDS_MINUTES, path: "breakMinutes" })
    assert.deepEqual(shiftProblem({ ...day, breakWindow: { from: "12:00", to: "11:00" } }), { sentence: WINDOW_CLOSES_AFTER_IT_OPENS, path: "breakWindow" })
    assert.deepEqual(shiftProblem({ ...day, breakWindow: { from: "14:30", to: "15:30" } }), { sentence: BREAK_WITHIN_SHIFT, path: "breakWindow" })
  })

  test("fits its break's minutes inside the break's window, or the shift without one", () => {
    assert.deepEqual(shiftProblem({ ...day, breakMinutes: 120 }), { sentence: BREAK_FITS, path: "breakMinutes" })
    assert.deepEqual(shiftProblem({ from: "07:00", to: "08:00", breakMinutes: 90, breakWindow: null }), { sentence: BREAK_FITS, path: "breakMinutes" })
  })
})

describe("a stop's window", () => {
  test("is none where nothing bounds it, and the one window where one does", () => {
    assert.equal(stopWindow([null, null]), null)
    assert.deepEqual(stopWindow([{ from: "07:00", to: "10:00" }, null]), { from: "07:00", to: "10:00" })
  })

  test("is where the property's hours and the agreement's promise overlap", () => {
    assert.deepEqual(
      stopWindow([
        { from: "06:00", to: "12:00" },
        { from: "08:00", to: "14:00" },
      ]),
      { from: "08:00", to: "12:00" },
    )
  })

  test("is disjoint where they do not overlap, or only touch", () => {
    assert.equal(
      stopWindow([
        { from: "06:00", to: "08:00" },
        { from: "08:00", to: "14:00" },
      ]),
      "disjoint",
    )
  })
})

describe("the over-shift verdict", () => {
  test("a route leaves at its planned start, or at the shift's start without one", () => {
    assert.equal(departureOf("06:30:00", day), "06:30")
    assert.equal(departureOf(null, day), "07:00")
    assert.equal(departureOf(null, null), null)
  })

  test("works the drive, the waiting, the stop time and the break, and is within the shift when it ends by its end", () => {
    const verdict = routeShift({ shift: day, plannedStartTime: null, driveSeconds: 4 * 3600, waitingSeconds: 600, stopSeconds: 3000 })
    assert.deepEqual(verdict, { shift: day, startsAt: "07:00", workSeconds: 4 * 3600 + 600 + 3000 + 1800, overShiftSeconds: 0 })
  })

  test("runs over by what it works past the shift's end, and by what it starts before the shift", () => {
    assert.equal(routeShift({ shift: day, plannedStartTime: "07:00", driveSeconds: 7.5 * 3600, waitingSeconds: null, stopSeconds: 1800 }).overShiftSeconds, 1800)
    assert.equal(routeShift({ shift: day, plannedStartTime: "06:00", driveSeconds: 3600, waitingSeconds: 0, stopSeconds: 0 }).overShiftSeconds, 3600)
  })

  test("says nothing of the shift without a measured Plan, and reads no shift for a driver without one", () => {
    assert.deepEqual(routeShift({ shift: day, plannedStartTime: null, driveSeconds: null, waitingSeconds: null, stopSeconds: 600 }), { shift: day, startsAt: "07:00", workSeconds: null, overShiftSeconds: null })
    assert.deepEqual(routeShift({ shift: null, plannedStartTime: "07:00", driveSeconds: 3600, waitingSeconds: 0, stopSeconds: 600 }), { shift: null, startsAt: "07:00", workSeconds: 4200, overShiftSeconds: null })
  })
})
