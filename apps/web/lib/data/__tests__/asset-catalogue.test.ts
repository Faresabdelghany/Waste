// The guided setup's estimates read the asset catalogue for every container
// type the registry seeds (Issue #39): a type the catalogue does not weigh
// for a fraction falls back to the prototype's table and flags the group
// ("Fallback weight"), so a seeded type missing from the catalogue would
// flag every group that collects it. This test holds the fixture catalogue
// to the registry the way street-gazetteer.test.ts holds the gazetteer: a
// container type added to the fixtures fails here until the catalogue weighs
// it for every fraction the fixtures put in it and times its emptying. It
// also holds the depots form to the domain: the fields the form writes for a
// base's coordinates are the ids `placeLocation` reads, so a rename there
// fails here instead of quietly un-placing every base.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { placeLocation } from "@waste/domain/map-planning/positions"
import { FALLBACK_CONTAINER_KG, FALLBACK_FRACTION_FACTOR } from "@waste/domain/route-schemes/estimates"
import { containerMatchProfile } from "@waste/domain/route-schemes/matching"
import { isSoftDeleted } from "@waste/domain/record-visibility"

import { FIXTURE_CONTAINER_TYPES, containerWeightSource } from "../asset-catalogue"
import { getBusinessFormSchema } from "../business-form-schemas"
import { businessWorkspaceList, type BusinessRecord } from "../business-modules"
import { FIXTURE_GAZETTEER } from "../street-gazetteer"

function fixtureRecords(moduleId: string): BusinessRecord[] {
  const modules = businessWorkspaceList.flatMap((workspace) => workspace.modules).filter((module) => module.id === moduleId)
  assert.equal(modules.length, 1, `exactly one fixture module is called ${moduleId}`)
  return modules[0].records
}

const catalogue = new Map(FIXTURE_CONTAINER_TYPES.map((type) => [type.name.toLowerCase(), type]))

describe("the fixture asset catalogue against the fixture registry", () => {
  test("every (container type, fraction) pair the registry seeds — every fraction a container lists — is weighed by the catalogue", () => {
    const pairs = new Map<string, { containerType: string; fraction: string }>()
    for (const record of fixtureRecords("containers")) {
      if (isSoftDeleted(record)) continue
      const profile = containerMatchProfile(record)
      if (!profile.containerType) continue
      // The load reads a container's first fraction today; every fraction it lists is held weighed, so a later reader finds them so too.
      for (const fraction of profile.fractions) {
        pairs.set(`${profile.containerType}|${fraction}`, { containerType: profile.containerType, fraction })
      }
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

  test("every weight says where it came from, and a derived one is the residual weight by the fallback table's density factor", () => {
    const catalogued = {
      "two-wheel-240": ["residual", "organic", "paper"],
      "four-wheel-660": ["residual", "mixed"],
      "four-wheel-1100": ["residual", "cardboard"],
      "wastewater-3000": ["wastewater"],
    } as const
    for (const type of FIXTURE_CONTAINER_TYPES) {
      const own = new Set<string>((catalogued as Record<string, readonly string[]>)[type.id] ?? [])
      for (const [fraction, kg] of Object.entries(type.wasteFractionWeights)) {
        const source = containerWeightSource(type, fraction)
        assert.equal(type.wasteFractionWeightSources?.[fraction], source, `${type.id} ${fraction} names its source`)
        assert.equal(source, own.has(fraction) ? "catalogue" : "derived", `${type.id} ${fraction}`)
        if (source === "derived") {
          const residual = type.wasteFractionWeights.residual
          assert.ok(residual > 0, `${type.id} has a residual weight to derive from`)
          const factor = FALLBACK_FRACTION_FACTOR[fraction]
          assert.ok(factor, `${fraction} has a density factor`)
          assert.ok(Math.abs(kg - residual * factor) <= 0.5 + 1e-9, `${type.id} ${fraction}: ${kg} kg is ${residual} × ${factor} rounded`)
        }
      }
    }
  })

  test("the three types the fallback table covered are weighed at least as heavy as it weighed them for residual", () => {
    for (const id of ["two-wheel-140", "igloo-2500", "underground-5000"]) {
      const type = FIXTURE_CONTAINER_TYPES.find((candidate) => candidate.id === id)
      assert.ok(type, `${id} is in the catalogue`)
      assert.ok(type.wasteFractionWeights.residual >= FALLBACK_CONTAINER_KG[type.name], `${id} residual`)
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

  test("the depots form writes the coordinates under the ids the domain reads: latitude and longitude, required numbers", () => {
    const schema = getBusinessFormSchema("resources", "depots")
    assert.ok(schema, "the depots form schema exists")
    const fields = new Map(schema.sections.flatMap((section) => section.fields.map((field) => [field.id, field])))
    for (const id of ["latitude", "longitude"]) {
      const field = fields.get(id)
      assert.ok(field, `the form declares a field with id exactly "${id}"`)
      assert.equal(field.type, "number", `${id} is typed`)
      assert.equal(field.required, true, `${id} is required — every new base is placeable`)
    }
    // What the form submits under those ids is what places a base — the same keys the fixture bases carry.
    const [base] = fixtureRecords("depots")
    const submitted = { ...base, submittedValues: { latitude: "55.7", longitude: "12.6" } }
    assert.deepEqual(placeLocation(submitted, FIXTURE_GAZETTEER), { lng: 12.6, lat: 55.7 })
  })
})
