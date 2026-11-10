import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

const { subjectOf } = vocabulary

defineVocabularyTests("Outbox", vocabulary, vocabulary.OUTBOX_VOCABULARIES)

describe("the outbox's kinds and what each is about", () => {
  test("an event's subject is its kind, the kind's aggregate and the aggregate's id", () => {
    assert.deepEqual(subjectOf("route-problem-reported", "r"), { kind: "route-problem-reported", aggregate: "route", aggregateId: "r" })
  })
})
