// A crew's day across routes (O7 of #290, row 3.18): a driver, a vehicle or
// a trailer on two routes of one day is judged by the routes' times — a
// known overlap refused outright, known spans apart taken, an unknown span
// taken only when the office confirms the same day — and an allocation
// reserving one of them with another crew that day is refused.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { allocatedWithOthers, clockOf, overlappingRoute, sameDayClash, sameDayUnconfirmed, spanOf, type DaySpan } from "../crew-day"

const span = (from: string, to: string): DaySpan => [Number(from.slice(0, 2)) * 3600 + Number(from.slice(3)) * 60, Number(to.slice(0, 2)) * 3600 + Number(to.slice(3)) * 60]

describe("a route's span of the day", () => {
  test("is its start and its work, or unknown without either", () => {
    assert.deepEqual(spanOf({ startsAt: "07:00", workSeconds: 4 * 3600 }), span("07:00", "11:00"))
    assert.equal(spanOf({ startsAt: null, workSeconds: 4 * 3600 }), null)
    assert.equal(spanOf({ startsAt: "07:00", workSeconds: null }), null)
  })

  test("reads as a clock, past midnight too", () => {
    assert.equal(clockOf(span("07:00", "11:30")), "07:00–11:30")
    assert.equal(clockOf([22 * 3600, 25 * 3600 + 15 * 60]), "22:00–01:15")
  })
})

describe("two routes of one day", () => {
  const morning = span("07:00", "11:00")

  test("is nothing where every other span is known and apart, ending as the other starts included", () => {
    assert.equal(sameDayClash(morning, [{ id: "b", span: span("11:00", "15:00") }, { id: "c", span: span("05:00", "07:00") }]), undefined)
    assert.equal(sameDayClash(morning, []), undefined)
  })

  test("is the first known overlap, before any unknown span, which no confirmation takes back", () => {
    assert.deepEqual(sameDayClash(morning, [{ id: "a", span: null }, { id: "b", span: span("10:00", "14:00") }, { id: "c", span: span("08:00", "09:00") }]), { kind: "overlap", routeId: "b" })
  })

  test("is an unknown span — the other's or the route's own — where no known one overlaps", () => {
    assert.deepEqual(sameDayClash(morning, [{ id: "b", span: span("12:00", "14:00") }, { id: "a", span: null }]), { kind: "unknown", routeId: "a" })
    assert.deepEqual(sameDayClash(null, [{ id: "b", span: span("12:00", "14:00") }]), { kind: "unknown", routeId: "b" })
  })

  test("is refused in sentences naming who, the other route and the times", () => {
    assert.equal(
      overlappingRoute("Mads Jensen", "RC-1043", span("10:00", "14:00"), "RC-1042", morning),
      "Mads Jensen is planned on route RC-1043 10:00–14:00, which overlaps route RC-1042's 07:00–11:00",
    )
    assert.equal(
      sameDayUnconfirmed("WH-24", "RC-1043", "RC-1042"),
      "WH-24 is planned on route RC-1043 the same day, and the times of it and route RC-1042 are not both known (a planned start and a measured Plan); confirm the same day to plan WH-24 on both",
    )
    assert.equal(
      allocatedWithOthers("WH-24", "Mon 5 Oct 06:00–14:00", ["Freja Holm"]),
      "WH-24 is allocated Mon 5 Oct 06:00–14:00 with Freja Holm; plan the route with the allocation's crew, or change the allocation first",
    )
    assert.equal(allocatedWithOthers("Mads Jensen", "Mon 5 Oct 06:00 – Tue 6 Oct 02:00", ["WH-25", "WH-T12"]), "Mads Jensen is allocated Mon 5 Oct 06:00 – Tue 6 Oct 02:00 with WH-25 and WH-T12; plan the route with the allocation's crew, or change the allocation first")
  })
})
