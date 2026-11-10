import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { StoredSchemeSeason } from "@waste/domain/planning/scheme-seasons"
import type { SchemeSeason } from "@waste/domain/planning/seasons"
import { recurrenceFromValues, SCHEME_SEASONS_KEY, seasonsFromValues, seasonsValue, storedSeasonsFromValues } from "../recurrence-values"

const summer: SchemeSeason = { name: "Summer", startsOn: "05-01", endsOn: "10-01", frequency: "weekly" }
const winter: SchemeSeason = { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks", weekRotation: "odd" }

describe("a scheme record's recurrence", () => {
  test("reads the cadence's fields", () => {
    const recurrence = recurrenceFromValues({
      frequency: "every-4-weeks",
      serviceDays: "monday",
      effectiveFrom: "2026-09-14",
      effectiveTo: "",
    })
    assert.equal(recurrence?.frequency, "every-4-weeks")
  })

  test("widens a daily scheme to the full week", () => {
    const recurrence = recurrenceFromValues({
      frequency: "daily",
      serviceDays: "monday, tuesday",
      effectiveFrom: "2026-09-14",
      effectiveTo: "",
    })
    assert.equal(recurrence?.serviceDays.length, 7)
  })
})

describe("a scheme record's seasons", () => {
  const stored = [
    { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks", weekRotation: "odd" },
    { name: "Summer", startsOn: "05-01", endsOn: "10-01", frequency: "weekly", weekRotation: null },
  ] as const satisfies readonly StoredSchemeSeason[]

  test("ride as JSON by the day they start, and read back for the date math with the null rotation left out", () => {
    const values = { [SCHEME_SEASONS_KEY]: seasonsValue(stored) }
    assert.deepEqual(storedSeasonsFromValues(values).map((season) => season.name), ["Summer", "Winter"])
    assert.deepEqual(seasonsFromValues(values), [summer, winter])
  })

  test("a record without them, with JSON that is not a list, or with entries that are not seasons reads none of those", () => {
    assert.deepEqual(storedSeasonsFromValues({}), [])
    assert.deepEqual(storedSeasonsFromValues({ [SCHEME_SEASONS_KEY]: "not json" }), [])
    assert.deepEqual(storedSeasonsFromValues({ [SCHEME_SEASONS_KEY]: "{}" }), [])
    assert.deepEqual(storedSeasonsFromValues({ [SCHEME_SEASONS_KEY]: JSON.stringify([{ ...stored[1], startsOn: "02-29" }, { ...stored[1], frequency: "daily" }, stored[0]]) }).map((season) => season.name), ["Winter"])
  })

  test("a set the date math may not read together is read as none", () => {
    const overlapping = [stored[1], { ...stored[1], name: "Autumn", startsOn: "09-01", endsOn: "11-01" }]
    assert.deepEqual(seasonsFromValues({ [SCHEME_SEASONS_KEY]: JSON.stringify(overlapping) }), [])
  })

  test("recurrenceFromValues carries them, except on a daily scheme", () => {
    const values = { frequency: "weekly", serviceDays: "monday", effectiveFrom: "2026-01-05", [SCHEME_SEASONS_KEY]: seasonsValue(stored) }
    assert.deepEqual(recurrenceFromValues(values)?.seasons, [summer, winter])
    assert.equal(recurrenceFromValues({ ...values, frequency: "daily" })?.seasons, undefined)
    assert.equal(recurrenceFromValues({ ...values, [SCHEME_SEASONS_KEY]: undefined })?.seasons, undefined)
  })
})
