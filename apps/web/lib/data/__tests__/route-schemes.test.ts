// The status a scheme edit asks the API for on the Pilot (#177): the stored
// one, never lowered by the web's own reading, and Validated for a Draft the
// edit leaves without a blocking issue — the browser path's rule (D31) — so a
// scheme an edit refused midway left a Draft is validated again by the save
// that fixes it.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { schemeEditStatusOnApi } from "../route-schemes"

describe("the status a scheme edit asks the API for", () => {
  test("a Validated scheme stays Validated, whatever the web's own validation says: the API's 409 speaks for the rules it holds", () => {
    assert.equal(schemeEditStatusOnApi("Validated", []), "Validated")
    assert.equal(schemeEditStatusOnApi("Validated", ["Pick a driver"]), "Validated")
  })

  test("a Draft the edit leaves without a blocking issue asks to be Validated; one with issues, or without a recurrence to judge, stays a Draft", () => {
    assert.equal(schemeEditStatusOnApi("Draft", []), "Validated")
    assert.equal(schemeEditStatusOnApi("Draft", ["Pick a vehicle"]), "Draft")
    assert.equal(schemeEditStatusOnApi("Draft", null), "Draft")
  })
})
