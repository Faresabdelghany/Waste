// The visits vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and a credential being a way a visit is
// identified.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("visits", vocabulary, vocabulary.VISITS_VOCABULARIES)

describe("the visits vocabulary's own rules", () => {
  test("a credential is a way a visit is identified", () => {
    for (const kind of vocabulary.ACCESS_CREDENTIAL_KINDS) assert.ok((vocabulary.SITE_VISIT_IDENTIFICATIONS as readonly string[]).includes(kind), kind)
  })
})
