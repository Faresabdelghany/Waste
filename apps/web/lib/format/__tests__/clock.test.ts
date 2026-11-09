// The project's clock (lib/format/clock.ts): an instant shown as a
// person in the project reads it, whatever the browser's own timezone, so
// two screens of one flow never read two clocks (#255).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { dayAndTimeOn, dayIn, instantOn, shownOn, timeOn, wallClockIn } from "../clock"

const ASKED = "2026-10-24T02:32:07.421Z"

describe("an instant on the project's clock", () => {
  test("reads as its day and time in the project's timezone, not the browser's: a list's short form", () => {
    assert.equal(dayAndTimeOn(ASKED, "Europe/Copenhagen"), "24 Oct, 04:32")
    assert.equal(dayAndTimeOn(ASKED, "Africa/Cairo"), "24 Oct, 05:32", "the same instant, another project's clock")
    assert.equal(dayAndTimeOn("2026-10-23T22:30:00Z", "Europe/Copenhagen"), "24 Oct, 00:30", "past midnight in the project, the project's day")
  })

  test("spells September as Sep, whatever the runtime's ICU would", () => {
    assert.equal(dayAndTimeOn("2026-09-24T02:32:07.421Z", "Europe/Copenhagen"), "24 Sep, 04:32")
  })

  test("its time of day alone, on the same clock", () => {
    assert.equal(timeOn(ASKED, "Europe/Copenhagen"), "04:32")
    assert.equal(timeOn(ASKED, "Africa/Cairo"), "05:32")
  })

  test("agrees with the details' long form, which already reads the project's clock", () => {
    assert.equal(shownOn(ASKED, "Europe/Copenhagen"), "2026-10-24 04:32")
    assert.ok(dayAndTimeOn(ASKED, "Europe/Copenhagen").endsWith(timeOn(ASKED, "Europe/Copenhagen")))
  })

  test("today is the project's day, in the project's timezone", () => {
    const lateEvening = new Date("2026-09-30T22:30:00Z") // 00:30 on 1 October in Copenhagen
    assert.equal(dayIn(lateEvening, "Europe/Copenhagen"), "2026-10-01")
    assert.equal(dayIn(new Date("2026-09-30T21:30:00Z"), "Europe/Copenhagen"), "2026-09-30")
    assert.equal(dayIn(lateEvening, "America/New_York"), "2026-09-30")
  })

  test("a form's wall-clock time is the instant it reads on the project's clock, and back, across a clock change", () => {
    assert.equal(instantOn("2026-07-01T05:30", "Europe/Copenhagen"), "2026-07-01T03:30:00.000Z")
    assert.equal(instantOn("2026-12-01T05:30", "Europe/Copenhagen"), "2026-12-01T04:30:00.000Z")
    assert.equal(instantOn("2026-03-29T07:00", "Europe/Copenhagen"), "2026-03-29T05:00:00.000Z", "the morning the clocks go forward is summer time")
    assert.equal(instantOn("2026-07-01T05:30:00Z", "Europe/Copenhagen"), "2026-07-01T05:30:00.000Z", "an instant with its own offset stands")
    assert.equal(wallClockIn("2026-07-01T03:30:00.000Z", "Europe/Copenhagen"), "2026-07-01T05:30")
  })

  test("a project the store does not hold, or a zone Intl does not know, falls back on the browser's clock rather than throwing", () => {
    const browser = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(ASKED))
    assert.equal(timeOn(ASKED, undefined), browser)
    assert.equal(timeOn(ASKED, "Mars/Olympus_Mons"), browser)
    assert.match(dayAndTimeOn(ASKED, undefined), /^\d{1,2} Oct, \d{2}:\d{2}$/)
    const at = new Date(ASKED)
    const browserDay = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
    assert.equal(dayIn(at, undefined), browserDay)
    assert.equal(dayIn(at, "Mars/Olympus_Mons"), browserDay)
  })
})
