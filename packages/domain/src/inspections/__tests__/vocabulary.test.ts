// The inspections vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("inspections", vocabulary, vocabulary.INSPECTIONS_VOCABULARIES, 5)

describe("the inspections vocabulary's own rules", () => {
  test("an inspection is compliant or finds something of either weight, and is open until the office closes it", () => {
    assert.deepEqual([...vocabulary.FIELD_INSPECTION_OUTCOMES], ["compliant", "minor", "major"])
    assert.deepEqual([...vocabulary.FIELD_INSPECTION_STATUSES], ["open", "closed"])
  })
})
