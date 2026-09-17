import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { egyptianHolidayName, holidayNamesFor } from "../holiday-names"
import { holidayListFromDates } from "../holidays"
import { generateOccurrences, occurrencePreview } from "../occurrences"
import {
  DEFAULT_WEEKEND,
  NO_HOLIDAY_LIST_LABEL,
  projectCalendarLabel,
  resolveProjectCalendar,
  schemeGenerationCalendar,
  weekendLabel,
} from "../project-calendar"
import { EGYPT_HOLIDAY_DATES, EGYPT_WEEKEND, calendarOf, sunToThu } from "./holiday-fixture"

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
// No holiday list on the project — its dated calendar is not a list.
const harbor = stub("project-harbor", "Harbor Commercial")
// A list named on the project whose per-year records are not there yet.
const aarhus = stub("project-aarhus", "Aarhus", {
  submittedValues: { holidayList: "Danish public holidays" },
})
const projects = [copenhagen, cairo, harbor, aarhus]
const calendars = [
  stub("cal-cairo", "Cairo Operations 2027", {
    projectIds: ["project-cairo"],
    submittedValues: { holidayDates: EGYPT_HOLIDAY_DATES.join(", ") },
  }),
  stub("cal-cph", "Copenhagen Central 2026", {
    projectIds: ["project-copenhagen"],
    submittedValues: { holidayDates: "2026-12-25, 2026-12-24" },
  }),
  stub("cal-harbor", "Harbor 2026", {
    projectIds: ["project-harbor"],
    submittedValues: { holidayDates: "2026-12-25" },
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
    assert.deepEqual(DEFAULT_WEEKEND, ["saturday", "sunday"])
    assert.deepEqual(resolveProjectCalendar("project-harbor", { projects, calendars }).weekend, [
      "saturday",
      "sunday",
    ])
    const unknown = resolveProjectCalendar("project-nowhere", { projects, calendars })
    assert.deepEqual(unknown.weekend, ["saturday", "sunday"])
    assert.equal(unknown.list, null)
  })

  test("the scheme's generation calendar carries its project's holidays and weekend", () => {
    const scheme = stub("s1", "Cairo scheme", { submittedValues: { projectId: "project-cairo" } })
    const calendar = schemeGenerationCalendar(scheme, { projects, calendars })
    assert.deepEqual(calendar.weekend, ["friday", "saturday"])
    assert.deepEqual([...calendar.holidays.keys()], EGYPT_HOLIDAY_DATES)
    const orphan = schemeGenerationCalendar(stub("s2", "No project"), { projects, calendars })
    assert.deepEqual(orphan.weekend, ["saturday", "sunday"])
    assert.equal(orphan.holidays.size, 0)
  })

  test("weekendLabel", () => {
    assert.equal(weekendLabel(["saturday", "sunday"]), "Sat–Sun")
    assert.equal(weekendLabel(["friday", "saturday"]), "Fri–Sat")
  })

  test("the list is the project's explicit holidayList attribute, named by it, dated by its calendars", () => {
    const cph = resolveProjectCalendar("project-copenhagen", { projects, calendars })
    assert.equal(cph.list?.name, "Danish public holidays")
    assert.deepEqual(
      [...(cph.list?.dates.entries() ?? [])],
      [
        ["2026-12-24", "Christmas Eve"],
        ["2026-12-25", "Christmas Day"],
      ],
    )
    assert.deepEqual(cph.list?.records.map((record) => record.id), ["cal-cph"])
    const egyptian = resolveProjectCalendar("project-cairo", { projects, calendars })
    assert.equal(egyptian.list?.name, "Egyptian public holidays")
    assert.equal(egyptian.list?.dates.get("2027-01-07"), "Coptic Christmas")
    assert.equal(egyptian.list?.dates.get("2027-03-08"), "Holiday")
  })

  test("no holidayList on the project means no list — dated calendars alone do not make one", () => {
    assert.equal(resolveProjectCalendar("project-harbor", { projects, calendars }).list, null)
    assert.equal(
      schemeGenerationCalendar(stub("s", "Harbor scheme", { projectIds: ["project-harbor"] }), {
        projects,
        calendars,
      }).holidays.size,
      0,
    )
  })

  test("a named list without per-year records is a list with no dates yet", () => {
    const list = resolveProjectCalendar("project-aarhus", { projects, calendars }).list
    assert.equal(list?.name, "Danish public holidays")
    assert.equal(list?.dates.size, 0)
    assert.deepEqual(list?.records, [])
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
