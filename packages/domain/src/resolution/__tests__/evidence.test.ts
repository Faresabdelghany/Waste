import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { PickupReason } from "../../execution/vocabulary"
import { answeredByRecord, replyFromRecord, stopEvidenceOf, type EvidenceProof, type EvidenceStop } from "../evidence"

const proof = (kind: EvidenceProof["kind"], occurredAt: string, extra: Partial<EvidenceProof> = {}): EvidenceProof => ({ id: `${kind}-${occurredAt}`, kind, occurredAt, location: null, objectKey: null, ...extra })
const stop = (values: Partial<EvidenceStop>): EvidenceStop => ({ status: "failed", reason: "not-presented", service: "empty", arrivedAt: null, outcomeAt: "2026-10-24T05:42:00Z", ...values })
const WHEN = "07:42 on Saturday 24 October"

describe("stopEvidenceOf", () => {
  test("the stop's outcome, when it was recorded, where the device stood for it, and the proofs a resident may be told of, in recording order", () => {
    const proofs = [
      proof("arrival", "2026-10-24T05:40:00Z", { location: [12.6, 55.7] }),
      proof("photo", "2026-10-24T05:41:00Z", { objectKey: "c/r/p.jpg", location: [12.6001, 55.7001] }),
      proof("failure", "2026-10-24T05:42:00Z", { location: [12.6002, 55.7002] }),
    ]
    assert.deepEqual(stopEvidenceOf(stop({ arrivedAt: "2026-10-24T05:40:00Z" }), proofs), {
      outcome: "failed",
      reason: "not-presented",
      service: "empty",
      corrected: false,
      at: "2026-10-24T05:42:00Z",
      location: [12.6002, 55.7002],
      proofs,
    })
  })

  test("a correction is the outcome's latest word and the office's: its place stands where the office recorded it, and the arrival's place stands in for an outcome recorded without one", () => {
    const corrected = stopEvidenceOf(stop({ status: "completed", reason: null, outcomeAt: "2026-10-24T09:00:00Z" }), [
      proof("failure", "2026-10-24T05:42:00Z", { location: [1, 1] }),
      proof("correction", "2026-10-24T09:00:00Z", { location: null }),
    ])
    assert.deepEqual([corrected.corrected, corrected.location], [true, null], "the correction is the office's: it stands nowhere")
    const arrivedOnly = stopEvidenceOf(stop({ status: "completed", reason: null, arrivedAt: "2026-10-24T05:40:00Z", outcomeAt: "2026-10-24T05:45:00Z" }), [
      proof("arrival", "2026-10-24T05:40:00Z", { location: [2, 2] }),
      proof("completion", "2026-10-24T05:45:00Z"),
    ])
    assert.deepEqual([arrivedOnly.corrected, arrivedOnly.location], [false, [2, 2]])
    assert.equal(stopEvidenceOf(stop({ status: "planned", reason: null, outcomeAt: null }), []).at, null)
  })
})

describe("answeredByRecord", () => {
  test("a missed collection is answered by the record where the driver recorded the bin was not presented at an emptying, and only then", () => {
    const notPresented = stopEvidenceOf(stop({}), [proof("failure", "2026-10-24T05:42:00Z")])
    assert.equal(answeredByRecord("missed-collection", notPresented), true)
    assert.equal(answeredByRecord("missed-collection", stopEvidenceOf(stop({ status: "skipped" }), [proof("skip", "2026-10-24T05:42:00Z")])), true)
    assert.equal(answeredByRecord("complaint", notPresented), false, "another kind of case is the office's to judge")
    assert.equal(answeredByRecord("missed-collection", { ...notPresented, reason: "inaccessible" }), false)
    assert.equal(answeredByRecord("missed-collection", { ...notPresented, outcome: "planned", reason: null, at: null }), false)
    assert.equal(answeredByRecord("missed-collection", stopEvidenceOf(stop({}), [proof("correction", "2026-10-24T09:00:00Z")])), false, "the office's correction is its word, not the driver's record: the office judges the case")
    assert.equal(answeredByRecord("missed-collection", stopEvidenceOf(stop({ service: "wash" }), [])), false, "a work order not done is never a missed collection")
  })
})

describe("replyFromRecord", () => {
  test("says what the driver recorded at an emptying, at the time given on the project's clock, and that a photo was taken", () => {
    const notPresented = stopEvidenceOf(stop({}), [proof("photo", "2026-10-24T05:41:00Z", { objectKey: "c/r/p.jpg" }), proof("failure", "2026-10-24T05:42:00Z")])
    assert.equal(replyFromRecord(notPresented, WHEN), `Our driver was at the address at ${WHEN} and recorded that the bin was not put out for collection. A photo was taken at the stop.`)
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ status: "completed", reason: null }), []), WHEN), `Our driver collected the bin at ${WHEN}.`)
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ status: "skipped", reason: "inaccessible" }), []), WHEN), `Our driver was at the address at ${WHEN} and could not collect the bin: the bin could not be reached.`)
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ reason: "other" }), []), WHEN), `Our driver was at the address at ${WHEN} and could not collect the bin: the collection did not take place.`)
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ status: "planned", reason: null, outcomeAt: null }), []), null), "The collection has not been recorded yet.")
  })

  test("tells of a bulky collection (O11 of #290) as the bulky items collected, or not", () => {
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ service: "bulky", status: "completed", reason: null }), []), WHEN), `Our driver collected the bulky items at ${WHEN}.`)
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ service: "bulky", status: "failed", reason: "other" }), []), WHEN), `Our driver was at the address at ${WHEN} and could not collect the bulky items: the visit did not take place.`)
  })

  test("never puts the driver at an address the driver never reached: the route's end, its cancellation, the dispatcher and generation each say what happened", () => {
    const closed = (reason: PickupReason) => replyFromRecord(stopEvidenceOf(stop({ status: "skipped", reason }), []), WHEN)
    assert.equal(closed("route-ended"), `The bin was not collected: the route ended at ${WHEN} before our driver reached it.`)
    assert.equal(closed("route-cancelled"), `The bin was not collected: the route was cancelled at ${WHEN}.`)
    assert.equal(closed("removed-by-dispatcher"), `The bin was not collected: the stop was taken off the route at ${WHEN}.`)
    assert.equal(closed("regeneration"), `The bin was not collected: the collection was planned again at ${WHEN}.`)
  })

  test("an outcome the office corrected is the office's review, never the driver's act at the correction's time", () => {
    const toCollected = stopEvidenceOf(stop({ status: "completed", reason: null }), [proof("failure", "2026-10-24T05:42:00Z"), proof("correction", "2026-10-24T09:00:00Z")])
    assert.equal(replyFromRecord(toCollected, WHEN), `Our office reviewed the collection at ${WHEN} and recorded the bin as collected.`)
    const toNotPresented = stopEvidenceOf(stop({}), [proof("correction", "2026-10-24T09:00:00Z")])
    assert.equal(replyFromRecord(toNotPresented, WHEN), `Our office reviewed the collection at ${WHEN} and recorded that the bin was not put out for collection.`)
  })

  test("a work order is a visit to the container, never a collection of the bin", () => {
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ status: "completed", reason: null, service: "deliver" }), []), WHEN), `Our driver delivered the container at ${WHEN}.`)
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ reason: "inaccessible", service: "wash" }), []), WHEN), `Our driver was at the address at ${WHEN} and could not wash the container: the bin could not be reached.`)
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ status: "skipped", reason: "route-ended", service: "repair" }), []), WHEN), `The visit did not take place: the route ended at ${WHEN} before our driver reached it.`)
    assert.equal(replyFromRecord(stopEvidenceOf(stop({ status: "planned", reason: null, service: "swap", outcomeAt: null }), []), null), "The visit has not been recorded yet.")
  })

  test("the longest reply leaves the office's note its whole bound inside a comment's", () => {
    // The contracts bound the note at 1,500 characters and a comment's body at 2,000 (`PARAGRAPH_MAX`): the reply and the blank line between take the rest.
    const replies = (["not-presented", "inaccessible", "contamination", "capacity", "safety", "other", "route-ended", "route-cancelled", "removed-by-dispatcher", "regeneration"] as const).flatMap((reason) =>
      (["empty", "deliver", "remove", "swap", "repair", "wash"] as const).map((service) => replyFromRecord(stopEvidenceOf(stop({ reason, service }), [proof("photo", "2026-10-24T05:41:00Z")]), "23:59 on Wednesday 30 September")),
    )
    assert.ok(Math.max(...replies.map((reply) => reply.length)) + 2 + 1500 <= 2000)
  })
})
