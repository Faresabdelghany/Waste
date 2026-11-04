// A project's retention (#291 C19, #381): its own days where its policy names
// them, else the deployment's setting; a position never past its ceiling,
// and a photo with neither kept for good, as before policies.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { POSITION_RETENTION_CEILING_DAYS } from "../../execution/positions"
import { effectiveRetentionDays, RETENTION_DAYS_BOUNDS } from "../retention"

describe("a project's retention", () => {
  test("a project's own days win over the deployment's setting", () => {
    assert.equal(effectiveRetentionDays("proofs", 90, 365), 90)
    assert.equal(effectiveRetentionDays("positions", 7, 30), 7)
  })

  test("with no policy the deployment's setting stands, exactly as before policies", () => {
    assert.equal(effectiveRetentionDays("proofs", null, 365), 365)
    assert.equal(effectiveRetentionDays("positions", null, 14), 14)
  })

  test("a photo with neither a policy nor a setting is kept for good; a position is kept to the ceiling", () => {
    assert.equal(effectiveRetentionDays("proofs", null, undefined), null)
    assert.equal(effectiveRetentionDays("positions", null, undefined), POSITION_RETENTION_CEILING_DAYS)
  })

  test("a position is never kept past the ceiling, whichever names more", () => {
    assert.equal(effectiveRetentionDays("positions", null, 90), POSITION_RETENTION_CEILING_DAYS)
    assert.equal(RETENTION_DAYS_BOUNDS.positions.max, POSITION_RETENTION_CEILING_DAYS)
  })
})
