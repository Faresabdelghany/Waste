// The audit vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to its one rule: the actions are the
// trigger's three operations, as `lower(TG_OP)` spells them.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("audit", vocabulary, vocabulary.AUDIT_VOCABULARIES, 1)

describe("the audit vocabulary's own rule", () => {
  test("an action is one of the trigger's three operations, lowercased", () => {
    assert.deepEqual([...vocabulary.AUDIT_ACTIONS], ["INSERT", "UPDATE", "DELETE"].map((operation) => operation.toLowerCase()))
  })
})
