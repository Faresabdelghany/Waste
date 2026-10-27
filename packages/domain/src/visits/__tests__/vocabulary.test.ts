// The visits vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and the refusals in the identification
// order visits/charges.ts reads them in.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("visits", vocabulary, vocabulary.VISITS_VOCABULARIES, 6)

describe("the visits vocabulary's own rules", () => {
  test("the refusals in the identification order, and a credential is a way a visit is identified", () => {
    assert.deepEqual([...vocabulary.SITE_VISIT_REFUSAL_REASONS], ["unknown-identifier", "not-fee-paying", "credential-blocked"])
    for (const kind of vocabulary.ACCESS_CREDENTIAL_KINDS) assert.ok((vocabulary.SITE_VISIT_IDENTIFICATIONS as readonly string[]).includes(kind), kind)
  })
})
