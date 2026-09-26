// How Settings › Asset management reads itself back from the browser (Issue
// #39): the fixture container types a stored catalogue was never seeded with
// are appended — a browser holding the four-type catalogue from before the
// issue gets the 140 L bin, the igloo and the underground unit on its next
// load, so its guided setup stops flagging "Fallback weight" — and nothing
// the person changed or deleted is touched. The ledger of seeded ids is what
// tells a deletion from a type never seen.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { FIXTURE_CONTAINER_TYPES, type ContainerType } from "../asset-catalogue"
import {
  hydrateAssetManagementState,
  isAssetManagementState,
  seedMissingContainerTypes,
  type AssetManagementState,
} from "../asset-management-state"

const fixtureIds = FIXTURE_CONTAINER_TYPES.map((type) => type.id)

const defaults: AssetManagementState = {
  containerTypes: [...FIXTURE_CONTAINER_TYPES],
  seededContainerTypeIds: fixtureIds,
  wasteFractions: [],
  partTypes: [],
  spareParts: [],
  propertyEquipment: [],
  keyTypes: [],
  measurementSettings: [],
  importJobs: [],
  locksmithEmail: "keys@example.test",
  features: { inventoryEnabled: true, wastewaterTreatmentEnabled: true, physicalKeysEnabled: true },
}

const byId = (id: string): ContainerType => {
  const type = FIXTURE_CONTAINER_TYPES.find((candidate) => candidate.id === id)
  assert.ok(type, `${id} is a fixture type`)
  return type
}

/** `state` as a store written before the ledger existed would hold it. */
function withoutLedger(state: AssetManagementState): Record<string, unknown> {
  const stored: Record<string, unknown> = { ...state }
  delete stored.seededContainerTypeIds
  return stored
}

/** A store written before Issue #39: the four types then in the catalogue, one of them edited, and no ledger. */
function storeBeforeIssue39(): Record<string, unknown> {
  const edited240: ContainerType = { ...byId("two-wheel-240"), name: "Kerbside 240", wasteFractionWeights: { residual: 20 } }
  return {
    ...withoutLedger(defaults),
    containerTypes: [edited240, byId("four-wheel-660"), byId("four-wheel-1100"), byId("wastewater-3000")],
    locksmithEmail: "locks@example.test",
    features: { inventoryEnabled: false },
  }
}

describe("hydrateAssetManagementState", () => {
  test("a store from before Issue #39 gains the three types it never had, appended, with every edit kept", () => {
    const stored = storeBeforeIssue39()
    const state = hydrateAssetManagementState(JSON.stringify(stored), defaults)
    assert.ok(state)
    assert.deepEqual(
      state.containerTypes.map((type) => type.id),
      ["two-wheel-240", "four-wheel-660", "four-wheel-1100", "wastewater-3000", "two-wheel-140", "igloo-2500", "underground-5000"],
      "held types first, in their stored order; the missing fixtures after, in the fixtures' order",
    )
    const edited = state.containerTypes.find((type) => type.id === "two-wheel-240")
    assert.equal(edited?.name, "Kerbside 240", "the edited name stands")
    assert.deepEqual(edited?.wasteFractionWeights, { residual: 20 }, "the edited weights stand — never overwritten by the fixture's")
    assert.deepEqual(state.containerTypes.find((type) => type.id === "igloo-2500"), byId("igloo-2500"))
    assert.deepEqual(state.seededContainerTypeIds, fixtureIds, "the ledger now names every fixture id")
    assert.equal(state.locksmithEmail, "locks@example.test")
    assert.deepEqual(state.features, { inventoryEnabled: false, wastewaterTreatmentEnabled: true, physicalKeysEnabled: true }, "stored flags over default flags")
  })

  test("a fixture type the person deleted stays deleted once the ledger names it", () => {
    const stored = { ...defaults, containerTypes: defaults.containerTypes.filter((type) => type.id !== "igloo-2500") }
    const state = hydrateAssetManagementState(JSON.stringify(stored), defaults)
    assert.ok(state)
    assert.equal(state.containerTypes.some((type) => type.id === "igloo-2500"), false)
    assert.deepEqual(state.seededContainerTypeIds, fixtureIds)
  })

  test("a custom type the person added is kept ahead of the seeded ones and never duplicated", () => {
    const custom: ContainerType = { ...byId("two-wheel-240"), id: "container-type-skip", name: "Skip · 8 m³" }
    const stored = storeBeforeIssue39()
    stored.containerTypes = [custom, ...(stored.containerTypes as ContainerType[])]
    const state = hydrateAssetManagementState(JSON.stringify(stored), defaults)
    assert.ok(state)
    assert.equal(state.containerTypes[0].id, "container-type-skip")
    assert.equal(state.containerTypes.length, 8)
    assert.equal(new Set(state.containerTypes.map((type) => type.id)).size, 8, "no id twice")
  })

  test("a store already seeded with everything hydrates unchanged", () => {
    const state = hydrateAssetManagementState(JSON.stringify(defaults), defaults)
    assert.deepEqual(state, defaults)
  })

  test("nothing stored, garbage, or another shape leaves the defaults to the store", () => {
    assert.equal(hydrateAssetManagementState(null, defaults), null)
    assert.equal(hydrateAssetManagementState("{not json", defaults), null)
    assert.equal(hydrateAssetManagementState(JSON.stringify({ containerTypes: [] }), defaults), null)
    assert.equal(hydrateAssetManagementState(JSON.stringify([defaults]), defaults), null)
  })
})

describe("seedMissingContainerTypes", () => {
  test("returns the same state when nothing is missing and the ledger is complete", () => {
    const state = { containerTypes: [...FIXTURE_CONTAINER_TYPES], seededContainerTypeIds: fixtureIds }
    assert.equal(seedMissingContainerTypes(state), state)
  })

  test("a later fixture type is appended exactly once across loads", () => {
    const later: ContainerType = { ...byId("igloo-2500"), id: "igloo-3000", name: "Igloo · 3,000 L" }
    const fixtures = [...FIXTURE_CONTAINER_TYPES, later]
    const first = seedMissingContainerTypes({ containerTypes: [...FIXTURE_CONTAINER_TYPES], seededContainerTypeIds: fixtureIds }, fixtures)
    assert.deepEqual(first.containerTypes.at(-1), later)
    assert.ok(first.seededContainerTypeIds.includes("igloo-3000"))
    // Deleted after the seed: the next load leaves it deleted.
    const deleted = { ...first, containerTypes: first.containerTypes.filter((type) => type.id !== "igloo-3000") }
    assert.equal(seedMissingContainerTypes(deleted, fixtures), deleted)
  })
})

describe("isAssetManagementState", () => {
  test("accepts the shape with or without the ledger, rejects a ledger that is not a list", () => {
    assert.equal(isAssetManagementState(defaults), true)
    assert.equal(isAssetManagementState(withoutLedger(defaults)), true)
    assert.equal(isAssetManagementState({ ...defaults, seededContainerTypeIds: "two-wheel-240" }), false)
  })
})
