// The fixture asset catalogue Map Planning reads its containers' weights from
// (Issue #39): every weight says where it came from, and the types the
// prototype's fallback table weighed are weighed at least as heavy. It also
// holds the depots form to the domain: the fields the form writes for a
// base's coordinates are the ids `placeLocation` reads, so a rename there
// fails here instead of quietly un-placing every base.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { placeLocation } from "@/lib/prototype/map-planning/positions"
import { FALLBACK_CONTAINER_KG, FALLBACK_FRACTION_FACTOR } from "@/lib/prototype/route-schemes/estimates"

import { FIXTURE_CONTAINER_TYPES } from "../asset-catalogue"
import { getBusinessFormSchema } from "../business-form-schemas"
import type { BusinessRecord } from "../business-modules"
import { FIXTURE_GAZETTEER } from "@waste/fixtures/gazetteer"

describe("the fixture asset catalogue", () => {
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
        const source = type.wasteFractionWeightSources?.[fraction]
        assert.ok(source, `${type.id} ${fraction} names its source`)
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

describe("the depots form on the map", () => {
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
    // What the form submits under those ids is what places a base.
    const base = { id: "depot-nordhavn", name: "Nordhavn Depot", context: "Depot", status: "Active", owner: "", value: "", updated: "", description: "", facts: { Address: "Kaj 14, Nordhavn" }, related: [], source: "Waste API", freshness: "" } satisfies BusinessRecord
    const submitted = { ...base, submittedValues: { latitude: "55.7", longitude: "12.6" } }
    assert.deepEqual(placeLocation(submitted, FIXTURE_GAZETTEER), { lng: 12.6, lat: 55.7 })
  })
})
