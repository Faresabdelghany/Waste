// The Resources vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to one thing of its own: an unloading
// station's statuses are a depot's under a second name, the same tuple.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Resources", vocabulary, vocabulary.RESOURCES_VOCABULARIES, ["STOCK_PLACES", "ADJUSTMENT_TARGETS", "PLANNABLE_VEHICLE_STATUSES", "ACTIVE_VEHICLE_STATUSES", "ACTIVE_DRIVER_STATUSES", "STOCKING_WAREHOUSE_STATUSES", "LIVE_ALLOCATION_STATUSES", "ACTIVE_DECOMMISSION_REASON_STATUSES", "ACTIVE_SENSOR_STATUSES", "ACTIVE_MAINTENANCE_PLAN_STATUSES"])

describe("the Resources vocabulary's own rules", () => {
  test("an unloading station's statuses are a depot's: the same tuple, not a copy", () => {
    assert.equal(vocabulary.UNLOADING_STATION_STATUSES, vocabulary.DEPOT_STATUSES)
  })
})
