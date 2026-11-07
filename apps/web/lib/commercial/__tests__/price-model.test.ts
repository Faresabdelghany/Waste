// The resolution rule the pricing modules state (issue #22).
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { getBusinessFormSchema } from "../../data/business-form-schemas"
import { getModuleDefinition } from "../../data/business-modules"
import { RESOLUTION_RULE } from "../price-model"

// Module-scope reads throw at load, which fails the file loudly (a throw in
// a describe body would not).
const requireModule = (moduleId: string) => {
  const module = getModuleDefinition({ workspaceId: "commercial", moduleId })
  if (!module) throw new Error(`no commercial.${moduleId} module`)
  return module
}
const products = requireModule("products")
const priceRows = requireModule("price-rows")

describe("RESOLUTION_RULE", () => {
  test("is the sentence the two pricing modules and the Add price form state", () => {
    assert.ok(products.rules.includes(RESOLUTION_RULE))
    assert.ok(priceRows.rules.includes(RESOLUTION_RULE))
    const schema = getBusinessFormSchema("commercial", "price-rows")
    assert.ok(schema?.description.includes(RESOLUTION_RULE))
  })
})
