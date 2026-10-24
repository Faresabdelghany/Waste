// The status dialog's governance (Issue #251): what it asks and what it
// promises, by where the record lives. In fixture mode the prototype's
// governed action stands — a reason, an effective date, an audit row the
// browser keeps. On a module the API holds, a patch carries the status and
// no date, and the API's audit log keeps the change (#291): the dialog asks a
// reason, which travels in the change-reason header and is not required, and
// offers no date.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PARAGRAPH_MAX } from "@waste/contracts/text"

import { actionDecisionShape, actionRecordedSentence, REASON_MAX } from "../action-decision"

describe("the status dialog in fixture mode", () => {
  test("asks a reason before it confirms, offers an effective date, and keeps the browser's audit row", () => {
    const shape = actionDecisionShape({ onApi: false, createsCompanion: false })
    assert.deepEqual(
      { asksReason: shape.asksReason, requiresReason: shape.requiresReason, asksEffectiveDate: shape.asksEffectiveDate, keepsBrowserAudit: shape.keepsBrowserAudit },
      { asksReason: true, requiresReason: true, asksEffectiveDate: true, keepsBrowserAudit: true },
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

describe("the status dialog on a module the API holds (#251, #291)", () => {
  const shape = actionDecisionShape({ onApi: true, createsCompanion: false })

  test("asks a reason, not required, for the audit log, and offers no effective date: no wire takes a date for a status", () => {
    assert.equal(shape.asksReason, true)
    assert.equal(shape.requiresReason, false)
    assert.equal(shape.asksEffectiveDate, false)
  })

  test("promises the change now and the API's audit log of who and why; the browser keeps no row of its own", () => {
    assert.equal(shape.keepsBrowserAudit, false)
    assert.equal(shape.promise, "The status changes now, as the API holds it, and its audit log keeps who changed it and the reason given.")
  })

  test("a reason is held to the bound the API holds the header to", () => {
    assert.equal(REASON_MAX, PARAGRAPH_MAX)
  })

  test("the recorded toast names the move and nothing it did not do", () => {
    assert.equal(actionRecordedSentence({ onApi: true, before: "Draft", after: "Active" }), "Draft → Active")
  })
})
