import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { holidayListFromDates } from "../holidays"
import {
  NO_HOLIDAYS,
  addMonths,
  formatClockTime,
  formatOccurrenceDate,
  formatOccurrenceShortDate,
  generateOccurrences,
  isWorkingDay,
  occurrencePreview,
  shiftedNote,
  shiftToWorkingDay,
} from "../occurrences"
import { REGRESSION_HOLIDAY_DATES, weekdays } from "./holiday-fixture"

const holidays = holidayListFromDates(REGRESSION_HOLIDAY_DATES)

describe("occurrencePreview — regression values (Mon–Fri weekly from 13 Sep 2026, open-ended)", () => {
  const preview = occurrencePreview({ recurrence: weekdays, holidayPolicy: "shift-next", holidays })

  test("shift-next → 261 collections in 12 months, none skipped", () => {
    assert.equal(preview.ongoing, true)
    assert.equal(preview.horizon, "2027-09-13")
    assert.equal(preview.count, 261)
    assert.equal(preview.rows.filter((row) => row.status === "skipped").length, 0)
  })

  test("first collection is Mon 14 Sep 2026", () => {
    const first = preview.rows.find((row) => row.n === 1)
    assert.ok(first)
    assert.equal(first.date, "2026-09-14")
    assert.equal(formatOccurrenceDate(first.date), "14 Sep 2026")
  })

  test("24 and 25 Dec both land on Mon 28 Dec", () => {
    const shifted = preview.rows.filter(
      (row) => row.plannedDate === "2026-12-24" || row.plannedDate === "2026-12-25",
    )
    assert.deepEqual(
      shifted.map((row) => [row.status, row.date, row.note]),
      [
        ["shifted", "2026-12-28", "Christmas Eve"],
        ["shifted", "2026-12-28", "Christmas Day"],
      ],
    )
    assert.equal(shiftedNote(shifted[0]), "from Thu 24 Dec · Christmas Eve")
    // The ordinary Mon 28 Dec collection stays; three rows share the date.
    assert.equal(preview.rows.filter((row) => row.date === "2026-12-28").length, 3)
  })

  test("Maundy Thursday, Good Friday, and Easter Monday 2027 all land on Tue 30 Mar", () => {
    const easter = preview.rows.filter((row) =>
      ["2027-03-25", "2027-03-26", "2027-03-29"].includes(row.plannedDate),
    )
    assert.deepEqual(
      easter.map((row) => row.date),
      ["2027-03-30", "2027-03-30", "2027-03-30"],
    )
    assert.deepEqual(
      easter.map((row) => row.note),
      ["Maundy Thursday", "Good Friday", "Easter Monday"],
    )
  })

  test("skip → 9 skipped, 252 collections", () => {
    const skipped = occurrencePreview({ recurrence: weekdays, holidayPolicy: "skip", holidays })
    assert.equal(skipped.rows.filter((row) => row.status === "skipped").length, 9)
    assert.equal(skipped.count, 252)
    const eve = skipped.rows.find((row) => row.plannedDate === "2026-12-24")
    assert.ok(eve)
    assert.equal(eve.status, "skipped")
    assert.equal(eve.n, null)
    assert.equal(eve.note, "Christmas Eve")
  })

  test("rows are date-ordered and numbered without gaps", () => {
    const dates = preview.rows.map((row) => row.date)
    assert.deepEqual(dates, [...dates].sort())
    assert.deepEqual(
      preview.rows.map((row) => row.n),
      preview.rows.map((_, index) => index + 1),
    )
  })
})

describe("holiday policies", () => {
  test("collect keeps the row on the holiday and counts it", () => {
    const preview = occurrencePreview({ recurrence: weekdays, holidayPolicy: "collect", holidays })
    const row = preview.rows.find((row) => row.plannedDate === "2026-12-24")
    assert.ok(row)
    assert.equal(row.status, "holiday")
    assert.equal(row.date, "2026-12-24")
    assert.equal(preview.count, 261)
  })

  test("shift-prev moves Fri 25 Dec back to Wed 23 Dec, past the Thu 24 holiday", () => {
    const preview = occurrencePreview({ recurrence: weekdays, holidayPolicy: "shift-prev", holidays })
    const row = preview.rows.find((row) => row.plannedDate === "2026-12-25")
    assert.ok(row)
    assert.equal(row.status, "shifted")
    assert.equal(row.date, "2026-12-23")
  })

  test("a Saturday service day collects on Saturdays; weekends only matter as shift targets", () => {
    const preview = occurrencePreview({
      recurrence: { ...weekdays, serviceDays: ["saturday"], effectiveTo: "2026-10-31" },
      holidayPolicy: "shift-next",
      holidays,
    })
    assert.equal(preview.count, 7)
    assert.ok(preview.rows.every((row) => row.status === "planned"))
    // Sat 26 Dec is a holiday: shift-next lands on Mon 28 Dec, not Sun 27.
    const christmas = generateOccurrences({
      recurrence: { ...weekdays, serviceDays: ["saturday"] },
      window: { from: "2026-12-20", to: "2026-12-31" },
      holidayPolicy: "shift-next",
      holidays,
    })
    assert.deepEqual(
      christmas.map((row) => [row.plannedDate, row.date, row.status]),
      [["2026-12-26", "2026-12-28", "shifted"]],
    )
  })

  test("without a holiday list every recurrence date is planned", () => {
    const preview = occurrencePreview({
      recurrence: { ...weekdays, effectiveTo: "2026-09-30" },
      holidayPolicy: "shift-next",
      holidays: NO_HOLIDAYS,
    })
    assert.equal(preview.ongoing, false)
    assert.equal(preview.horizon, "2026-09-30")
    assert.equal(preview.count, 13)
    assert.ok(preview.rows.every((row) => row.status === "planned"))
  })

  test("an unnamed date on the list reads Holiday", () => {
    const list = holidayListFromDates(["2026-10-07"])
    assert.equal(list.get("2026-10-07"), "Holiday")
    const rows = generateOccurrences({
      recurrence: weekdays,
      window: { from: "2026-10-05", to: "2026-10-09" },
      holidayPolicy: "skip",
      holidays: list,
    })
    assert.deepEqual(
      rows.map((row) => [row.date, row.status, row.note]),
      [
        ["2026-10-05", "planned", undefined],
        ["2026-10-06", "planned", undefined],
        ["2026-10-07", "skipped", "Holiday"],
        ["2026-10-08", "planned", undefined],
        ["2026-10-09", "planned", undefined],
      ],
    )
  })
})

describe("occurrencePreview — window edge cases", () => {
  test("end before start yields no rows", () => {
    const preview = occurrencePreview({
      recurrence: { ...weekdays, effectiveTo: "2026-09-01" },
      holidayPolicy: "shift-next",
      holidays,
    })
    assert.equal(preview.rows.length, 0)
    assert.equal(preview.count, 0)
    assert.equal(preview.horizon, "2026-09-01")
  })

  test("no service days yields no rows", () => {
    const preview = occurrencePreview({
      recurrence: { ...weekdays, serviceDays: [] },
      holidayPolicy: "shift-next",
      holidays,
    })
    assert.equal(preview.rows.length, 0)
  })

  test("every 2 weeks (even) keeps even ISO weeks only", () => {
    const preview = occurrencePreview({
      recurrence: {
        frequency: "every-2-weeks",
        weekRotation: "even",
        serviceDays: ["monday"],
        effectiveFrom: "2026-09-14",
        effectiveTo: "2026-10-31",
      },
      holidayPolicy: "skip",
      holidays,
    })
    assert.deepEqual(
      preview.rows.map((row) => [row.date, row.week]),
      [
        ["2026-09-14", 38],
        ["2026-09-28", 40],
        ["2026-10-12", 42],
        ["2026-10-26", 44],
      ],
    )
  })

  test("every 4 weeks anchors on the effective-from week", () => {
    const preview = occurrencePreview({
      recurrence: {
        frequency: "every-4-weeks",
        serviceDays: ["tuesday"],
        effectiveFrom: "2026-09-16",
        effectiveTo: "2026-12-31",
      },
      holidayPolicy: "skip",
      holidays,
    })
    assert.deepEqual(
      preview.rows.map((row) => row.date),
      ["2026-10-13", "2026-11-10", "2026-12-08"],
    )
  })
})

describe("date helpers", () => {
  test("addMonths rolls over like Date#setMonth", () => {
    assert.equal(addMonths("2026-09-13", 12), "2027-09-13")
    assert.equal(addMonths("2026-01-31", 1), "2026-03-03")
  })

  test("formatters", () => {
    assert.equal(formatOccurrenceDate("2026-10-05"), "05 Oct 2026")
    assert.equal(formatOccurrenceShortDate("2026-12-24"), "Thu 24 Dec")
    assert.equal(formatClockTime("6:30"), "06:30")
    assert.equal(formatClockTime(""), "")
  })

  test("working days exclude weekends and the holiday list", () => {
    assert.equal(isWorkingDay(holidays, "2026-12-23"), true)
    assert.equal(isWorkingDay(holidays, "2026-12-24"), false)
    assert.equal(isWorkingDay(holidays, "2026-12-27"), false)
    assert.equal(shiftToWorkingDay(holidays, "2026-12-25", 1), "2026-12-28")
    assert.equal(shiftToWorkingDay(NO_HOLIDAYS, "2026-09-18", 1), "2026-09-21")
    assert.equal(shiftToWorkingDay(NO_HOLIDAYS, "2026-09-21", -1), "2026-09-18")
  })
})
