import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { danishHolidayName, egyptianHolidayName, holidayNamesFor } from "../holiday-names"
import {
  calendarHolidayEntries,
  calendarYear,
  carryHolidaysToYear,
  firstYearProposal,
  holidayEntryIssue,
  holidayEntryValues,
  knownHolidaysOfYear,
  latestHolidayCalendar,
  nextYearProposal,
} from "../holiday-lists"

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

// The fixture records of Copenhagen Central: 2026 as seeded (dates only), and
// the 2027 dates the seed spells by hand — the ground truth for "Create next
// year".
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

const copenhagen2026 = stub("calendar-central", "Copenhagen Central 2026", {
  projectIds: ["project-copenhagen"],
  submittedValues: {
    calendarName: "Copenhagen Central 2026",
    holidayDates: CPH_2026,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  },
})

describe("calendarHolidayEntries — the dates a record carries, each with its name", () => {
  test("a record without carried names is named through the list's lookup; an unknown date is unnamed", () => {
    const entries = calendarHolidayEntries(
      stub("c", "Cairo 2027", {
        submittedValues: { holidayDates: "2027-03-08, 2027-01-07" },
      }),
      egyptianHolidayName,
    )
    assert.deepEqual(entries, [
      { date: "2027-01-07", name: "Coptic Christmas" },
      { date: "2027-03-08", name: "" },
    ])
  })

  test("a name the record carries wins over the lookup", () => {
    const entries = calendarHolidayEntries(
      stub("c", "Cairo 2027", {
        submittedValues: {
          holidayDates: "2027-03-08, 2027-01-07",
          holidayNames: JSON.stringify({
            "2027-03-08": "Eid al-Fitr",
            "2027-01-07": "Coptic Christmas (carried)",
          }),
        },
      }),
      egyptianHolidayName,
    )
    assert.deepEqual(entries, [
      { date: "2027-01-07", name: "Coptic Christmas (carried)" },
      { date: "2027-03-08", name: "Eid al-Fitr" },
    ])
  })

  test("a record with no structured values has no entries", () => {
    assert.deepEqual(calendarHolidayEntries(stub("c", "Display only"), danishHolidayName), [])
    assert.deepEqual(calendarHolidayEntries(undefined, danishHolidayName), [])
  })
})

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

  test("the values round-trip through the entry reader", () => {
    const entries = [
      { date: "2027-01-01", name: "New Year's Day" },
      { date: "2027-03-08", name: "Eid al-Fitr" },
    ]
    const record = stub("c", "Cairo 2027", { submittedValues: holidayEntryValues(entries) })
    assert.deepEqual(calendarHolidayEntries(record, () => undefined), entries)
  })
})

describe("carryHolidaysToYear — next year's list from this year's", () => {
  test("Copenhagen Central 2026 carried to 2027 is exactly the seeded 2027 record", () => {
    const carried = carryHolidaysToYear(
      calendarHolidayEntries(copenhagen2026, danishHolidayName),
      2027,
      danishHolidayName,
    )
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

describe("calendarYear and the proposals", () => {
  test("the year is the validity start's, else the first holiday's, else none", () => {
    assert.equal(calendarYear(copenhagen2026), 2026)
    assert.equal(
      calendarYear(
        stub("c", "Dates only", { submittedValues: { holidayDates: "2027-12-25, 2027-01-01" } }),
      ),
      2027,
    )
    assert.equal(calendarYear(stub("c", "Display only")), undefined)
  })

  test("latestHolidayCalendar is the record of the latest year, a later start winning inside one year", () => {
    const later = stub("cal-2027", "Copenhagen Central 2027", {
      submittedValues: { holidayDates: "2027-01-01", validFrom: "2027-01-01", validTo: "2027-12-31" },
    })
    const autumn = stub("cal-2027-autumn", "Autumn 2027", {
      submittedValues: { validFrom: "2027-09-01", validTo: "2027-12-31" },
    })
    assert.equal(latestHolidayCalendar([copenhagen2026, autumn, later])?.id, "cal-2027-autumn")
    assert.equal(latestHolidayCalendar([copenhagen2026, later])?.id, "cal-2027")
    assert.equal(latestHolidayCalendar([stub("c", "Display only")]), undefined)
    assert.equal(latestHolidayCalendar([]), undefined)
  })

  test("nextYearProposal renames the record by year, covers the whole year and carries the holidays", () => {
    const proposal = nextYearProposal(copenhagen2026, danishHolidayName)
    assert.equal(proposal?.year, 2027)
    assert.equal(proposal?.calendarName, "Copenhagen Central 2027")
    assert.equal(proposal?.validFrom, "2027-01-01")
    assert.equal(proposal?.validTo, "2027-12-31")
    assert.deepEqual(proposal?.entries.map((entry) => entry.date), CPH_2027)
  })

  test("a partial year becomes a whole next year; a name without the year gets it appended", () => {
    const cairo = stub("calendar-cairo-2026", "Cairo Operations", {
      submittedValues: {
        holidayDates: "2026-10-06",
        validFrom: "2026-09-01",
        validTo: "2026-12-31",
      },
    })
    const proposal = nextYearProposal(cairo, egyptianHolidayName)
    assert.equal(proposal?.calendarName, "Cairo Operations 2027")
    assert.equal(proposal?.validFrom, "2027-01-01")
    assert.equal(proposal?.validTo, "2027-12-31")
    assert.deepEqual(proposal?.entries, [{ date: "2027-10-06", name: "Armed Forces Day" }])
  })

  test("a record with no year has no proposal", () => {
    assert.equal(nextYearProposal(stub("c", "Display only"), danishHolidayName), null)
  })

  test("firstYearProposal names the record after the project and starts from what the list knows", () => {
    const proposal = firstYearProposal("Aarhus", 2027, danishHolidayName)
    assert.equal(proposal.year, 2027)
    assert.equal(proposal.calendarName, "Aarhus 2027")
    assert.equal(proposal.validFrom, "2027-01-01")
    assert.equal(proposal.validTo, "2027-12-31")
    assert.equal(proposal.entries.length, 13)
    assert.deepEqual(
      firstYearProposal("Harbor Commercial", 2027, holidayNamesFor(undefined)).entries,
      [],
    )
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
