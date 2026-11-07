import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CSV_BOM } from "../csv"
import {
  createHolidayListRecord,
  holidayListRowMatches,
  holidayListRows,
  holidayListsCsv,
  orderHolidayListRows,
} from "../holiday-lists"

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
