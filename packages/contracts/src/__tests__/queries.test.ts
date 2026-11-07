// The windows a list or a report is asked over (queries.ts): the two days or
// instants after the base's fields, with the rules that come with them, each
// refused at `to`, the bound a caller can move.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { OCCURRED_WINDOW_ORDERED } from "@waste/domain/clock"
import { DAY_WINDOW_ORDERED } from "@waste/domain/days"
import * as z from "zod"

import { Id } from "../ids"
import { dayWindow, instantWindow, ProjectScopedListQuery, requiredDayWindow } from "../queries"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const TOO_LONG = "Ask for a week at most"

describe("dayWindow", () => {
  const Query = dayWindow(ProjectScopedListQuery.extend({ routeId: Id.optional() }))

  test("takes the base's fields, then two optional days, either alone", () => {
    assert.deepEqual(Object.keys(Query.shape), ["limit", "cursor", "projectId", "routeId", "from", "to"])
    assert.equal(Query.safeParse({ from: "2026-10-01" }).success, true)
    assert.equal(Query.safeParse({ to: "2026-10-01" }).success, true)
    assert.equal(Query.safeParse({ from: "2026-10-05", to: "2026-10-05" }).success, true, "one day is a window")
  })

  test("refuses a window that runs backward, at `to`", () => {
    assert.deepEqual(refusal(Query.safeParse({ from: "2026-10-02", to: "2026-10-01" })), [{ path: "to", message: DAY_WINDOW_ORDERED }])
  })

  test("keeps the base's own rules first and its strictness", () => {
    const placeFirst = { message: "Name a place", path: ["routeId"] }
    const Strict = dayWindow(z.strictObject({ routeId: Id.optional() }).refine((query) => query.routeId !== undefined, placeFirst))
    assert.deepEqual(refusal(Strict.safeParse({ from: "2026-10-02", to: "2026-10-01" })), [
      { path: "routeId", message: "Name a place" },
      { path: "to", message: DAY_WINDOW_ORDERED },
    ])
    assert.deepEqual(refusal(Strict.safeParse({ routeId: ID, extra: 1 })).map((issue) => issue.path), [""])
  })
})

describe("requiredDayWindow", () => {
  const Query = requiredDayWindow(z.strictObject({}), { maxDays: { days: 7, tooLong: TOO_LONG } })

  test("requires both days", () => {
    assert.deepEqual(refusal(Query.safeParse({ from: "2026-10-01" })).map((issue) => issue.path), ["to"])
  })

  test("refuses a backward window, and one longer than its bound with the context's sentence, both at `to`", () => {
    assert.equal(Query.safeParse({ from: "2026-10-01", to: "2026-10-07" }).success, true, "seven days")
    assert.deepEqual(refusal(Query.safeParse({ from: "2026-10-01", to: "2026-10-08" })), [{ path: "to", message: TOO_LONG }])
    assert.deepEqual(refusal(Query.safeParse({ from: "2026-10-02", to: "2026-10-01" })), [{ path: "to", message: DAY_WINDOW_ORDERED }], "a backward window is told once")
  })

  test("tells an end that is not a day its own issue and no second one: a window it cannot measure is the day's to refuse", () => {
    assert.deepEqual(refusal(Query.safeParse({ from: "2026-10-01", to: "x" })).map((issue) => issue.path), ["to"])
  })

  test("takes the day a context bounds further", () => {
    const Late = requiredDayWindow(z.object({}), { day: z.iso.date().refine((day) => day >= "2000-01-01", "Too early") })
    assert.deepEqual(refusal(Late.safeParse({ from: "1999-12-31", to: "2000-01-01" })), [{ path: "from", message: "Too early" }])
  })
})

describe("instantWindow", () => {
  const Query = instantWindow(ProjectScopedListQuery)

  test("takes two instants with their offsets, and refuses an end before the start as instants, not as text", () => {
    assert.equal(Query.safeParse({ from: "2026-10-05T11:00:00+02:00", to: "2026-10-05T09:30:00Z" }).success, true)
    assert.deepEqual(refusal(Query.safeParse({ from: "2026-10-05T11:00:00Z", to: "2026-10-05T12:30:00+02:00" })), [{ path: "to", message: OCCURRED_WINDOW_ORDERED }])
    assert.equal(Query.safeParse({ from: "2026-10-05" }).success, false, "a day is not an instant")
  })
})
