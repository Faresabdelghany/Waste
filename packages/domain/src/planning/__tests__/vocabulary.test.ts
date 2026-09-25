// The Planning vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to three things of its own: the days are
// Monday first, since recurrence.ts indexes them against getUTCDay; the lists
// that moved here from the route-scheme modules are still what those modules
// export, so the move changed no value a stored record carries; and the one
// list that is the tokens of a display tuple the prototype still reads by
// name (`SCHEME_SERVICE_TYPES` in route-schemes/scope.ts) is held to it
// position by position, so a service type added to one fails until it is
// added to the other. The vehicle types left for Resources (Issue #101),
// where a vehicle type is a row and not a token; the display tuple in
// route-schemes/matching.ts stays the web's and is held to nothing here.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import { SCHEME_EDIT_POLICIES } from "../../route-schemes/creation"
import { HOLIDAY_POLICIES, OCCURRENCE_STATUSES } from "../../route-schemes/occurrences"
import { SERVICE_DAYS } from "../../route-schemes/recurrence"
import { SCHEME_SERVICE_TYPES } from "../../route-schemes/scope"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Planning", vocabulary, vocabulary.PLANNING_VOCABULARIES, 12, ["DEFAULT_WEEKEND"])

/** The kebab token of a display string: `Container collection` is `container-collection`. */
const tokenOf = (display: string): string => display.toLowerCase().replaceAll(" ", "-")

describe("the Planning vocabulary's own rules", () => {
  test("the seven days are Monday first, since recurrence.ts indexes them against getUTCDay", () => {
    assert.deepEqual([...vocabulary.SERVICE_DAYS], ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])
  })

  test("the lists that moved here are still what the route-scheme modules export, the same tuple and not a copy", () => {
    assert.equal(SERVICE_DAYS, vocabulary.SERVICE_DAYS)
    assert.equal(HOLIDAY_POLICIES, vocabulary.HOLIDAY_POLICIES)
    assert.equal(SCHEME_EDIT_POLICIES, vocabulary.SCHEME_EDIT_POLICIES)
    assert.equal(OCCURRENCE_STATUSES, vocabulary.OCCURRENCE_STATUSES)
  })

  test("the default weekend is Saturday and Sunday: days of the seven, and fewer than all of them, so a project has a working day", () => {
    assert.deepEqual([...vocabulary.DEFAULT_WEEKEND], ["saturday", "sunday"])
    for (const day of vocabulary.DEFAULT_WEEKEND) assert.ok((vocabulary.SERVICE_DAYS as readonly string[]).includes(day), day)
    assert.ok(vocabulary.DEFAULT_WEEKEND.length < vocabulary.SERVICE_DAYS.length)
  })

  test("the service types are the kebab tokens of the prototype's display tuple, same length, same order", () => {
    assert.deepEqual([...vocabulary.SERVICE_TYPES], SCHEME_SERVICE_TYPES.map(tokenOf))
  })
})
