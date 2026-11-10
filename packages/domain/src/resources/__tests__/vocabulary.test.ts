// The Resources vocabulary, held to the shape every vocabulary module keeps
// (src/__tests__/vocabulary.ts), and to things of its own: the stock places
// and the adjustment targets are places, never a service placement; the
// glossary's six movement kinds and four asset states verbatim; and an
// unloading station's statuses are a depot's under a second name.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { defineVocabularyTests } from "../../__tests__/vocabulary"
import * as vocabulary from "../vocabulary"

defineVocabularyTests("Resources", vocabulary, vocabulary.RESOURCES_VOCABULARIES, { STOCK_PLACES: "STOCK_PLACE_KINDS", ADJUSTMENT_TARGETS: "STOCK_PLACE_KINDS", PLANNABLE_VEHICLE_STATUSES: "VEHICLE_STATUSES", ACTIVE_VEHICLE_STATUSES: "VEHICLE_STATUSES", ACTIVE_DRIVER_STATUSES: "DRIVER_STATUSES", STOCKING_WAREHOUSE_STATUSES: "WAREHOUSE_STATUSES", LIVE_ALLOCATION_STATUSES: "ALLOCATION_STATUSES", ACTIVE_DECOMMISSION_REASON_STATUSES: "DECOMMISSION_REASON_STATUSES", ACTIVE_SENSOR_STATUSES: "SENSOR_STATUSES", ACTIVE_MAINTENANCE_PLAN_STATUSES: "MAINTENANCE_PLAN_STATUSES" })

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

  test("an unloading station's statuses are a depot's: the same tuple, not a copy", () => {
    assert.equal(vocabulary.UNLOADING_STATION_STATUSES, vocabulary.DEPOT_STATUSES)
  })
})
