import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Id } from "@waste/contracts/ids"
import { ADDRESS_SEARCH_MAX, ADDRESS_SEARCH_MIN, COLLECTION_WEEKS, type PublicCollectionDay } from "@waste/contracts/public"

import {
  ADDRESS_SEARCH,
  addressQueryOf,
  askable,
  calendarHrefOf,
  datesOf,
  dayLabelOf,
  feedPathOf,
  feedResponseOf,
  feedUrlsOf,
  isAddressId,
  monthLabelOf,
  monthsOf,
  nextDatesOf,
  searchPageViewOf,
  WEEKS,
  weeksOf,
} from "../collection-days"

const day = (date: string, fractions: string[], status: "collected" | "skipped" = "collected"): PublicCollectionDay => ({ date, serviceDate: date, fractions, status, note: null })
const project = { slug: "kystbyen", name: "Kystbyen", language: "da", timezone: "Europe/Copenhagen" }

describe("the calendar's bounds", () => {
  test("are the contracts', spelled again: the web imports them as types only", () => {
    assert.deepEqual([ADDRESS_SEARCH.min, ADDRESS_SEARCH.max], [ADDRESS_SEARCH_MIN, ADDRESS_SEARCH_MAX])
    assert.deepEqual([WEEKS.default, WEEKS.max], [COLLECTION_WEEKS.default, COLLECTION_WEEKS.max])
  })
})

describe("addressQueryOf, askable and weeksOf", () => {
  test("an address search is the first q, trimmed and cut to the door's length; blank is none", () => {
    assert.equal(addressQueryOf("  Strand "), "Strand")
    assert.equal(addressQueryOf(["Øster", "x"]), "Øster")
    assert.equal(addressQueryOf("   "), null)
    assert.equal(addressQueryOf(undefined), null)
    assert.equal(addressQueryOf("a".repeat(150))?.length, 100)
  })

  test("the door is asked from three characters", () => {
    assert.equal(askable("Str"), true)
    assert.equal(askable("St"), false)
    assert.equal(askable(null), false)
  })

  test("weeks are 1..26, eight for none or nonsense, and cut at 26", () => {
    assert.equal(weeksOf(undefined), 8)
    assert.equal(weeksOf("12"), 12)
    assert.equal(weeksOf(["4", "26"]), 4)
    assert.equal(weeksOf("90"), 26)
    assert.equal(weeksOf("0"), 8)
    assert.equal(weeksOf("2.5"), 8)
    assert.equal(weeksOf("x"), 8)
  })
})

describe("isAddressId", () => {
  test("an address in the path is an id exactly as the door takes one, a UUIDv7", () => {
    const candidates = [
      "01a0d2a4-a280-700c-8000-00000000000b",
      "01A0D2A4-A280-700C-8000-00000000000B",
      "00000000-0000-4000-8000-000000000000",
      "01a0d2a4-a280-700c-c000-00000000000b",
      "01a0d2a4-a280-700c-8000-00000000000",
      "strandboulevarden-52",
    ]
    assert.deepEqual(
      candidates.map(isAddressId),
      candidates.map((candidate) => Id.safeParse(candidate).success),
    )
    assert.deepEqual(candidates.map(isAddressId), [true, true, false, false, false, false])
  })
})

describe("searchPageViewOf", () => {
  const ok = <T>(body: T) => ({ kind: "ok" as const, body })
  const addresses = [{ id: "a1", address: "Strandboulevarden 52" }]

  test("no query prompts and a short one says so, from the project alone; a search shows its addresses, or says it found none, under the project its answer names", () => {
    assert.deepEqual(searchPageViewOf({ asked: "project", query: null, answer: ok(project) }), { kind: "published", project, search: { kind: "prompt" } })
    assert.deepEqual(searchPageViewOf({ asked: "project", query: "St", answer: ok(project) }), { kind: "published", project, search: { kind: "too-short", query: "St" } })
    assert.deepEqual(searchPageViewOf({ asked: "search", query: "Strand", answer: ok({ project, addresses }) }), { kind: "published", project, search: { kind: "matches", query: "Strand", addresses } })
    assert.deepEqual(searchPageViewOf({ asked: "search", query: "Nowhere", answer: ok({ project, addresses: [] }) }), { kind: "published", project, search: { kind: "nothing", query: "Nowhere" } })
  })

  test("the rule is the view's own: a short query is too short whatever was asked, and an askable one not searched for has nothing to show", () => {
    assert.deepEqual(searchPageViewOf({ asked: "search", query: "St", answer: ok({ project, addresses }) }), { kind: "published", project, search: { kind: "too-short", query: "St" } })
    assert.deepEqual(searchPageViewOf({ asked: "project", query: "Strand", answer: ok(project) }), { kind: "unavailable" })
  })

  test("the door's refusal is the page's", () => {
    assert.deepEqual(searchPageViewOf({ asked: "search", query: "Strand", answer: { kind: "not-published" } }), { kind: "not-published" })
    assert.deepEqual(searchPageViewOf({ asked: "project", query: null, answer: { kind: "too-many", retryAfterSeconds: 9 } }), { kind: "too-many", retryAfterSeconds: 9 })
    assert.deepEqual(searchPageViewOf({ asked: "search", query: "Strand", answer: { kind: "unavailable" } }), { kind: "unavailable" })
  })
})

describe("datesOf and monthsOf", () => {
  test("one entry per date, then the dates by month, in order", () => {
    const days = [day("2026-10-29", ["Residual"]), day("2026-10-29", ["Glass"]), day("2026-10-30", ["Paper"]), day("2026-11-03", ["Paper"], "skipped")]
    assert.deepEqual(
      datesOf(days).map((date) => [date.date, date.collections.length]),
      [
        ["2026-10-29", 2],
        ["2026-10-30", 1],
        ["2026-11-03", 1],
      ],
    )
    assert.deepEqual(
      monthsOf(days).map((month) => [month.month, month.dates.map((date) => date.date)]),
      [
        ["2026-10", ["2026-10-29", "2026-10-30"]],
        ["2026-11", ["2026-11-03"]],
      ],
    )
    assert.deepEqual(monthsOf([]), [])
  })
})

describe("nextDatesOf", () => {
  test("counts only dates with something collected, keeping the skipped dates among them", () => {
    const days = [day("2026-12-22", ["Residual"]), day("2026-12-24", ["Residual"], "skipped"), day("2026-12-29", ["Residual"]), day("2026-12-31", ["Residual"], "skipped"), day("2027-01-05", ["Residual"])]
    assert.deepEqual(
      nextDatesOf(days, 2).map((date) => date.date),
      ["2026-12-22", "2026-12-24", "2026-12-29"],
    )
    assert.deepEqual(
      nextDatesOf(days, 6).map((date) => date.date),
      days.map((entry) => entry.date),
    )
    assert.deepEqual(nextDatesOf([day("2026-12-24", ["Glass"], "skipped"), day("2026-12-24", ["Paper"])], 1).map((date) => date.collections.length), [2])
  })
})

describe("the labels", () => {
  test("a day and a month as a resident reads them, on the date's own calendar", () => {
    assert.equal(dayLabelOf("2026-10-08"), "Thursday 8 October")
    assert.equal(monthLabelOf("2026-12-31"), "December 2026")
  })
})

describe("calendarHrefOf, feedPathOf and feedUrlsOf", () => {
  test("the search, an address's days and the widget's, the default weeks left out", () => {
    assert.equal(calendarHrefOf("kystbyen"), "/p/kystbyen/calendar")
    assert.equal(calendarHrefOf("kystbyen", { query: "Strand 5" }), "/p/kystbyen/calendar?q=Strand+5")
    assert.equal(calendarHrefOf("kystbyen", { addressId: "a1", weeks: 8 }), "/p/kystbyen/calendar/a1")
    assert.equal(calendarHrefOf("kystbyen", { addressId: "a1", weeks: 26 }), "/p/kystbyen/calendar/a1?weeks=26")
    assert.equal(calendarHrefOf("kystbyen", { embed: true }), "/p/kystbyen/calendar/embed")
    assert.equal(calendarHrefOf("kystbyen", { embed: true, addressId: "a1" }), "/p/kystbyen/calendar/embed/a1")
  })

  test("the feed lives beside the address's page, as https and as webcal on the visitor's origin", () => {
    const path = feedPathOf("kystbyen", "a1")
    assert.equal(path, "/p/kystbyen/calendar/a1/calendar.ics")
    assert.deepEqual(feedUrlsOf("https://waste.example/", path), {
      https: "https://waste.example/p/kystbyen/calendar/a1/calendar.ics",
      webcal: "webcal://waste.example/p/kystbyen/calendar/a1/calendar.ics",
    })
    assert.equal(feedUrlsOf("http://localhost:3000", path).webcal, "webcal://localhost:3000/p/kystbyen/calendar/a1/calendar.ics")
  })
})

describe("feedResponseOf", () => {
  test("the feed as a calendar, cacheable for a minute", async () => {
    const response = feedResponseOf({ kind: "ok", body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8")
    assert.equal(response.headers.get("cache-control"), "public, max-age=60")
    assert.equal(await response.text(), "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
  })

  test("a refusal is a status the app retries by, never the API's sentence", async () => {
    assert.equal(feedResponseOf({ kind: "not-published" }).status, 404)
    const tooMany = feedResponseOf({ kind: "too-many", retryAfterSeconds: 17 })
    assert.deepEqual([tooMany.status, tooMany.headers.get("retry-after")], [429, "17"])
    const unavailable = feedResponseOf({ kind: "unavailable" })
    assert.deepEqual([unavailable.status, unavailable.headers.get("retry-after"), await unavailable.text()], [503, "60", "Unavailable"])
  })
})
