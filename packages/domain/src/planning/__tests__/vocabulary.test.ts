// The Planning vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to two things of its own: the days are
// Monday first, since days.ts indexes them against getUTCDay; and they are
// the calendar's own tuple (../days), not a copy. The web's
// prototype holds its display tuple of service types to `SERVICE_TYPES`
// itself. The vehicle types left for Resources (Issue #101), where a vehicle
// type is a row and not a token.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import { SERVICE_DAYS } from "../../days"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Planning", vocabulary, vocabulary.PLANNING_VOCABULARIES, ["DEFAULT_WEEKEND"])

describe("the Planning vocabulary's own rules", () => {
  test("the seven days are Monday first, since days.ts indexes them against getUTCDay", () => {
    assert.deepEqual([...vocabulary.SERVICE_DAYS], ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])
  })

  test("the days are the calendar's tuple, the same and not a copy", () => {
    assert.equal(SERVICE_DAYS, vocabulary.SERVICE_DAYS)
  })

  test("the default weekend is Saturday and Sunday: days of the seven, and fewer than all of them, so a project has a working day", () => {
    assert.deepEqual([...vocabulary.DEFAULT_WEEKEND], ["saturday", "sunday"])
    for (const day of vocabulary.DEFAULT_WEEKEND) assert.ok((vocabulary.SERVICE_DAYS as readonly string[]).includes(day), day)
    assert.ok(vocabulary.DEFAULT_WEEKEND.length < vocabulary.SERVICE_DAYS.length)
  })
})
