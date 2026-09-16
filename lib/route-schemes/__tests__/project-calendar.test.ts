import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { holidayListFromDates } from "../holidays"
import { generateOccurrences, occurrencePreview } from "../occurrences"
import {
  DEFAULT_WEEKEND,
  resolveProjectCalendar,
  schemeGenerationCalendar,
  weekendLabel,
} from "../project-calendar"
import { EGYPT_HOLIDAY_DATES, EGYPT_WEEKEND, calendarOf, sunToThu } from "./holiday-fixture"

const egypt = holidayListFromDates(EGYPT_HOLIDAY_DATES)
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
  submittedValues: { weekend: "saturday, sunday" },
})
const cairo = stub("project-cairo", "Cairo Operations", {
  submittedValues: { weekend: "friday, saturday" },
})
const harbor = stub("project-harbor", "Harbor Commercial")
const projects = [copenhagen, cairo, harbor]
const calendars = [
  stub("cal-cairo", "Cairo Operations 2027", {
    projectIds: ["project-cairo"],
    submittedValues: { holidayDates: EGYPT_HOLIDAY_DATES.join(", ") },
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
})
