// How a report's window is cut: by the day, the ISO week from Monday and the
// calendar month, the first and the last interval clipped to the window so
// the series covers the window's days exactly once; across a month's and a
// year's end and a leap day; and a day that is not one refused.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { intervalOf, intervalsOver, intervalStart, windowDays } from "../intervals"
import { REPORT_INTERVALS } from "../vocabulary"

describe("intervalStart", () => {
  test("is the day itself, the Monday of its ISO week, and the first of its month", () => {
    // 2026-10-07 is a Wednesday.
    assert.equal(intervalStart("2026-10-07", "day"), "2026-10-07")
    assert.equal(intervalStart("2026-10-07", "week"), "2026-10-05")
    assert.equal(intervalStart("2026-10-05", "week"), "2026-10-05", "a Monday starts its own week")
    assert.equal(intervalStart("2026-10-11", "week"), "2026-10-05", "a Sunday ends the week that began on Monday")
    assert.equal(intervalStart("2027-01-01", "week"), "2026-12-28", "a week across the year's end starts in the old year")
    assert.equal(intervalStart("2026-10-31", "month"), "2026-10-01")
  })

  test("refuses a day that is not one", () => {
    for (const bad of ["2026-13-01", "2026-02-30", "October", ""]) assert.throws(() => intervalStart(bad, "day"), /is not a YYYY-MM-DD day/, bad)
  })
})

describe("windowDays", () => {
  test("counts both ends, across a leap day, and is zero for a window that runs backwards", () => {
    assert.equal(windowDays({ from: "2026-10-05", to: "2026-10-05" }), 1)
    assert.equal(windowDays({ from: "2026-10-01", to: "2026-10-31" }), 31)
    assert.equal(windowDays({ from: "2028-02-01", to: "2028-03-01" }), 30, "February 2028 has 29 days")
    assert.equal(windowDays({ from: "2026-10-06", to: "2026-10-05" }), 0)
  })
})

describe("intervalsOver", () => {
  test("by the day: one interval per day of the window", () => {
    assert.deepEqual(intervalsOver({ from: "2026-10-30", to: "2026-11-02" }, "day"), [
      { from: "2026-10-30", to: "2026-10-30" },
      { from: "2026-10-31", to: "2026-10-31" },
      { from: "2026-11-01", to: "2026-11-01" },
      { from: "2026-11-02", to: "2026-11-02" },
    ])
  })

  test("by the week: Monday to Sunday, the first and the last clipped to the window", () => {
    // Thursday 2026-10-01 to Tuesday 2026-10-20.
    assert.deepEqual(intervalsOver({ from: "2026-10-01", to: "2026-10-20" }, "week"), [
      { from: "2026-10-01", to: "2026-10-04" },
      { from: "2026-10-05", to: "2026-10-11" },
      { from: "2026-10-12", to: "2026-10-18" },
      { from: "2026-10-19", to: "2026-10-20" },
    ])
  })

  test("by the month: calendar months across the year's end and a leap February, clipped", () => {
    assert.deepEqual(intervalsOver({ from: "2027-12-15", to: "2028-03-01" }, "month"), [
      { from: "2027-12-15", to: "2027-12-31" },
      { from: "2028-01-01", to: "2028-01-31" },
      { from: "2028-02-01", to: "2028-02-29" },
      { from: "2028-03-01", to: "2028-03-01" },
    ])
  })

  test("by the month in any year: a century's February, a fourth century's, and a year below 100", () => {
    assert.deepEqual(intervalsOver({ from: "2100-02-01", to: "2100-02-28" }, "month"), [{ from: "2100-02-01", to: "2100-02-28" }], "2100 is no leap year")
    assert.deepEqual(intervalsOver({ from: "2000-02-01", to: "2000-02-29" }, "month"), [{ from: "2000-02-01", to: "2000-02-29" }], "2000 is")
    assert.deepEqual(intervalsOver({ from: "0050-01-01", to: "0050-03-31" }, "month"), [
      { from: "0050-01-01", to: "0050-01-31" },
      { from: "0050-02-01", to: "0050-02-28" },
      { from: "0050-03-01", to: "0050-03-31" },
    ])
  })

  test("covers every day of the window exactly once, whatever the interval", () => {
    const window = { from: "2026-09-17", to: "2026-12-03" }
    for (const interval of REPORT_INTERVALS) {
      const intervals = intervalsOver(window, interval)
      assert.equal(intervals[0].from, window.from, interval)
      assert.equal(intervals.at(-1)?.to, window.to, interval)
      assert.equal(
        intervals.reduce((days, span) => days + windowDays(span), 0),
        windowDays(window),
        `${interval}: the intervals' days add up to the window's`,
      )
      for (const [index, span] of intervals.entries()) {
        if (index > 0) assert.ok(span.from > intervals[index - 1].to, `${interval}: in order and never overlapping`)
      }
    }
  })

  test("is empty for a window that runs backwards", () => {
    assert.deepEqual(intervalsOver({ from: "2026-10-06", to: "2026-10-05" }, "week"), [])
  })
})

describe("intervalOf", () => {
  test("is the interval of the series the day is counted in, clipped as intervalsOver clips it", () => {
    const window = { from: "2026-10-01", to: "2026-10-20" }
    for (const interval of REPORT_INTERVALS) {
      const series = intervalsOver(window, interval)
      for (const day of ["2026-10-01", "2026-10-04", "2026-10-05", "2026-10-13", "2026-10-20"]) {
        const found = intervalOf(day, window, interval)
        assert.ok(
          series.some((span) => span.from === found.from && span.to === found.to),
          `${interval}: ${day} lies in ${found.from}..${found.to}, one of the series' intervals`,
        )
        assert.ok(found.from <= day && day <= found.to, `${interval}: ${day} inside its interval`)
      }
    }
  })

  test("refuses a day outside the window", () => {
    assert.throws(() => intervalOf("2026-09-30", { from: "2026-10-01", to: "2026-10-31" }, "month"), /outside 2026-10-01\.\.2026-10-31/)
  })
})
