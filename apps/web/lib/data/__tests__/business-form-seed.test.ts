// When an open form is filled from its initial values (#177, #197): as it
// opens, and when it becomes a form of another kind — never on a new object
// or new content of the same form's seed, which the workspace rebuilds on
// every record-store change, so what a person typed outlives a switched
// module landing and an optimistic write the API then refuses.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { formReseeds } from "../business-form-seed"

describe("an open form's re-seed", () => {
  test("fills the form as it opens, whether for the first time or again after it closed", () => {
    assert.equal(formReseeds(undefined, { open: true, schemaKey: "route-studio.schemes" }), true)
    assert.equal(formReseeds({ open: false, schemaKey: "route-studio.schemes" }, { open: true, schemaKey: "route-studio.schemes" }), true)
  })

  test("fills it again when it becomes a form of another kind while open", () => {
    assert.equal(formReseeds({ open: true, schemaKey: "customers.contacts" }, { open: true, schemaKey: "route-studio.schemes" }), true)
  })

  test("leaves what was typed alone while the same form stays open, and fills nothing while it is closed", () => {
    assert.equal(formReseeds({ open: true, schemaKey: "route-studio.schemes" }, { open: true, schemaKey: "route-studio.schemes" }), false)
    assert.equal(formReseeds({ open: true, schemaKey: "route-studio.schemes" }, { open: false, schemaKey: "route-studio.schemes" }), false)
    assert.equal(formReseeds(undefined, { open: false, schemaKey: "route-studio.schemes" }), false)
  })
})
