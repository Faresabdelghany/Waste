// The import's lists, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to their members.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Imports", vocabulary, vocabulary.IMPORT_VOCABULARIES, 2)

describe("the import vocabulary's own rules", () => {
  test("a file imports one of four kinds, and each row is created, updated, unchanged or refused", () => {
    assert.deepEqual([...vocabulary.IMPORT_KINDS], ["customers", "properties", "containers", "agreements"])
    assert.deepEqual([...vocabulary.IMPORT_ROW_OUTCOMES], ["created", "updated", "unchanged", "refused"])
  })

  test("a request carries fewer rows than the 64 subtransactions Postgres caches, and a file many requests' worth", () => {
    assert.ok(vocabulary.IMPORT_BATCH_MAX < 64)
    assert.ok(vocabulary.IMPORT_ROWS_MAX >= vocabulary.IMPORT_BATCH_MAX)
    assert.equal(vocabulary.IMPORT_ROW_NUMBER_MAX, 2 ** 31 - 1)
  })
})
