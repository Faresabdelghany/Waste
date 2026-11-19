import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../business-modules"
import { noWindowSentence, offersTimeline, timeWindowOf } from "../time-window"

const row = (value: string, facts: Record<string, string> = {}): BusinessRecord =>
  ({ id: `row-${value}`, name: value, context: "", status: "Active", value, facts }) as unknown as BusinessRecord

describe("timeWindowOf", () => {
  test("reads the first HH:MM–HH:MM of the value or the facts", () => {
    assert.deepEqual(timeWindowOf(row("07:00–15:30")), { startMinutes: 420, endMinutes: 930, label: "07:00–15:30" })
    assert.deepEqual(timeWindowOf(row("", { "Opening hours": "Mon–Fri 6:00-20:00" }))?.startMinutes, 360)
  })

  test("a lone time, a date or a window ending before it starts is none", () => {
    assert.equal(timeWindowOf(row("", { "Planned start": "07:00", "Service date": "2026-11-19" })), null)
    assert.equal(timeWindowOf(row("18:00–06:00")), null)
  })
})

describe("offersTimeline (#657)", () => {
  test("a list of routes as the API serves them, a planned start and no window, offers no Timeline", () => {
    assert.equal(offersTimeline([row("Planned", { "Planned start": "07:00", "Service date": "2026-11-19" })]), false)
    assert.equal(offersTimeline([]), false)
  })

  test("one row with a window is enough", () => {
    assert.equal(offersTimeline([row("Planned"), row("", { "Opening hours": "Mon–Fri 06:00–20:00" })]), true)
  })

  test("the empty Timeline blames the filters only when some are set", () => {
    assert.equal(noWindowSentence(true), "No records with a time window match the current filters.")
    assert.equal(noWindowSentence(false), "No record here has a time window.")
  })
})
