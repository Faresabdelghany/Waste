import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { formatDateRange, formatLongDate, formatShortDate } from "../dates"

describe("dates", () => {
  test("long dates and ranges read like the product", () => {
    assert.equal(formatLongDate("2026-09-16"), "September 16, 2026")
    assert.equal(
      formatDateRange({ from: "2026-09-16", to: "2026-09-22" }),
      "September 16, 2026 – September 22, 2026",
    )
    assert.equal(formatDateRange({ from: "2026-09-16", to: "2026-09-16" }), "September 16, 2026")
  })
})

describe("formatShortDate", () => {
  test("reads like the registry facts", () => {
    assert.equal(formatShortDate("2026-09-18"), "18 Sep 2026")
  })
})
