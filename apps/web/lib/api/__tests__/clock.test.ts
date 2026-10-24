// The project's clock (lib/api/records/clock.ts): an instant shown as a
// person in the project reads it, whatever the browser's own timezone, so
// two screens of one flow never read two clocks (#255).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { dayAndTimeOn, shownOn, timeOn } from "../records/clock"

const ASKED = "2026-10-24T02:32:07.421Z"

describe("an instant on the project's clock", () => {
  test("reads as its day and time in the project's timezone, not the browser's: a list's short form", () => {
    assert.equal(dayAndTimeOn(ASKED, "Europe/Copenhagen"), "24 Oct, 04:32")
    assert.equal(dayAndTimeOn(ASKED, "Africa/Cairo"), "24 Oct, 05:32", "the same instant, another project's clock")
    assert.equal(dayAndTimeOn("2026-10-23T22:30:00Z", "Europe/Copenhagen"), "24 Oct, 00:30", "past midnight in the project, the project's day")
  })

  test("its time of day alone, on the same clock", () => {
    assert.equal(timeOn(ASKED, "Europe/Copenhagen"), "04:32")
    assert.equal(timeOn(ASKED, "Africa/Cairo"), "05:32")
  })

  test("agrees with the details' long form, which already reads the project's clock", () => {
    assert.equal(shownOn(ASKED, "Europe/Copenhagen"), "2026-10-24 04:32")
    assert.ok(dayAndTimeOn(ASKED, "Europe/Copenhagen").endsWith(timeOn(ASKED, "Europe/Copenhagen")))
  })

  test("a project the store does not hold, or a zone Intl does not know, falls back on the browser's clock rather than throwing", () => {
    const browser = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(ASKED))
    assert.equal(timeOn(ASKED, undefined), browser)
    assert.equal(timeOn(ASKED, "Mars/Olympus_Mons"), browser)
    assert.match(dayAndTimeOn(ASKED, undefined), /^\d{1,2} Oct, \d{2}:\d{2}$/)
  })
})
