import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Refused } from "../refusal"

describe("Refused", () => {
  test("a conflict is an Error carrying its sentence as the message and nothing of an answer", () => {
    const error = Refused.conflict("This alert is resolved and does not change")
    assert.ok(error instanceof Error)
    assert.equal(error.name, "Refused")
    assert.equal(error.message, "This alert is resolved and does not change")
    assert.deepEqual(error.refusal, { reason: "conflict", sentence: "This alert is resolved and does not change" })
  })

  test("an invalid value names the input it came in", () => {
    const error = Refused.invalid("alertId", "Not an alert of this project")
    assert.deepEqual(error.refusal, { reason: "invalid", input: "alertId", sentence: "Not an alert of this project" })
    assert.equal(error.message, "Not an alert of this project")
  })

  test("a refusal a rule answered as a value is thrown as it stands", () => {
    const refusal = { reason: "invalid", input: "wasteFractionIds.2", sentence: "Not taken at this site" } as const
    assert.equal(new Refused(refusal).refusal, refusal)
  })
})
