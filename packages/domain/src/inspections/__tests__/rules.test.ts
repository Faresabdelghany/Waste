// A field inspection's rules (M23 of #293): its verdict and findings agree.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { A_FINDING_TO_FOLLOW_UP, COMPLIANT_FINDS_NOTHING, EACH_FINDING_ONCE, findingsIssue } from "../rules"

describe("findingsIssue", () => {
  test("a compliant visit found nothing, a minor or a major one something, each once", () => {
    assert.equal(findingsIssue("compliant", []), undefined)
    assert.equal(findingsIssue("compliant", ["damaged"]), COMPLIANT_FINDS_NOTHING)
    assert.equal(findingsIssue("minor", []), A_FINDING_TO_FOLLOW_UP)
    assert.equal(findingsIssue("major", ["contamination", "overfilled"]), undefined)
    assert.equal(findingsIssue("major", ["contamination", "contamination"]), EACH_FINDING_ONCE)
  })
})
