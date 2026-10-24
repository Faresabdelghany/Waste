import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { answeredByRecord, replyFromRecord, stopEvidenceOf, type EvidenceProof } from "../evidence"

const proof = (kind: EvidenceProof["kind"], occurredAt: string, extra: Partial<EvidenceProof> = {}): EvidenceProof => ({ id: `${kind}-${occurredAt}`, kind, occurredAt, location: null, objectKey: null, ...extra })

describe("stopEvidenceOf", () => {
  test("the stop's outcome, when it was recorded, where the device stood for it, and the proofs a resident may be told of, in recording order", () => {
    const evidence = stopEvidenceOf(
      { status: "failed", reason: "not-presented", arrivedAt: "2026-10-24T05:40:00Z", outcomeAt: "2026-10-24T05:42:00Z" },
      [
        proof("arrival", "2026-10-24T05:40:00Z", { location: [12.6, 55.7] }),
        proof("photo", "2026-10-24T05:41:00Z", { objectKey: "c/r/p.jpg", location: [12.6001, 55.7001] }),
        proof("failure", "2026-10-24T05:42:00Z", { location: [12.6002, 55.7002] }),
        proof("route-started", "2026-10-24T05:00:00Z"),
      ],
    )
    assert.deepEqual(evidence, {
      outcome: "failed",
      reason: "not-presented",
      at: "2026-10-24T05:42:00Z",
      location: [12.6002, 55.7002],
      proofs: [
        proof("arrival", "2026-10-24T05:40:00Z", { location: [12.6, 55.7] }),
        proof("photo", "2026-10-24T05:41:00Z", { objectKey: "c/r/p.jpg", location: [12.6001, 55.7001] }),
        proof("failure", "2026-10-24T05:42:00Z", { location: [12.6002, 55.7002] }),
      ],
    })
  })

  test("a correction is the outcome's latest word: its place stands where the office recorded it, and the arrival's place stands in for an outcome recorded without one", () => {
    const corrected = stopEvidenceOf({ status: "completed", reason: null, arrivedAt: null, outcomeAt: "2026-10-24T09:00:00Z" }, [
      proof("failure", "2026-10-24T05:42:00Z", { location: [1, 1] }),
      proof("correction", "2026-10-24T09:00:00Z", { location: null }),
    ])
    assert.equal(corrected.location, null, "the correction is the office's: it stands nowhere")
    const arrivedOnly = stopEvidenceOf({ status: "completed", reason: null, arrivedAt: "2026-10-24T05:40:00Z", outcomeAt: "2026-10-24T05:45:00Z" }, [
      proof("arrival", "2026-10-24T05:40:00Z", { location: [2, 2] }),
      proof("completion", "2026-10-24T05:45:00Z"),
    ])
    assert.deepEqual(arrivedOnly.location, [2, 2])
    assert.equal(stopEvidenceOf({ status: "planned", reason: null, arrivedAt: null, outcomeAt: null }, []).at, null)
  })
})

describe("answeredByRecord", () => {
  test("a missed collection is answered by the record where the stop says the bin was not presented, and only then", () => {
    const notPresented = stopEvidenceOf({ status: "failed", reason: "not-presented", arrivedAt: null, outcomeAt: "2026-10-24T05:42:00Z" }, [])
    assert.equal(answeredByRecord("missed-collection", notPresented), true)
    assert.equal(answeredByRecord("complaint", notPresented), false, "another kind of case is the office's to judge")
    assert.equal(answeredByRecord("missed-collection", { ...notPresented, reason: "inaccessible" }), false)
    assert.equal(answeredByRecord("missed-collection", { ...notPresented, outcome: "planned", reason: null, at: null }), false)
  })
})

describe("replyFromRecord", () => {
  test("says what the stop's record says, at the time given on the project's clock, and that a photo was taken", () => {
    const notPresented = stopEvidenceOf({ status: "failed", reason: "not-presented", arrivedAt: null, outcomeAt: "2026-10-24T05:42:00Z" }, [proof("photo", "2026-10-24T05:41:00Z", { objectKey: "c/r/p.jpg" })])
    assert.equal(
      replyFromRecord(notPresented, "07:42 on Saturday 24 October"),
      "Our driver was at the address at 07:42 on Saturday 24 October and recorded that the bin was not put out for collection. A photo was taken at the stop.",
    )
    const collected = stopEvidenceOf({ status: "completed", reason: null, arrivedAt: null, outcomeAt: "2026-10-24T05:45:00Z" }, [])
    assert.equal(replyFromRecord(collected, "07:45 on Saturday 24 October"), "Our driver collected the bin at 07:45 on Saturday 24 October.")
    const blocked = stopEvidenceOf({ status: "skipped", reason: "inaccessible", arrivedAt: null, outcomeAt: "2026-10-24T05:50:00Z" }, [])
    assert.equal(replyFromRecord(blocked, "07:50 on Saturday 24 October"), "Our driver was at the address at 07:50 on Saturday 24 October and could not collect the bin: the bin could not be reached.")
    const planned = stopEvidenceOf({ status: "planned", reason: null, arrivedAt: null, outcomeAt: null }, [])
    assert.equal(replyFromRecord(planned, null), "The collection has not been recorded yet.")
  })
})
