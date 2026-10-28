// A scheme record's Seasons on its page (O17 of #290): the line a season is
// listed by, and a save that replaces the set whole and keeps its fact beside
// it, read back by the adapter's own reader and by the preview's recurrence.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { recurrenceFromValues } from "@waste/domain/route-schemes/recurrence"
import { storedSeasonsFromValues } from "@waste/domain/route-schemes/scheme-seasons"

import type { BusinessRecord } from "../business-modules"
import { seasonLine, withSeasons } from "../scheme-seasons"

const summer = { name: "Summer", startsOn: "05-01", endsOn: "10-01", frequency: "weekly", weekRotation: null } as const
const winter = { name: "Winter", startsOn: "11-01", endsOn: "04-01", frequency: "every-2-weeks", weekRotation: "odd" } as const

const scheme = {
  id: "scheme-1",
  name: "Garden waste",
  context: "Copenhagen",
  status: "Draft",
  facts: { Project: "Copenhagen", Seasons: "Old" },
  submittedValues: { frequency: "every-2-weeks", weekRotation: "even", serviceDays: "monday", effectiveFrom: "2026-01-05" },
} as unknown as BusinessRecord

describe("a scheme record's seasons", () => {
  test("a season is listed by its name, its days with the last day in, and its cadence", () => {
    assert.equal(seasonLine(summer), "Summer · 1 May – 30 Sep · Every week")
    assert.equal(seasonLine(winter), "Winter · 1 Nov – 31 Mar · Every 2 weeks (odd ISO weeks)")
  })

  test("a save replaces the set whole, by the day each starts, and the fact names them", () => {
    const saved = withSeasons(scheme, [winter, summer])
    assert.deepEqual(storedSeasonsFromValues(saved.submittedValues), [summer, winter])
    assert.equal(saved.facts?.Seasons, "Summer, Winter")
    assert.equal(saved.facts?.Project, "Copenhagen")
    assert.deepEqual(recurrenceFromValues(saved.submittedValues as Record<string, string>)?.seasons?.map((season) => season.name), ["Summer", "Winter"])
  })

  test("an empty set clears them and the fact with them", () => {
    const cleared = withSeasons(withSeasons(scheme, [summer]), [])
    assert.deepEqual(storedSeasonsFromValues(cleared.submittedValues), [])
    assert.equal(cleared.facts?.Seasons, undefined)
    assert.equal(recurrenceFromValues(cleared.submittedValues as Record<string, string>)?.seasons, undefined)
  })
})
