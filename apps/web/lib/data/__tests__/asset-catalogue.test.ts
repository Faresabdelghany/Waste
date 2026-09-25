// The guided setup's estimates read the asset catalogue for every container
// type the registry seeds (Issue #39): a type the catalogue does not weigh
// for a fraction falls back to the prototype's table and flags the group
// ("Fallback weight"), so a seeded type missing from the catalogue would
// flag every group that collects it. This test holds the fixture catalogue
// to the registry the way street-gazetteer.test.ts holds the gazetteer: a
// container type added to the fixtures fails here until the catalogue weighs
// it for every fraction the fixtures put in it and times its emptying.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { placeLocation } from "@waste/domain/map-planning/positions"
import { containerMatchProfile } from "@waste/domain/route-schemes/matching"
import { isSoftDeleted } from "@waste/domain/record-visibility"

import { FIXTURE_CONTAINER_TYPES } from "../asset-catalogue"
import { businessWorkspaceList, type BusinessRecord } from "../business-modules"
import { FIXTURE_GAZETTEER } from "../street-gazetteer"

function fixtureRecords(moduleId: string): BusinessRecord[] {
  const modules = businessWorkspaceList.flatMap((workspace) => workspace.modules).filter((module) => module.id === moduleId)
  assert.equal(modules.length, 1, `exactly one fixture module is called ${moduleId}`)
  return modules[0].records
}

const catalogue = new Map(FIXTURE_CONTAINER_TYPES.map((type) => [type.name.toLowerCase(), type]))

describe("the fixture asset catalogue against the fixture registry", () => {
  test("every (container type, first fraction) pair the registry seeds is weighed by the catalogue", () => {
    const pairs = new Map<string, { containerType: string; fraction: string }>()
    for (const record of fixtureRecords("containers")) {
      if (isSoftDeleted(record)) continue
      const profile = containerMatchProfile(record)
      const fraction = profile.fractions[0]
      if (!profile.containerType || !fraction) continue
      pairs.set(`${profile.containerType}|${fraction}`, { containerType: profile.containerType, fraction })
    }
    assert.ok(pairs.size > 0, "the registry seeds typed containers")
    const unweighed = [...pairs.values()].filter(({ containerType, fraction }) => {
      const weight = catalogue.get(containerType.toLowerCase())?.wasteFractionWeights[fraction.toLowerCase()]
      return !(typeof weight === "number" && weight > 0)
    })
    assert.deepEqual(unweighed, [], "pairs the estimate would weigh from the fallback table")
  })

  test("every seeded container type has a positive emptying time — the road basis adds it per stop", () => {
    const types = new Set(
      fixtureRecords("containers")
        .map((record) => containerMatchProfile(record).containerType)
        .filter((type): type is string => Boolean(type)),
    )
    for (const type of types) {
      const entry = catalogue.get(type.toLowerCase())
      assert.ok(entry, `${type} is in the catalogue`)
      assert.ok(entry.emptyingTimeMinutes > 0, `${type} has an emptying time`)
    }
  })
})

describe("the fixture depots and unloading stations on the map", () => {
  test("every fixture base is placed by its typed coordinates — the route map starts and ends there", () => {
    const bases = fixtureRecords("depots").filter((record) => !isSoftDeleted(record))
    assert.ok(bases.length >= 2, "a depot and a station are seeded")
    for (const base of bases) {
      const placed = placeLocation(base, FIXTURE_GAZETTEER)
      assert.ok(placed, `${base.name} has a map position`)
      // Copenhagen and its harbour, not a hashed spot anywhere in the bounds.
      assert.ok(placed.lng > 12.55 && placed.lng < 12.65 && placed.lat > 55.65 && placed.lat < 55.72, `${base.name} is in the city`)
      assert.equal(placeLocation({ ...base, submittedValues: {} }, FIXTURE_GAZETTEER), null, `${base.name}'s address alone is on no gazetteer street`)
    }
  })
})
