import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { resolveProjectCalendar } from "@waste/domain/route-schemes/project-calendar"

import {
  HOLIDAY_LISTS_SETTINGS_PANE_ID,
  HOLIDAY_SETTINGS_HREF,
  holidaySettingsHref,
} from "../business-links"
import {
  FIXTURE_PROJECT_IDS,
  businessWorkspaces,
  type BusinessRecord,
} from "../business-modules"
import { CSV_BOM } from "../csv"
import {
  createHolidayListRecord,
  holidayListRowMatches,
  holidayListRows,
  holidayListsCsv,
  orderHolidayListRows,
  withProjectCalendar,
} from "../holiday-lists"

const organisation = businessWorkspaces.configure.modules.find(
  (module) => module.id === "organization",
)?.records
if (!organisation) throw new Error("the configure fixtures are missing")

const fixture = (records: readonly BusinessRecord[], id: string): BusinessRecord => {
  const record = records.find((candidate) => candidate.id === id)
  if (!record) throw new Error(`no fixture ${id}`)
  return record
}

describe("the pane's address", () => {
  test("the wizard and the scheme detail link to the pane, on the scheme's project when known", () => {
    assert.equal(holidaySettingsHref(), `/settings?pane=${HOLIDAY_LISTS_SETTINGS_PANE_ID}`)
    assert.equal(
      holidaySettingsHref(FIXTURE_PROJECT_IDS.cairo),
      `/settings?pane=${HOLIDAY_LISTS_SETTINGS_PANE_ID}&project=project-cairo`,
    )
    assert.equal(HOLIDAY_SETTINGS_HREF, holidaySettingsHref())
  })
})

describe("withProjectCalendar — the project record's list name and weekend", () => {
  const harbor = fixture(organisation, FIXTURE_PROJECT_IDS.harbor)

  test("writes the typed values resolveProjectCalendar reads and the facts beside them", () => {
    const written = withProjectCalendar(harbor, {
      holidayList: " Danish public holidays ",
      weekend: ["sunday", "saturday"],
    })
    assert.equal(written.submittedValues?.holidayList, "Danish public holidays")
    assert.equal(written.submittedValues?.weekend, "saturday, sunday")
    assert.equal(written.facts["Holiday list"], "Danish public holidays")
    assert.equal(written.facts.Weekend, "Sat–Sun")
    assert.equal(written.facts.Language, "Danish")
    assert.equal(written.updated, "Now")
    const calendar = resolveProjectCalendar(harbor.id, { projects: [written], calendars: [] })
    assert.equal(calendar.list?.name, "Danish public holidays")
    assert.deepEqual(calendar.weekend, ["saturday", "sunday"])
  })

  test("a blank name means no list: the value and the fact go, the weekend stays", () => {
    const copenhagen = fixture(organisation, FIXTURE_PROJECT_IDS.copenhagen)
    const written = withProjectCalendar(copenhagen, { holidayList: "  ", weekend: ["friday", "saturday"] })
    assert.equal("holidayList" in (written.submittedValues ?? {}), false)
    assert.equal("Holiday list" in written.facts, false)
    assert.equal(written.submittedValues?.weekend, "friday, saturday")
    assert.equal(written.facts.Weekend, "Fri–Sat")
    assert.equal(resolveProjectCalendar(copenhagen.id, { projects: [written], calendars: [] }).list, null)
    // The input is left as it was.
    assert.equal(copenhagen.submittedValues?.holidayList, "Danish public holidays")
  })
})

describe("the lists' table, laid out as the Routes table", () => {
  const danish = createHolidayListRecord(
    { country: "DK", name: "Danish public holidays" },
    [
      { date: "2026-12-25", name: "Christmas Day" },
      { date: "2026-12-26", name: "" },
    ],
    { actorName: "Olivia Larsen", now: 1 },
  )
  const egyptian = createHolidayListRecord({ country: "EG", name: "Egyptian public holidays" }, [{ date: "2026-01-07", name: "Coptic Christmas" }], {
    actorName: "Olivia Larsen",
    now: 2,
  })
  const projects = new Map([[danish.id, 0], [egyptian.id, 2]])
  const rows = holidayListRows([egyptian, danish], (list) => projects.get(list.id) ?? 0, "2026-12-01")
  const row = (name: string) => {
    const found = rows.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`no row ${name}`)
    return found
  }

  test("a row names its country, counts its holidays and projects, and reads the next holiday from today", () => {
    assert.deepEqual(
      { country: row("Danish public holidays").countryLabel, holidays: row("Danish public holidays").holidays, next: row("Danish public holidays").nextHoliday },
      { country: "Denmark", holidays: 2, next: "Fri 25 Dec · Christmas Day" },
    )
    assert.equal(row("Egyptian public holidays").nextHoliday, "—")
  })

  test("a list is in use while a project rests on it", () => {
    assert.equal(row("Egyptian public holidays").status, "In use")
    assert.equal(row("Danish public holidays").status, "Not in use")
  })

  test("the search reads the shown words, the country's name among them", () => {
    assert.deepEqual(rows.filter((candidate) => holidayListRowMatches(candidate, "denmark")).map((candidate) => candidate.name), ["Danish public holidays"])
    assert.equal(rows.filter((candidate) => holidayListRowMatches(candidate, "  ")).length, 2)
  })

  test("the rows order by name, or the lists in use first", () => {
    assert.deepEqual(orderHolidayListRows(rows, "name").map((candidate) => candidate.name), ["Danish public holidays", "Egyptian public holidays"])
    assert.deepEqual(orderHolidayListRows(rows, "status").map((candidate) => candidate.name), ["Egyptian public holidays", "Danish public holidays"])
  })

  test("the export is the rows by the columns shown", () => {
    const csv = holidayListsCsv(orderHolidayListRows(rows, "name"), { description: false, country: true, columns: ["Projects", "Holidays"] })
    assert.equal(
      csv,
      `${CSV_BOM}Holiday list,Country,Status,Holidays,Projects\r\nDanish public holidays,Denmark,Not in use,2,0\r\nEgyptian public holidays,Egypt,In use,1,2\r\n`,
    )
  })
})
