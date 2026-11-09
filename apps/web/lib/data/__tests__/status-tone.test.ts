// A status chip's tone (`recordStatusTone`, business-record-views.tsx): an
// issued invoice is the normal state of a fresh one, never the destructive red
// its spelling's "issue" used to match (#261); a fault called an issue still is.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { recordStatusTone } from "@/components/platform/business-record-views"

describe("recordStatusTone", () => {
  test("an issued invoice is a good state, as an active or published row is", () => {
    assert.equal(recordStatusTone("Issued"), "success")
    assert.equal(recordStatusTone("Published"), "success")
  })

  test("an issue, or issues, is still a fault, as a failure is", () => {
    assert.equal(recordStatusTone("Issue"), "destructive")
    assert.equal(recordStatusTone("Issues found"), "destructive")
    assert.equal(recordStatusTone("Failed"), "destructive")
  })
})
