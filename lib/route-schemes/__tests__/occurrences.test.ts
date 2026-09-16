import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { CollectionCalendar } from "../calendar"
import {
  addMonths,
  formatClockTime,
  formatOccurrenceDate,
  formatOccurrenceShortDate,
  occurrencePreview,
  shiftedNote,
  shiftToWorkingDay,
} from "../occurrences"
import type { SchemeRecurrence } from "../recurrence"

// The prototype's holiday table (Copenhagen Central, Sep 2026 – Dec 2027) as
// a calendar with Mon–Fri working days — the regression fixture the
// redesign brief pins its values on.
const PROTOTYPE_HOLIDAYS = [
  "2026-12-24",
  "2026-12-25",
  "2026-12-26",
  "2026-12-31",
  "2027-01-01",
  "2027-03-25",
  "2027-03-26",
  "2027-03-29",
  "2027-05-06",
  "2027-05-17",
  "2027-06-05",
  "2027-12-24",
]

const calendar: CollectionCalendar = {
  id: "calendar-test",
  name: "Test 2026–2027",
  status: "Active",
  workingDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  holidayDates: PROTOTYPE_HOLIDAYS,
  validFrom: "",
  validTo: "",
}

const weekdays: SchemeRecurrence = {
  frequency: "weekly",
  serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  effectiveFrom: "2026-09-13",
  effectiveTo: "",
}

describe("occurrencePreview — prototype regression values", () => {
  const preview = occurrencePreview({ recurrence: weekdays, holidayPolicy: "shift-next", calendar })

  test("Mon–Fri weekly from 13 Sep 2026, shift-next, open-ended → 261 collections in 12 months", () => {
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

  test("24 and 25 Dec both shift to Mon 28 Dec", () => {
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

  test("Maundy Thursday, Good Friday, and Easter Monday 2027 shift to Tue 30 Mar", () => {
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

  test("rows are date-ordered and numbered without gaps", () => {
    const dates = preview.rows.map((row) => row.date)
    assert.deepEqual(dates, [...dates].sort())
    assert.deepEqual(
      preview.rows.map((row) => row.n),
      preview.rows.map((_, index) => index + 1),
    )
  })
})

describe("occurrencePreview — holiday policies", () => {
  test("skip keeps the row without a number", () => {
    const preview = occurrencePreview({ recurrence: weekdays, holidayPolicy: "skip", calendar })
    const skipped = preview.rows.find((row) => row.plannedDate === "2026-12-24")
    assert.ok(skipped)
    assert.equal(skipped.status, "skipped")
    assert.equal(skipped.n, null)
    assert.equal(skipped.note, "Christmas Eve")
    // 9 of the table's holidays fall on weekdays inside the window.
    assert.equal(preview.count, 261 - 9)
  })

  test("collect marks the row as a holiday and counts it", () => {
    const preview = occurrencePreview({ recurrence: weekdays, holidayPolicy: "collect", calendar })
    const row = preview.rows.find((row) => row.plannedDate === "2026-12-24")
    assert.ok(row)
    assert.equal(row.status, "holiday")
    assert.equal(row.date, "2026-12-24")
    assert.equal(preview.count, 261)
  })

  test("shift-prev moves Fri 25 Dec back to Wed 23 Dec (Thu 24 is a holiday)", () => {
    const preview = occurrencePreview({ recurrence: weekdays, holidayPolicy: "shift-prev", calendar })
    const row = preview.rows.find((row) => row.plannedDate === "2026-12-25")
    assert.ok(row)
    assert.equal(row.date, "2026-12-23")
  })

  test("calendar non-working days are always skipped", () => {
    const preview = occurrencePreview({
      recurrence: { ...weekdays, serviceDays: ["saturday"], effectiveTo: "2026-10-31" },
      holidayPolicy: "collect",
      calendar,
    })
    assert.ok(preview.rows.length > 0)
    assert.ok(preview.rows.every((row) => row.status === "skipped" && row.note === "Non-working day"))
    assert.equal(preview.count, 0)
  })

  test("without a calendar every recurrence date is planned", () => {
    const preview = occurrencePreview({
      recurrence: { ...weekdays, effectiveTo: "2026-09-30" },
      holidayPolicy: "shift-next",
      calendar: null,
    })
    assert.equal(preview.ongoing, false)
    assert.equal(preview.horizon, "2026-09-30")
    assert.equal(preview.count, 13)
    assert.ok(preview.rows.every((row) => row.status === "planned"))
  })
})

describe("occurrencePreview — window edge cases", () => {
  test("end before start yields no rows", () => {
    const preview = occurrencePreview({
      recurrence: { ...weekdays, effectiveTo: "2026-09-01" },
      holidayPolicy: "shift-next",
      calendar,
    })
    assert.equal(preview.rows.length, 0)
    assert.equal(preview.count, 0)
    assert.equal(preview.horizon, "2026-09-01")
  })

  test("no service days yields no rows", () => {
    const preview = occurrencePreview({
      recurrence: { ...weekdays, serviceDays: [] },
      holidayPolicy: "shift-next",
      calendar,
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
      calendar,
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
      calendar,
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
    assert.equal(addMonths("2027-01-31", 1), "2027-03-03")
  })

  test("formatters", () => {
    assert.equal(formatOccurrenceDate("2026-10-05"), "05 Oct 2026")
    assert.equal(formatOccurrenceShortDate("2026-12-24"), "Thu 24 Dec")
    assert.equal(formatClockTime("6:30"), "06:30")
    assert.equal(formatClockTime(""), "")
  })

  test("shiftToWorkingDay skips weekends when the calendar declares no working days", () => {
    const bare: CollectionCalendar = { ...calendar, workingDays: [] }
    assert.equal(shiftToWorkingDay(bare, "2026-12-25", 1), "2026-12-28")
    assert.equal(shiftToWorkingDay(null, "2026-09-18", 1), "2026-09-21")
  })
})
