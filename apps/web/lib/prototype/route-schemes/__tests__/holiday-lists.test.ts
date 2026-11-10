import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { danishHolidayName, egyptianHolidayName, holidayNamesFor } from "@waste/domain/planning/holiday-names"
import { holidayListEntries } from "../holiday-list-records"
import { carryHolidaysToYear, holidayEntryIssue, holidayEntryValues, knownHolidaysOfYear } from "../holiday-lists"

function stub(id: string, name: string, extra: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id,
    name,
    context: "",
    status: "Active",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {},
    related: [],
    source: "",
    freshness: "",
    allowedTransitions: [],
    ...extra,
  }
}

// The Danish list's days of 2026 as seeded, and the 2027 days the seed spells
// by hand — the ground truth for "Copy to 2027".
const CPH_2026 =
  "2026-01-01, 2026-04-02, 2026-04-03, 2026-04-05, 2026-04-06, 2026-05-14, 2026-05-24, 2026-05-25, 2026-06-05, 2026-12-25, 2026-12-26"
const CPH_2027 = [
  "2027-01-01",
  "2027-03-25",
  "2027-03-26",
  "2027-03-28",
  "2027-03-29",
  "2027-05-06",
  "2027-05-16",
  "2027-05-17",
  "2027-06-05",
  "2027-12-25",
  "2027-12-26",
]

const copenhagen2026 = CPH_2026.split(", ").map((date) => ({ date, name: danishHolidayName(date) ?? "" }))

describe("holidayEntryValues — what the editor writes back", () => {
  test("dates sorted and deduplicated in the record's own spelling; names only where one was given", () => {
    assert.deepEqual(
      holidayEntryValues([
        { date: "2027-12-25", name: "Christmas Day" },
        { date: "2027-01-01", name: "  New Year's Day " },
        { date: "2027-03-08", name: "" },
        { date: "2027-01-01", name: "Duplicate" },
      ]),
      {
        holidayDates: "2027-01-01, 2027-03-08, 2027-12-25",
        holidayNames: JSON.stringify({
          "2027-01-01": "New Year's Day",
          "2027-12-25": "Christmas Day",
        }),
      },
    )
  })

  test("an empty list writes blank values, which the record readers treat as absent", () => {
    assert.deepEqual(holidayEntryValues([]), { holidayDates: "", holidayNames: "" })
    assert.deepEqual(holidayEntryValues([{ date: "2027-01-01", name: "" }]), {
      holidayDates: "2027-01-01",
      holidayNames: "",
    })
  })

  test("the values round-trip through a list record's entry reader", () => {
    const entries = [
      { date: "2027-01-01", name: "New Year's Day" },
      { date: "2027-03-08", name: "Eid al-Fitr" },
    ]
    const { holidayDates, holidayNames } = holidayEntryValues(entries)
    const record = stub("holiday-list-x", "A list", { recordKind: "Holiday List", submittedValues: { listName: "A list", holidayDates, holidayNames } })
    assert.deepEqual(holidayListEntries(record), entries)
  })
})

describe("carryHolidaysToYear — next year's list from this year's", () => {
  test("the Danish list's 2026 carried to 2027 is exactly the seeded 2027 days", () => {
    const carried = carryHolidaysToYear(copenhagen2026, 2027, danishHolidayName)
    assert.deepEqual(
      carried.map((entry) => entry.date),
      CPH_2027,
    )
    assert.equal(carried.find((entry) => entry.date === "2027-03-25")?.name, "Maundy Thursday")
    assert.equal(carried.find((entry) => entry.date === "2027-05-06")?.name, "Ascension Day")
  })

  test("a fixed-date holiday keeps its day; two holidays of one name both land", () => {
    const carried = carryHolidaysToYear(
      [
        { date: "2026-01-25", name: "Revolution Day" },
        { date: "2026-07-23", name: "Revolution Day" },
        { date: "2026-10-06", name: "Armed Forces Day" },
      ],
      2027,
      egyptianHolidayName,
    )
    assert.deepEqual(carried, [
      { date: "2027-01-25", name: "Revolution Day" },
      { date: "2027-07-23", name: "Revolution Day" },
      { date: "2027-10-06", name: "Armed Forces Day" },
    ])
  })

  test("a holiday the list cannot place keeps its month and day for the person to correct", () => {
    const carried = carryHolidaysToYear(
      [
        { date: "2027-03-08", name: "Eid al-Fitr" },
        { date: "2027-08-15", name: "Company day" },
        { date: "2027-03-09", name: "" },
      ],
      2028,
      egyptianHolidayName,
    )
    assert.deepEqual(carried, [
      { date: "2028-03-08", name: "Eid al-Fitr" },
      { date: "2028-03-09", name: "" },
      { date: "2028-08-15", name: "Company day" },
    ])
  })

  test("a day the next year does not have is dropped, and one date is one entry", () => {
    const carried = carryHolidaysToYear(
      [
        { date: "2028-02-29", name: "Leap day" },
        { date: "2028-04-13", name: "Maundy Thursday" },
        { date: "2028-04-12", name: "Maundy Thursday" },
      ],
      2029,
      danishHolidayName,
    )
    assert.deepEqual(carried, [{ date: "2029-03-29", name: "Maundy Thursday" }])
  })
})

describe("knownHolidaysOfYear — a first year from the list alone", () => {
  test("every date the list names in the year, in order", () => {
    const known = knownHolidaysOfYear(2027, danishHolidayName)
    assert.equal(known.length, 13)
    assert.deepEqual(known[0], { date: "2027-01-01", name: "New Year's Day" })
    assert.deepEqual(known[known.length - 1], { date: "2027-12-31", name: "New Year's Eve" })
    assert.ok(known.some((entry) => entry.date === "2027-03-28" && entry.name === "Easter Sunday"))
  })

  test("a list that names nothing gives an empty year", () => {
    assert.deepEqual(knownHolidaysOfYear(2027, holidayNamesFor("Somewhere else")), [])
  })
})

describe("holidayEntryIssue — what the editor refuses, in a sentence", () => {
  const entries = [{ date: "2026-12-25", name: "Christmas Day" }]
  const validity = { validFrom: "2026-01-01", validTo: "2026-12-31" }

  test("a date that is not on the calendar", () => {
    assert.equal(holidayEntryIssue(entries, "2026-02-30", validity), "Enter a date as yyyy-mm-dd.")
    assert.equal(holidayEntryIssue(entries, "", validity), "Enter a date as yyyy-mm-dd.")
  })

  test("a date already on the list — unless it is the entry being edited", () => {
    assert.equal(
      holidayEntryIssue(entries, "2026-12-25", validity),
      "This date is already on the list.",
    )
    assert.equal(holidayEntryIssue(entries, "2026-12-25", validity, "2026-12-25"), null)
  })

  test("a date outside the list's validity, naming the period", () => {
    assert.equal(
      holidayEntryIssue(entries, "2027-01-01", validity),
      "This list covers 1 Jan – 31 Dec 2026.",
    )
    assert.equal(
      holidayEntryIssue(entries, "2025-12-31", { validFrom: "2026-01-01", validTo: "" }),
      "This list runs from 1 Jan 2026.",
    )
    assert.equal(holidayEntryIssue(entries, "2027-01-01", { validFrom: "", validTo: "" }), null)
    assert.equal(holidayEntryIssue(entries, "2027-01-01", null), null)
  })

  test("a good date passes", () => {
    assert.equal(holidayEntryIssue(entries, "2026-06-05", validity), null)
  })
})
