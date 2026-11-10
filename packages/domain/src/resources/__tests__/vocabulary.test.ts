// The Resources vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to three things of its own: the glossary's
// six movement kinds and four asset states verbatim, the licence classes
// lowest first, and an unloading station's statuses
// being a depot's under a second name — twenty-six names over twenty-five lists.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Resources", vocabulary, vocabulary.RESOURCES_VOCABULARIES, ["STOCK_PLACES", "ADJUSTMENT_TARGETS", "PLANNABLE_VEHICLE_STATUSES", "ACTIVE_VEHICLE_STATUSES", "ACTIVE_DRIVER_STATUSES", "STOCKING_WAREHOUSE_STATUSES", "LIVE_ALLOCATION_STATUSES", "ACTIVE_DECOMMISSION_REASON_STATUSES", "ACTIVE_SENSOR_STATUSES", "ACTIVE_MAINTENANCE_PLAN_STATUSES"])

describe("the Resources vocabulary's own rules", () => {
  test("the stock places and the adjustment targets are places of the place list, and never a service placement", () => {
    for (const place of [...vocabulary.STOCK_PLACES, ...vocabulary.ADJUSTMENT_TARGETS]) {
      assert.ok((vocabulary.STOCK_PLACE_KINDS as readonly string[]).includes(place), place)
      assert.notEqual(place, "service")
    }
    assert.deepEqual([...vocabulary.STOCK_PLACES], ["warehouse", "maintenance"])
    assert.deepEqual([...vocabulary.ADJUSTMENT_TARGETS], ["warehouse", "maintenance", "scrap"])
  })

  test("the movement kinds and the asset states are the glossary's, verbatim", () => {
    assert.deepEqual([...vocabulary.STOCK_MOVEMENT_KINDS], ["receipt", "issue", "return", "transfer", "adjustment", "decommission"])
    assert.deepEqual([...vocabulary.ASSET_STATUSES], ["in-warehouse", "in-service", "in-maintenance", "retired"])
  })

  test("the licence classes are lowest first", () => {
    assert.deepEqual([...vocabulary.LICENCE_CLASSES], ["b", "c", "ce"])
  })

  test("an unloading station's statuses are a depot's: the same tuple, not a copy", () => {
    assert.equal(vocabulary.UNLOADING_STATION_STATUSES, vocabulary.DEPOT_STATUSES)
    assert.equal(new Set(Object.values(vocabulary.RESOURCES_VOCABULARIES)).size, 25, "twenty-five lists under twenty-six names")
  })
})
