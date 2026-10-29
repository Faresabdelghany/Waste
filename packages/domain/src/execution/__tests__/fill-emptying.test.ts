// The fill-driven emptying's choice of route (O26 of #290): ahead of
// the container's next scheduled emptying, on its scheme and group, the
// earliest route from today, or nothing and why.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { fillEmptyingRoute, FILL_EMPTYING_LEAD_DAYS, type EmptyingRoute } from "../fill-emptying"

const route = (id: string, operatingDate: string, over: Partial<EmptyingRoute> = {}): EmptyingRoute => ({ id, label: `RC-${id}`, operatingDate, routeSchemeId: "scheme", collectionGroupId: "group", ...over })

describe("the fill-driven emptying's route", () => {
  const next = route("next", "2026-11-05")

  test("is the earliest route of the next emptying's scheme and group from today, before that day, ties by id", () => {
    const choice = fillEmptyingRoute(next, [route("b", "2026-11-02"), route("a", "2026-11-02"), route("c", "2026-11-01"), next], "2026-10-29")
    assert.deepEqual(choice, { kind: "book", route: route("c", "2026-11-01") })
    assert.deepEqual(fillEmptyingRoute(next, [route("b", "2026-11-02"), route("a", "2026-11-02")], "2026-10-29"), { kind: "book", route: route("a", "2026-11-02") })
  })

  test("never another scheme's or group's route, a route of the past, or one on or after the next emptying", () => {
    const candidates = [route("other-scheme", "2026-10-30", { routeSchemeId: "elsewhere" }), route("other-group", "2026-10-30", { collectionGroupId: "elsewhere" }), route("past", "2026-10-28"), route("same-day", "2026-11-05"), route("later", "2026-11-06")]
    assert.deepEqual(fillEmptyingRoute(next, candidates, "2026-10-29"), { kind: "no-route", next })
  })

  test("books nothing when the next emptying is soon enough, or when none is planned", () => {
    assert.equal(FILL_EMPTYING_LEAD_DAYS, 1)
    assert.deepEqual(fillEmptyingRoute(route("tomorrow", "2026-10-30"), [route("today", "2026-10-29")], "2026-10-29").kind, "soon-enough")
    assert.equal(fillEmptyingRoute(route("in-two", "2026-10-31"), [route("today", "2026-10-29")], "2026-10-29").kind, "book")
    assert.deepEqual(fillEmptyingRoute(null, [route("today", "2026-10-29")], "2026-10-29"), { kind: "no-schedule" })
  })
})
