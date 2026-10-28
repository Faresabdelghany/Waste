// A Route Scheme's Seasons on the wire (O17 of #290): one season's shape, the
// set's rules, and where the create, the patch and the occurrence row carry
// them.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  AT_MOST_SEASONS,
  DAILY_HAS_NO_SEASONS,
  EACH_SEASON_NAME_ONCE,
  MONTH_DAY_SHAPE,
  Occurrence,
  RouteSchemeCreate,
  RouteSchemePatch,
  SchemeSeason,
  SchemeSeasons,
  SEASON_PART_OF_YEAR,
  SEASONS_KEEP_APART,
  SEASONS_MAX,
  WEEK_ROTATION_WITH_FORTNIGHTLY,
} from "../route-schemes"
import { refusal } from "./expect"

const PROJECT = "01a0d3a5-e5e0-7000-8000-000000000001"
const FRACTION = "01a0d3a5-e5e0-7000-8000-000000000002"

const summer = { name: "Summer", startsOn: "05-01", endsOn: "10-01", frequency: "weekly", weekRotation: null } as const
const winter = { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks", weekRotation: "odd" } as const

const create = {
  projectId: PROJECT,
  name: "Garden waste",
  serviceType: "container-collection",
  frequency: "every-2-weeks",
  weekRotation: "even",
  serviceDays: ["monday"],
  validFrom: "2026-01-01",
  collectionGroups: [{ name: "Garden", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [FRACTION], containerTypeIds: [], vehicleTypeId: null } }],
}

describe("SchemeSeason", () => {
  test("is a stretch of every year with its own cadence, over the new year where its end comes first", () => {
    assert.deepEqual(SchemeSeason.parse(summer), summer)
    assert.deepEqual(SchemeSeason.parse(winter), winter)
  })

  test("refuses a day not every year has, a daily cadence, a rotation with the wrong cadence, the whole year, and a member it does not carry", () => {
    for (const day of ["02-29", "04-31", "13-01", "5-01", "2026-05-01"]) {
      assert.deepEqual(refusal(SchemeSeason.safeParse({ ...summer, startsOn: day })), [{ path: "startsOn", message: MONTH_DAY_SHAPE }], day)
    }
    assert.deepEqual(refusal(SchemeSeason.safeParse({ ...summer, frequency: "daily" })).map((issue) => issue.path), ["frequency"])
    assert.deepEqual(refusal(SchemeSeason.safeParse({ ...summer, weekRotation: "odd" })), [{ path: "weekRotation", message: WEEK_ROTATION_WITH_FORTNIGHTLY }])
    assert.deepEqual(refusal(SchemeSeason.safeParse({ ...winter, weekRotation: null })), [{ path: "weekRotation", message: WEEK_ROTATION_WITH_FORTNIGHTLY }])
    assert.deepEqual(refusal(SchemeSeason.safeParse({ ...summer, endsOn: "05-01" })), [{ path: "endsOn", message: SEASON_PART_OF_YEAR }])
    assert.match(refusal(SchemeSeason.safeParse({ ...summer, id: PROJECT }))[0].message, /id/)
  })
})

describe("SchemeSeasons", () => {
  test("holds seasons that share no day, each name once, at most the bound", () => {
    assert.deepEqual(SchemeSeasons.parse([summer, winter]), [summer, winter])
    assert.deepEqual(refusal(SchemeSeasons.safeParse([summer, { ...winter, name: "Summer" }])), [{ path: "", message: EACH_SEASON_NAME_ONCE }])
    assert.deepEqual(refusal(SchemeSeasons.safeParse([summer, winter, { ...summer, name: "Autumn", startsOn: "09-15", endsOn: "11-15" }])), [{ path: "2", message: SEASONS_KEEP_APART }])
    // Adjacent stretches touch and do not overlap: one ends before the day the next starts.
    assert.ok(SchemeSeasons.safeParse([summer, { ...summer, name: "Autumn", startsOn: "10-01", endsOn: "11-01" }, winter]).success)
    const many = Array.from({ length: SEASONS_MAX + 1 }, (_, n) => ({ ...summer, name: `S${n}`, startsOn: `0${n + 1}-01`, endsOn: `0${n + 1}-02` }))
    assert.deepEqual(refusal(SchemeSeasons.safeParse(many)), [{ path: "", message: AT_MOST_SEASONS }])
  })
})

describe("the seasons on the write bodies", () => {
  test("a create defaults to none and carries what it is given", () => {
    assert.deepEqual(RouteSchemeCreate.parse(create).seasons, [])
    assert.deepEqual(RouteSchemeCreate.parse({ ...create, seasons: [summer, winter] }).seasons, [summer, winter])
  })

  test("a daily scheme carries none, judged where the body says both", () => {
    const daily = { ...create, frequency: "daily", weekRotation: null, serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], collectionGroups: [{ ...create.collectionGroups[0], days: ["monday"] }] }
    assert.ok(RouteSchemeCreate.safeParse(daily).success)
    assert.deepEqual(refusal(RouteSchemeCreate.safeParse({ ...daily, seasons: [summer] })), [{ path: "seasons", message: DAILY_HAS_NO_SEASONS }])
    assert.deepEqual(refusal(RouteSchemePatch.safeParse({ frequency: "daily", serviceDays: daily.serviceDays, seasons: [summer] })), [{ path: "seasons", message: DAILY_HAS_NO_SEASONS }])
    assert.ok(RouteSchemePatch.safeParse({ seasons: [summer] }).success, "half the pair is the route's to judge")
  })

  test("a patch replaces the set whole, and an empty set clears it", () => {
    assert.deepEqual(RouteSchemePatch.parse({ seasons: [] }), { seasons: [] })
    assert.deepEqual(refusal(RouteSchemePatch.safeParse({ seasons: [summer, summer] })), [{ path: "seasons", message: EACH_SEASON_NAME_ONCE }, { path: "seasons.1", message: SEASONS_KEEP_APART }])
  })
})

describe("an occurrence", () => {
  test("names the season its recurrence day fell in, or none", () => {
    const row = { n: 1, date: "2026-07-06", plannedDate: "2026-07-06", week: 28, status: "planned" }
    assert.deepEqual(Occurrence.parse({ ...row, season: "Summer" }), { ...row, season: "Summer" })
    assert.deepEqual(Occurrence.parse(row), row)
  })
})
