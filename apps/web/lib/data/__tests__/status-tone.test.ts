// A status chip's tone (`statusClasses`, business-record-views.tsx): an issued
// invoice is the normal state of a fresh one, never the destructive red its
// spelling's "issue" used to match (#261); a fault called an issue still is.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { statusClasses } from "@/components/waste/business-record-views"

const tone = (status: string) => (statusClasses(status).includes("rose") ? "red" : statusClasses(status).includes("teal") ? "green" : "other")

describe("statusClasses", () => {
  test("an issued invoice is a good state, as an active or published row is", () => {
    assert.equal(tone("Issued"), "green")
    assert.equal(tone("Published"), "green")
  })

  test("an issue, or issues, is still a fault, as a failure is", () => {
    assert.equal(tone("Issue"), "red")
    assert.equal(tone("Issues found"), "red")
    assert.equal(tone("Failed"), "red")
  })
})
