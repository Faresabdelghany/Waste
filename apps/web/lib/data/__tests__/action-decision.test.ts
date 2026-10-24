// The status dialog's governance (Issue #251): what it asks and what it
// promises, by where the record lives. In fixture mode the prototype's
// governed action stands — a reason, an effective date, an audit row the
// browser keeps. On a module the API holds, the status is all a wire takes:
// no patch carries a reason or a date for it, and the API keeps no audit
// row, so the dialog offers neither and promises neither.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { actionDecisionShape, actionRecordedSentence } from "../action-decision"

describe("the status dialog in fixture mode", () => {
  test("asks a reason before it confirms, offers an effective date, and keeps the browser's audit row", () => {
    const shape = actionDecisionShape({ onApi: false, createsCompanion: false })
    assert.deepEqual(
      { asksReason: shape.asksReason, asksEffectiveDate: shape.asksEffectiveDate, keepsBrowserAudit: shape.keepsBrowserAudit },
      { asksReason: true, asksEffectiveDate: true, keepsBrowserAudit: true },
    )
    assert.match(shape.promise, /appended to audit history/)
  })

  test("a companion record says the source stays unchanged", () => {
    assert.match(actionDecisionShape({ onApi: false, createsCompanion: true }).promise, /source record remains unchanged/)
  })

  test("the recorded toast says the audit history moved", () => {
    assert.equal(actionRecordedSentence({ onApi: false, before: "Draft", after: "Active" }), "Draft → Active · audit history updated")
    assert.equal(actionRecordedSentence({ onApi: false, before: "Active", after: "Active" }), "The action and evidence were appended without bypassing the lifecycle.")
  })
})

describe("the status dialog on a module the API holds (#251)", () => {
  const shape = actionDecisionShape({ onApi: true, createsCompanion: false })

  test("asks no reason and offers no effective date: no wire takes either for a status", () => {
    assert.equal(shape.asksReason, false)
    assert.equal(shape.asksEffectiveDate, false)
  })

  test("promises the change now on the API and no audit row, and the browser keeps none either", () => {
    assert.equal(shape.keepsBrowserAudit, false)
    assert.doesNotMatch(shape.promise, /audit/i)
    assert.match(shape.promise, /now/)
  })

  test("the recorded toast names the move and nothing it did not do", () => {
    assert.equal(actionRecordedSentence({ onApi: true, before: "Draft", after: "Active" }), "Draft → Active")
  })
})
