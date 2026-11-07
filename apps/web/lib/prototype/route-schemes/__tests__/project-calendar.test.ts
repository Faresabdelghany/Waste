import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import { egyptianHolidayName, holidayListFromDates, holidayNamesFor } from "@waste/domain/route-schemes/holiday-names"
import { generateOccurrences, occurrencePreview } from "@waste/domain/route-schemes/occurrences"
import {
  NO_HOLIDAY_LIST_LABEL,
  projectCalendarLabel,
  resolveProjectCalendar,
  weekendLabel,
} from "../project-calendar"
import { EGYPT_HOLIDAY_DATES, EGYPT_WEEKEND, calendarOf, sunToThu } from "./cairo-fixture"

const egypt = holidayListFromDates(EGYPT_HOLIDAY_DATES, egyptianHolidayName)
const cairoCalendar = calendarOf(egypt, EGYPT_WEEKEND)
const window = { from: "2026-09-13", to: "2027-09-13" }

describe("Cairo — Sun–Thu weekly from 13 Sep 2026 under a Fri–Sat weekend", () => {
  const generated = (holidayPolicy: "shift-next" | "shift-prev") =>
    generateOccurrences({ recurrence: sunToThu, window, holidayPolicy, calendar: cairoCalendar })
  const landing = (rows: ReturnType<typeof generateOccurrences>, plannedDate: string) =>
    rows.find((row) => row.plannedDate === plannedDate)?.date

  test("shift-next: a Thursday holiday lands on Sunday, not Monday", () => {
    assert.equal(landing(generated("shift-next"), "2027-01-07"), "2027-01-10")
  })

  test("shift-next: the remaining brief rows", () => {
    const rows = generated("shift-next")
    assert.equal(landing(rows, "2026-10-06"), "2026-10-07")
    assert.equal(landing(rows, "2027-01-25"), "2027-01-26")
    assert.equal(landing(rows, "2027-03-08"), "2027-03-10")
    assert.equal(landing(rows, "2027-03-09"), "2027-03-10")
    assert.equal(landing(rows, "2027-04-25"), "2027-04-26")
  })

  test("shift-prev: Thu 7 Jan → Wed 6 Jan; Mon 25 Jan → Sun 24 Jan (a working day in Egypt)", () => {
    const rows = generated("shift-prev")
    assert.equal(landing(rows, "2027-01-07"), "2027-01-06")
    assert.equal(landing(rows, "2027-01-25"), "2027-01-24")
  })

  test("262 collections in 12 months, none skipped", () => {
    const preview = occurrencePreview({
      recurrence: sunToThu,
      holidayPolicy: "shift-next",
      calendar: cairoCalendar,
    })
    assert.equal(preview.count, 262)
    assert.equal(preview.rows.filter((row) => row.status === "skipped").length, 0)
  })
})

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

const copenhagen = stub("project-copenhagen", "Copenhagen Central", {
  submittedValues: { weekend: "saturday, sunday", holidayList: "Danish public holidays" },
})
const cairo = stub("project-cairo", "Cairo Operations", {
  submittedValues: { weekend: "friday, saturday", holidayList: "Egyptian public holidays" },
})
// No holiday list on the project.
const harbor = stub("project-harbor", "Harbor Commercial")
// A list named on the project that no list record carries.
const aarhus = stub("project-aarhus", "Aarhus", {
  submittedValues: { holidayList: "Aarhus holidays" },
})
const projects = [copenhagen, cairo, harbor, aarhus]
/** A company's Holiday List record (2026-11-05), riding among the calendars. */
const listRecord = (id: string, name: string, country: string, values: Record<string, string> = {}) =>
  stub(id, name, { recordKind: "Holiday List", projectIds: [], submittedValues: { listName: name, country, ...values } })
const calendars = [
  listRecord("holiday-list-egyptian", "Egyptian public holidays", "EG", { holidayDates: EGYPT_HOLIDAY_DATES.join(", ") }),
  listRecord("holiday-list-danish", "Danish public holidays", "DK", { holidayDates: "2026-12-25, 2026-12-24" }),
  // A per-year calendar carries no holidays: dates left on one are read by nothing.
  stub("cal-harbor", "Harbor 2026", {
    projectIds: ["project-harbor"],
    submittedValues: { validFrom: "2026-01-01", holidayDates: "2026-12-25" },
  }),
  stub("cal-aarhus", "Aarhus 2026", {
    projectIds: ["project-aarhus"],
    submittedValues: { validFrom: "2026-01-01", holidayDates: "2026-12-25" },
  }),
]

describe("resolveProjectCalendar", () => {
  test("reads the project's weekend", () => {
    assert.deepEqual(resolveProjectCalendar("project-cairo", { projects, calendars }).weekend, [
      "friday",
      "saturday",
    ])
    assert.deepEqual(resolveProjectCalendar("project-copenhagen", { projects, calendars }).weekend, [
      "saturday",
      "sunday",
    ])
  })

  test("defaults to Sat–Sun only when the project has nothing set", () => {
    assert.deepEqual(resolveProjectCalendar("project-harbor", { projects, calendars }).weekend, [
      "saturday",
      "sunday",
    ])
    const unknown = resolveProjectCalendar("project-nowhere", { projects, calendars })
    assert.deepEqual(unknown.weekend, ["saturday", "sunday"])
    assert.equal(unknown.list, null)
  })

  test("weekendLabel", () => {
    assert.equal(weekendLabel(["saturday", "sunday"]), "Sat–Sun")
    assert.equal(weekendLabel(["friday", "saturday"]), "Fri–Sat")
  })

  test("the list is the project's explicit holidayList attribute, named by it, dated by the company's list of that name", () => {
    const cph = resolveProjectCalendar("project-copenhagen", { projects, calendars })
    assert.equal(cph.list?.name, "Danish public holidays")
    assert.deepEqual(
      [...(cph.list?.dates.entries() ?? [])],
      [
        ["2026-12-24", "Christmas Eve"],
        ["2026-12-25", "Christmas Day"],
      ],
    )
    assert.equal(cph.list?.listRecord?.id, "holiday-list-danish")
    const egyptian = resolveProjectCalendar("project-cairo", { projects, calendars })
    assert.equal(egyptian.list?.name, "Egyptian public holidays")
    assert.equal(egyptian.list?.dates.get("2027-01-07"), "Coptic Christmas")
    assert.equal(egyptian.list?.dates.get("2027-03-08"), "Holiday")
  })

  test("a name the list record carries wins over the list's lookup; the lookup names the rest", () => {
    const named = [
      ...calendars.filter((record) => record.id !== "holiday-list-egyptian"),
      listRecord("holiday-list-egyptian", "Egyptian public holidays", "EG", {
        holidayDates: [...EGYPT_HOLIDAY_DATES, "2028-02-26", "2028-01-07"].join(", "),
        holidayNames: JSON.stringify({ "2028-02-26": "Eid al-Fitr", "2028-01-07": "Coptic Christmas Day" }),
      }),
    ]
    const list = resolveProjectCalendar("project-cairo", { projects, calendars: named }).list
    assert.equal(list?.dates.get("2028-02-26"), "Eid al-Fitr")
    assert.equal(list?.dates.get("2028-01-07"), "Coptic Christmas Day")
    assert.equal(list?.dates.get("2027-01-07"), "Coptic Christmas")
    assert.equal(list?.dates.get("2027-03-08"), "Holiday")
  })

  test("no holidayList on the project means no list — a calendar's dates do not make one", () => {
    assert.equal(resolveProjectCalendar("project-harbor", { projects, calendars }).list, null)
  })

  test("a name no list record carries is a list with no dates, whatever the project's calendars say", () => {
    const named = resolveProjectCalendar("project-aarhus", { projects, calendars }).list
    assert.equal(named?.name, "Aarhus holidays")
    assert.equal(named?.dates.size, 0)
    assert.equal(named?.listRecord, undefined)
  })

  test("projectCalendarLabel — the step 2 field and the review row", () => {
    assert.equal(
      projectCalendarLabel(resolveProjectCalendar("project-copenhagen", { projects, calendars })),
      "Danish public holidays · Sat–Sun weekend",
    )
    assert.equal(
      projectCalendarLabel(resolveProjectCalendar("project-cairo", { projects, calendars })),
      "Egyptian public holidays · Fri–Sat weekend",
    )
    assert.equal(NO_HOLIDAY_LIST_LABEL, "None on this project")
    assert.equal(
      projectCalendarLabel(resolveProjectCalendar("project-harbor", { projects, calendars })),
      "None on this project · Sat–Sun weekend",
    )
  })
})

describe("holiday names follow the list", () => {
  test("Egyptian fixed-date names; lunar Eid dates read Holiday", () => {
    assert.equal(egyptianHolidayName("2026-10-06"), "Armed Forces Day")
    assert.equal(egyptianHolidayName("2027-01-07"), "Coptic Christmas")
    assert.equal(egyptianHolidayName("2027-01-25"), "Revolution Day")
    assert.equal(egyptianHolidayName("2027-04-25"), "Sinai Liberation Day")
    assert.equal(egyptianHolidayName("2027-03-08"), undefined)
  })

  test("holidayNamesFor picks the lookup by list name; an unknown list names nothing", () => {
    assert.equal(holidayNamesFor("Danish public holidays")("2026-12-24"), "Christmas Eve")
    assert.equal(holidayNamesFor("Egyptian public holidays")("2026-10-06"), "Armed Forces Day")
    assert.equal(holidayNamesFor("Somewhere else")("2026-12-24"), undefined)
    assert.equal(holidayListFromDates(["2026-12-24"], holidayNamesFor("Somewhere else")).get("2026-12-24"), "Holiday")
  })
})
