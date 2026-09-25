// The Resources vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to three things of its own: the glossary's
// six movement kinds and four asset states verbatim, the licence classes
// lowest first as route-schemes/fleet-profiles.ts orders its display tuple
// (which the adapter maps onto these), and an unloading station's statuses
// being a depot's under a second name — seventeen names over sixteen lists.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import { LICENCE_CLASSES as DISPLAY_LICENCE_CLASSES } from "../../route-schemes/fleet-profiles"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Resources", vocabulary, vocabulary.RESOURCES_VOCABULARIES, 17)

describe("the Resources vocabulary's own rules", () => {
  test("the movement kinds and the asset states are the glossary's, verbatim", () => {
    assert.deepEqual([...vocabulary.STOCK_MOVEMENT_KINDS], ["receipt", "issue", "return", "transfer", "adjustment", "decommission"])
    assert.deepEqual([...vocabulary.ASSET_STATUSES], ["in-warehouse", "in-service", "in-maintenance", "retired"])
  })

  test("the licence classes are the lowercase tokens of the prototype's display tuple, lowest first, same order", () => {
    assert.deepEqual([...vocabulary.LICENCE_CLASSES], DISPLAY_LICENCE_CLASSES.map((licenceClass) => licenceClass.toLowerCase()))
  })

  test("an unloading station's statuses are a depot's: the same tuple, not a copy", () => {
    assert.equal(vocabulary.UNLOADING_STATION_STATUSES, vocabulary.DEPOT_STATUSES)
    assert.equal(new Set(Object.values(vocabulary.RESOURCES_VOCABULARIES)).size, 16, "sixteen lists under seventeen names")
  })
})
