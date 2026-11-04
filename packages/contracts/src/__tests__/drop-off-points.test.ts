import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  DropOffPoint,
  DropOffPointCreate,
  DropOffPointExceptionsSet,
  DropOffPointFractionsSet,
  DropOffPointHoursSet,
  DropOffPointListQuery,
  DropOffPointPatch,
  EACH_FRACTION_ONCE,
} from "../drop-off-points"
import { DropOffPointsQuery, PublicDropOffPoints } from "../public"
import { refusal, refusesAnEmptyPatch, refusesWhatTheServerOwns } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const STAMPS = { createdAt: "2026-10-24T13:41:00.000Z", updatedAt: "2026-10-24T13:41:00.000Z" }
const POINT = { type: "Point", coordinates: [12.5951, 55.7089] }
const create = { projectId: OTHER, code: "GS-AMAGER", name: "Genbrugsstation Amager", kind: "recycling-centre", address: "Kraftværksvej 31, 2300 København S", location: POINT }

describe("DropOffPoint", () => {
  test("is a point with its three sets", () => {
    const point = {
      id: ID,
      ...create,
      openAlways: false,
      closedOnHolidays: true,
      publicNote: "Bring ID.",
      status: "active",
      notes: null,
      wasteFractionIds: [ID],
      hours: [{ weekday: "monday", opensAt: "10:00", closesAt: "18:00" }],
      exceptions: [{ date: "2026-12-24", opensAt: "09:00", closesAt: "12:00", note: "Christmas Eve" }],
      ...STAMPS,
    }
    assert.equal(DropOffPoint.safeParse(point).success, true)
  })
})

describe("DropOffPointCreate", () => {
  test("a new point is a draft taking nothing, with no hours, closed on no holiday, until the office says otherwise", () => {
    assert.deepEqual(DropOffPointCreate.parse(create), { ...create, openAlways: false, closedOnHolidays: false, status: "draft", wasteFractionIds: [], hours: [], exceptions: [] })
  })

  test("refuses what the server owns, a kind it does not know, and a point with an altitude", () => {
    refusesWhatTheServerOwns(DropOffPointCreate, create)
    assert.deepEqual(refusal(DropOffPointCreate.safeParse({ ...create, kind: "depot" })).map((issue) => issue.path), ["kind"])
    assert.deepEqual(refusal(DropOffPointCreate.safeParse({ ...create, location: { type: "Point", coordinates: [12.5, 55.7, 10] } })).map((issue) => issue.path), ["location.coordinates"])
  })

  test("judges the sets it starts with as their own routes do", () => {
    assert.deepEqual(refusal(DropOffPointCreate.safeParse({ ...create, wasteFractionIds: [ID, ID] })), [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
    assert.deepEqual(refusal(DropOffPointCreate.safeParse({ ...create, hours: [{ weekday: "monday", opensAt: "18:00", closesAt: "10:00" }] })), [
      { path: "hours", message: "Monday: a window must open before it closes (18:00–10:00)" },
    ])
  })
})

describe("DropOffPointPatch", () => {
  test("changes something, and never the project, the code or a set", () => {
    refusesAnEmptyPatch(DropOffPointPatch)
    assert.equal(DropOffPointPatch.safeParse({ status: "active" }).success, true)
    for (const key of ["projectId", "code", "wasteFractionIds", "hours", "exceptions"]) {
      assert.deepEqual(refusal(DropOffPointPatch.safeParse({ name: "x", [key]: key === "projectId" ? OTHER : [] })).map((issue) => issue.path), [""], key)
    }
  })
})

describe("the sets", () => {
  test("the fractions each once", () => {
    assert.equal(DropOffPointFractionsSet.safeParse({ wasteFractionIds: [ID, OTHER] }).success, true)
    assert.deepEqual(refusal(DropOffPointFractionsSet.safeParse({ wasteFractionIds: [ID, ID] })), [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
  })

  test("the week's windows by the domain's rules, a time HH:MM on the clock", () => {
    assert.equal(DropOffPointHoursSet.safeParse({ hours: [] }).success, true, "no hours: closed but for exceptions, or open always")
    assert.deepEqual(
      refusal(
        DropOffPointHoursSet.safeParse({
          hours: [
            { weekday: "saturday", opensAt: "08:00", closesAt: "12:00" },
            { weekday: "saturday", opensAt: "11:00", closesAt: "14:00" },
          ],
        }),
      ),
      [{ path: "hours", message: "Saturday: 08:00–12:00 and 11:00–14:00 overlap" }],
    )
    assert.deepEqual(refusal(DropOffPointHoursSet.safeParse({ hours: [{ weekday: "monday", opensAt: "10:00:00", closesAt: "18:00" }] })).map((issue) => issue.path), ["hours.0.opensAt"])
  })

  test("the exceptions one a date, both times or neither", () => {
    assert.equal(DropOffPointExceptionsSet.safeParse({ exceptions: [{ date: "2026-12-25", opensAt: null, closesAt: null, note: "Christmas Day" }] }).success, true)
    assert.deepEqual(refusal(DropOffPointExceptionsSet.safeParse({ exceptions: [{ date: "2026-12-24", opensAt: "09:00", closesAt: null, note: null }] })), [
      { path: "exceptions", message: "2026-12-24: give both times, or neither for closed all day" },
    ])
  })
})

describe("DropOffPointListQuery and the public shapes", () => {
  test("a list is one project's, by status and kind", () => {
    assert.equal(DropOffPointListQuery.safeParse({ projectId: OTHER, status: "active", kind: "bring-bank" }).success, true)
    assert.equal(DropOffPointListQuery.safeParse({ projectId: OTHER, kind: "depot" }).success, false)
  })

  test("the map asks by the guide's fraction key, or for every point", () => {
    assert.deepEqual(DropOffPointsQuery.parse({}), {})
    assert.deepEqual(DropOffPointsQuery.parse({ fraction: "glass" }), { fraction: "glass" })
    assert.equal(DropOffPointsQuery.safeParse({ fraction: "Glass jars" }).success, false)
  })

  test("a public point carries no code and no office notes", () => {
    const answer = {
      project: { slug: "kystbyen", name: "Kystbyen", language: "da", timezone: "Europe/Copenhagen", branding: { brandColor: null, logoUrl: null, accessibilityStatementUrl: null } },
      fraction: { key: "glass", name: "Glas" },
      from: "2026-10-24",
      truncated: false,
      points: [{ id: ID, name: "Genbrugsstation Amager", kind: "recycling-centre", address: "Kraftværksvej 31", location: POINT, fractions: ["Glas"], publicNote: null, week: [{ date: "2026-10-24", windows: [{ opensAt: "10:00", closesAt: "17:00" }], allDay: false, note: null }] }],
    }
    const parsed = PublicDropOffPoints.parse({ ...answer, points: [{ ...answer.points[0], code: "GS-AMAGER", notes: "The office's" }] })
    assert.deepEqual(parsed, answer, "what the door's answer may not carry is stripped from it, never passed on")
  })
})
