import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PROOF_SHAPES, proofShape, proofShapeIssue, type ProofRow } from "../proof-shapes"
import { EXECUTION_SOURCES, PROOF_KINDS, type ProofKind } from "../vocabulary"

/** A row with every column given, from the driver's device. */
const full: ProofRow = { pickupId: "pickup", reason: "inaccessible", objectKey: "c/r/k.jpg", weightKg: 148, outcome: "failed", note: "Gate locked", source: "driver-app" }
/** A row with nothing given but the source. */
const bare: ProofRow = { pickupId: null, reason: null, objectKey: null, weightKg: null, outcome: null, note: null, source: "driver-app" }

/** The one row of each kind that carries exactly what the kind requires and nothing it forbids, from the source it may come from. */
const exemplar = (kind: ProofKind): ProofRow => {
  const shape = PROOF_SHAPES[kind]
  return {
    pickupId: "pickup",
    reason: shape.reason === "none" ? null : "inaccessible",
    objectKey: shape.objectKey === "none" ? null : "c/r/k.jpg",
    weightKg: shape.weightKg === "none" ? null : 148,
    outcome: shape.outcome === "none" ? null : "failed",
    note: shape.note === "none" ? null : "Gate locked",
    source: shape.source === "dispatch" ? "dispatch" : "driver-app",
  }
}

describe("PROOF_SHAPES", () => {
  test("spells the ten kinds: what each names, carries, forbids and comes from", () => {
    assert.deepEqual(Object.keys(PROOF_SHAPES).sort(), [...PROOF_KINDS].sort())
    const requires = (kind: ProofKind) => Object.entries(PROOF_SHAPES[kind]).filter(([, presence]) => presence === "required").map(([column]) => column)
    const forbids = (kind: ProofKind) => Object.entries(PROOF_SHAPES[kind]).filter(([, presence]) => presence === "none").map(([column]) => column)
    // Five driver events: the first four name a pickup, the problem may stand on the route; a skip, a failure and a problem say why.
    assert.deepEqual(requires("arrival"), ["pickup"])
    assert.deepEqual(requires("completion"), ["pickup"])
    assert.deepEqual(requires("skip"), ["pickup", "reason"])
    assert.deepEqual(requires("failure"), ["pickup", "reason"])
    assert.deepEqual(requires("problem"), ["reason", "note"])
    assert.equal(PROOF_SHAPES.problem.pickup, "optional")
    // Four kinds of evidence, each carrying its own and nothing else's.
    assert.deepEqual(requires("photo"), ["objectKey"])
    assert.deepEqual(requires("signature"), ["pickup", "objectKey"])
    assert.deepEqual(requires("weight"), ["pickup", "weightKg"])
    assert.deepEqual(requires("note"), ["note"])
    // The dispatcher's correction.
    assert.deepEqual(requires("correction"), ["pickup", "outcome", "note"])
    assert.equal(PROOF_SHAPES.correction.source, "dispatch")
    assert.equal(PROOF_SHAPES.correction.reason, "any", "the outcome's reason, which the contracts hold to a skip or a failure")
    // An arrival and a completion carry neither reason nor key nor weight; nothing but a photo or a signature carries a key, nothing but a weight a weight.
    assert.deepEqual(forbids("arrival"), ["reason", "objectKey", "weightKg", "outcome"])
    assert.deepEqual(forbids("completion"), ["reason", "objectKey", "weightKg", "outcome"])
    for (const kind of PROOF_KINDS) {
      assert.equal(PROOF_SHAPES[kind].objectKey === "required", kind === "photo" || kind === "signature", kind)
      assert.equal(PROOF_SHAPES[kind].weightKg === "required", kind === "weight", kind)
      assert.equal(PROOF_SHAPES[kind].outcome === "required", kind === "correction", kind)
      assert.equal(PROOF_SHAPES[kind].source === "dispatch", kind === "correction", kind)
    }
  })
})

describe("proofShape", () => {
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
  })

  test("each column set or unset against its kind's rule, one column at a time, over every kind: the sentence names the column", () => {
    const columns = ["reason", "objectKey", "weightKg", "outcome", "note"] as const
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
      // The pickup: a stop's kind names one, the others may stand on the route.
      const onRoute = { ...exemplar(kind), pickupId: null }
      assert.equal(proofShape(kind, onRoute), shape.pickup === "optional", `${kind} on the route alone`)
      if (shape.pickup === "required") assert.equal(proofShapeIssue(kind, onRoute), `A ${kind} proof names a pickup`)
      // The source: only a correction is the dispatcher's alone.
      for (const source of EXECUTION_SOURCES) {
        assert.equal(proofShape(kind, { ...exemplar(kind), source }), shape.source === "any" || source === "dispatch", `${kind} from ${source}`)
      }
    }
    assert.equal(proofShapeIssue("correction", { ...exemplar("correction"), source: "driver-app" }), "A correction proof comes from dispatch")
    assert.equal(proofShape("arrival", bare), false, "an arrival names a pickup")
    assert.equal(proofShape("note", { ...bare, note: "x" }), true, "a note may stand on the route")
  })
})
