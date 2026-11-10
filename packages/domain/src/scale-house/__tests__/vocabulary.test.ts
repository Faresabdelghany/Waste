// The scale house's vocabulary, held to the shape every vocabulary module keeps (src/__tests__/vocabulary.ts).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("scale-house", vocabulary, vocabulary.SCALE_HOUSE_VOCABULARIES)

describe("the scale house vocabulary's own rules", () => {
  test("a ticket opens weighed in, and a void names another reason only through its note", () => {
    assert.equal(vocabulary.SCALE_TICKET_STATUSES[0], "open")
    assert.equal(vocabulary.SCALE_TICKET_VOID_REASONS.at(-1), "other")
  })
})
