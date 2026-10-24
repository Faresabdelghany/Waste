// Insight's one list, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to its order: finest first, the order a
// period picker offers them in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Insight", vocabulary, vocabulary.INSIGHT_VOCABULARIES, 1)

describe("the Insight vocabulary's own rules", () => {
  test("a series is cut by the day, the ISO week or the calendar month, finest first", () => {
    assert.deepEqual([...vocabulary.REPORT_INTERVALS], ["day", "week", "month"])
  })
})
