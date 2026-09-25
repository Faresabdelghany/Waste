import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { PROOF_SHAPES, proofShape, proofShapeIssue, type ProofRow } from "@waste/domain/execution/proof-shapes"
import { PROOF_KINDS, type ProofKind } from "@waste/domain/execution/vocabulary"

import { ProofOfService } from "../proofs"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"
const THIRD = "01a0d3a5-e5e0-7000-8000-000000000003"
const WHEN = "2026-10-05T06:20:00.000Z"
const POINT = { type: "Point", coordinates: [12.5951, 55.7089] }
const KEY = `${OTHER}/${THIRD}/${ID}.jpg`

/** The columns the shape decides over, as a full row would carry them. */
const full = { reason: "inaccessible", objectKey: KEY, weightKg: 148, outcome: "failed", note: "Gate locked" } as const

/** The one row of each kind that carries exactly what the kind requires, from the source it may come from. */
const exemplar = (kind: ProofKind): ProofRow => {
  const shape = PROOF_SHAPES[kind]
  return {
    pickupId: THIRD,
    reason: shape.reason === "none" ? null : full.reason,
    objectKey: shape.objectKey === "none" ? null : full.objectKey,
    weightKg: shape.weightKg === "none" ? null : full.weightKg,
    outcome: shape.outcome === "none" ? null : full.outcome,
    note: shape.note === "none" ? null : full.note,
    source: shape.source === "dispatch" ? "dispatch" : "driver-app",
  }
}

/** A whole proof of the kind, on the wire: the exemplar's columns beside the ids, the instant and the device. */
const proof = (kind: ProofKind, row: ProofRow = exemplar(kind)) => ({
  id: ID,
  recordedAt: WHEN,
  projectId: OTHER,
  routeId: THIRD,
  sessionId: row.source === "driver-app" ? ID : null,
  kind,
  occurredAt: WHEN,
  recordedBy: OTHER,
  deviceId: row.source === "driver-app" ? "device-7" : null,
  location: POINT,
  locationAccuracyM: 8,
  ...row,
})

describe("ProofOfService", () => {
  test("is a ledger row — an id and recordedAt, never updatedAt — that parses whole for every kind's exemplar", () => {
    for (const kind of PROOF_KINDS) assert.deepEqual(ProofOfService.parse(proof(kind)), proof(kind), kind)
    assert.equal(Object.keys(ProofOfService.shape).includes("updatedAt"), false)
    assert.equal(Object.keys(ProofOfService.shape).includes("createdAt"), false)
  })

  test("runs the domain's table as its refine: a row that disagrees with its kind does not parse, and the sentence names the column at kind", () => {
    const columns = ["reason", "objectKey", "weightKg", "outcome", "note"] as const
    let disagreements = 0
    for (const kind of PROOF_KINDS) {
      for (const column of columns) {
        for (const value of [full[column], null]) {
          const row = { ...exemplar(kind), [column]: value }
          const expected = proofShape(kind, row)
          const result = ProofOfService.safeParse(proof(kind, row))
          assert.equal(result.success, expected, `${kind} with ${column} = ${JSON.stringify(value)}`)
          if (!expected) {
            disagreements += 1
            assert.deepEqual(refusal(result), [{ path: "kind", message: proofShapeIssue(kind, row) }])
          }
        }
      }
      const onRoute = { ...exemplar(kind), pickupId: null }
      assert.equal(ProofOfService.safeParse(proof(kind, onRoute)).success, PROOF_SHAPES[kind].pickup === "optional", `${kind} on the route alone`)
    }
    assert.ok(disagreements > 20, `${disagreements} disagreements refused`)
    assert.deepEqual(refusal(ProofOfService.safeParse(proof("correction", { ...exemplar("correction"), source: "driver-app" }))), [{ path: "kind", message: "A correction proof comes from dispatch" }])
  })

  test("holds the point flat, the weight and the accuracy positive, the key to its shape, and the reason and outcome to their vocabularies", () => {
    assert.deepEqual(refusal(ProofOfService.safeParse({ ...proof("arrival"), location: { type: "Point", coordinates: [12.5951, 55.7089, 10] } })).map((issue) => issue.path), ["location.coordinates"])
    assert.deepEqual(refusal(ProofOfService.safeParse({ ...proof("weight"), weightKg: 0 })).map((issue) => issue.path), ["weightKg"])
    assert.deepEqual(refusal(ProofOfService.safeParse({ ...proof("arrival"), locationAccuracyM: -1 })).map((issue) => issue.path), ["locationAccuracyM"])
    assert.deepEqual(refusal(ProofOfService.safeParse({ ...proof("photo"), objectKey: "photo.jpg" })).map((issue) => issue.path), ["objectKey"])
    assert.deepEqual(refusal(ProofOfService.safeParse({ ...proof("skip"), reason: "lunch" })).map((issue) => issue.path), ["reason"])
    assert.deepEqual(refusal(ProofOfService.safeParse({ ...proof("correction"), outcome: "rescheduled" })).map((issue) => issue.path), ["outcome"])
    assert.deepEqual(ProofOfService.parse({ ...proof("note"), location: null, locationAccuracyM: null }), { ...proof("note"), location: null, locationAccuracyM: null })
  })
})
