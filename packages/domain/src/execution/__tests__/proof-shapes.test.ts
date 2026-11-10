import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PROOF_SHAPES, proofShape, proofShapeIssue, type ProofRow } from "../proof-shapes"
import { CODED_PROOF_KINDS, EXECUTION_SOURCES, PROOF_KINDS, type ProofKind } from "../vocabulary"

const full: ProofRow = { pickupId: "pickup", reason: "inaccessible", objectKey: "c/r/k.jpg", weightKg: 148, volumeLitres: 2800, outcome: "failed", note: "Gate locked", source: "driver-app" }
const bare: ProofRow = { pickupId: null, reason: null, objectKey: null, weightKg: null, volumeLitres: null, outcome: null, note: null, source: "driver-app" }

/** The one row of each kind that carries exactly what the kind requires and nothing it forbids, from the source it may come from. */
const exemplar = (kind: ProofKind): ProofRow => {
  const shape = PROOF_SHAPES[kind]
  return {
    pickupId: shape.pickup === "none" ? null : "pickup",
    reason: shape.reason === "none" ? null : "inaccessible",
    objectKey: shape.objectKey === "none" ? null : "c/r/k.jpg",
    weightKg: shape.weightKg === "none" ? null : 148,
    volumeLitres: shape.volumeLitres === "none" ? null : 2800,
    outcome: shape.outcome === "none" ? null : "failed",
    note: shape.note === "none" ? null : "Gate locked",
    source: shape.source === "dispatch" ? "dispatch" : "driver-app",
  }
}

describe("proofShape", () => {
  test("a contaminant code tags the proofs that record an outcome, and no other (M5 of #293)", () => {
    for (const kind of PROOF_KINDS) {
      const coded = { ...exemplar(kind), contaminantCodeId: "plastic-in-organic" }
      const tags = (CODED_PROOF_KINDS as readonly ProofKind[]).includes(kind)
      assert.equal(proofShape(kind, coded), tags, kind)
      if (!tags) assert.equal(proofShapeIssue(kind, coded), `A ${kind} proof carries no contaminantCodeId`)
    }
    assert.deepEqual([...CODED_PROOF_KINDS], ["completion", "skip", "failure", "correction"])
  })


  test("every kind's exemplar passes, and the same row under every other kind fails unless that kind carries the same", () => {
    for (const kind of PROOF_KINDS) {
      assert.equal(proofShape(kind, exemplar(kind)), true, kind)
      assert.equal(proofShapeIssue(kind, exemplar(kind)), undefined, kind)
    }
    // A completion's exemplar is also what an arrival carries, and a skip's what a failure carries; nothing else coincides.
    assert.equal(proofShape("arrival", exemplar("completion")), true)
    assert.equal(proofShape("failure", exemplar("skip")), true)
    assert.equal(proofShape("skip", exemplar("photo")), false)
    assert.equal(proofShape("weight", exemplar("signature")), false)
    assert.equal(proofShape("weight", exemplar("volume")), false)
    assert.equal(proofShape("volume", exemplar("weight")), false)
  })

  test("each column set or unset against its kind's rule, one column at a time, over every kind: the sentence names the column", () => {
    const columns = ["reason", "objectKey", "weightKg", "volumeLitres", "outcome", "note"] as const
    for (const kind of PROOF_KINDS) {
      const shape = PROOF_SHAPES[kind]
      for (const column of columns) {
        const given = { ...exemplar(kind), [column]: full[column] }
        const absent = { ...exemplar(kind), [column]: null }
        assert.equal(proofShape(kind, given), shape[column] !== "none", `${kind} with ${column}`)
        assert.equal(proofShape(kind, absent), shape[column] !== "required", `${kind} without ${column}`)
        if (shape[column] === "required") assert.equal(proofShapeIssue(kind, absent), `A ${kind} proof carries ${column}`)
        if (shape[column] === "none") assert.equal(proofShapeIssue(kind, given), `A ${kind} proof carries no ${column}`)
      }
      // The pickup: a stop's kind names one, the route's two name none, the others may stand on the route.
      const onRoute = { ...exemplar(kind), pickupId: null }
      assert.equal(proofShape(kind, onRoute), shape.pickup !== "required", `${kind} on the route alone`)
      if (shape.pickup === "required") assert.equal(proofShapeIssue(kind, onRoute), `A ${kind} proof names a pickup`)
      const onAStop = { ...exemplar(kind), pickupId: "pickup" }
      assert.equal(proofShape(kind, onAStop), shape.pickup !== "none", `${kind} on a stop`)
      if (shape.pickup === "none") assert.equal(proofShapeIssue(kind, onAStop), `A ${kind} proof is the route's and names no pickup`)
      // The source: only a correction is the dispatcher's alone.
      for (const source of EXECUTION_SOURCES) {
        assert.equal(proofShape(kind, { ...exemplar(kind), source }), shape.source === "any" || source === "dispatch", `${kind} from ${source}`)
      }
    }
    assert.equal(proofShapeIssue("correction", { ...exemplar("correction"), source: "driver-app" }), "A correction proof comes from dispatch")
    assert.equal(proofShape("arrival", bare), false, "an arrival names a pickup")
    assert.equal(proofShape("note", { ...bare, note: "x" }), true, "a note may stand on the route")
    assert.equal(proofShape("route-started", bare), true, "the day's start says nothing but that it happened")
    assert.equal(proofShape("route-ended", { ...bare, note: "Done for today" }), true)
  })
})
