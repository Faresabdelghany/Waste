import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { fold, icsOf } from "../ical"

const NOW = new Date("2026-10-24T09:15:30.000Z")

describe("icsOf", () => {
  test("a feed of all-day events, CRLF-terminated, with a stable UID, the date and the next day, the summary and the stamp in UTC", () => {
    const feed = icsOf({
      name: "Kystbyen · Parkvej 1",
      timezone: "Europe/Copenhagen",
      now: NOW,
      events: [{ uid: "g-glass|2026-10-08@kystbyen", date: "2026-10-08", summary: "Glass, Metal", description: null, cancelled: false, sequence: 0 }],
    })
    assert.ok(feed.endsWith("\r\n"))
    assert.equal(feed.split("\r\n").filter((line) => line !== "").length, feed.split("\n").filter((line) => line !== "").length, "every line ends CRLF")
    const lines = feed.split("\r\n")
    for (const expected of [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "X-WR-CALNAME:Kystbyen · Parkvej 1",
      "X-WR-TIMEZONE:Europe/Copenhagen",
      "UID:g-glass|2026-10-08@kystbyen",
      "DTSTAMP:20261024T091530Z",
      "SEQUENCE:0",
      "DTSTART;VALUE=DATE:20261008",
      "DTEND;VALUE=DATE:20261009",
      "SUMMARY:Glass\\, Metal",
      "TRANSP:TRANSPARENT",
      "END:VCALENDAR",
    ]) {
      assert.ok(lines.includes(expected), expected)
    }
    assert.equal(lines.filter((line) => line === "BEGIN:VEVENT").length, 1)
    assert.ok(!feed.includes("DESCRIPTION"), "no description where none is given")
  })

  test("a skipped day is a cancelled event with its reason; text is escaped; a month's last day ends on the next month's first", () => {
    const feed = icsOf({
      name: "A; B",
      timezone: "UTC",
      now: NOW,
      events: [{ uid: "u", date: "2026-12-31", summary: "No collection: Residual", description: "Skipped · Nytårsdag\nsee you, next week", cancelled: true, sequence: 1 }],
    })
    const lines = feed.split("\r\n")
    assert.ok(lines.includes("X-WR-CALNAME:A\\; B"))
    assert.ok(lines.includes("STATUS:CANCELLED"))
    assert.ok(lines.includes("SEQUENCE:1"))
    assert.ok(lines.includes("DTEND;VALUE=DATE:20270101"))
    assert.ok(lines.includes("DESCRIPTION:Skipped · Nytårsdag\\nsee you\\, next week"))
  })
})

describe("fold", () => {
  test("leaves a short line alone and folds a long one at 75 octets, never inside a character, continuations starting with a space", () => {
    assert.equal(fold("SUMMARY:short"), "SUMMARY:short")
    const long = `DESCRIPTION:${"æ".repeat(60)}`
    const folded = fold(long)
    const parts = folded.split("\r\n")
    assert.ok(parts.length > 1)
    const octets = (text: string) => new TextEncoder().encode(text).length
    assert.ok(octets(parts[0] ?? "") <= 75)
    for (const part of parts.slice(1)) {
      assert.ok(part.startsWith(" "))
      assert.ok(octets(part) <= 75)
    }
    assert.equal(parts.map((part, index) => (index === 0 ? part : part.slice(1))).join(""), long)
  })
})
