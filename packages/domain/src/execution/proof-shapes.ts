// What a Proof of Service of each kind carries (Issue #104): the one table
// the database's `proof_of_service_kind_shape` and `proof_of_service_pickup_shape`
// spell as checks (packages/db/src/schema/execution.ts), the contracts'
// `ProofOfService` runs as a refine, and the applier consults before it
// writes a row — the precedent is Resources' `MOVEMENT_SHAPES`, which the
// ledger's `stock_movement_kind_shape` spells once more as a CASE and a
// database test holds to it over every triple. Here the test runs every kind
// with each column set and unset through both.
//
// The glossary's "time, GPS, photo, weight, signature, or driver event" is ten
// kinds with a shape each. A driver event — `arrival`, `completion`, `skip`,
// `failure`, `problem` — is about a stop, so the first four name a pickup and
// the problem may stand on the route alone (a road closed); a skip, a failure
// and a problem say why (`reason`), and an arrival and a completion say
// nothing but that they happened. The evidence kinds carry their evidence and
// nothing else's: a `photo` and a `signature` carry the Storage object's key
// and nothing else carries one, a `weight` carries whole kilograms and
// nothing else does, a `note` carries its note. A photo and a note may stand
// on the route (a photo of the load), a signature is a stop's. `correction`
// is the dispatcher's audited change of an outcome: it names the pickup,
// carries the outcome the pickup was moved to and a note saying why, and
// comes from `dispatch` and nowhere else; its reason is the outcome's, given
// with a skip or a failure and not otherwise, which the contracts hold
// (`REASON_WITH_A_MISS`) and this table leaves open. Every other kind may
// come from any source.
//
// `proofShape(kind, row)` is the whole rule over a row; `proofShapeIssue` says
// which column disagrees, for the API's sentence before the check's code.
import type { ExecutionSource, ProofKind } from "./vocabulary"

/** Whether a column is given, absent, or either, for a kind. */
export type Presence = "required" | "none" | "any"

/** What one kind of proof carries. */
export type ProofShape = {
  /** Whether the kind is a stop's, or may stand on the route alone. */
  pickup: "required" | "optional"
  reason: Presence
  objectKey: Presence
  weightKg: Presence
  outcome: Presence
  note: Presence
  /** Who may record it: the dispatcher alone, or anyone. */
  source: "dispatch" | "any"
}

/** A row as the rule reads it: the columns the shape decides over. */
export type ProofRow = {
  pickupId: string | null
  reason: string | null
  objectKey: string | null
  weightKg: number | null
  outcome: string | null
  note: string | null
  source: ExecutionSource
}

/** A driver event about a stop, carrying nothing but that it happened. */
const EVENT: ProofShape = { pickup: "required", reason: "none", objectKey: "none", weightKg: "none", outcome: "none", note: "any", source: "any" }
/** A driver event about a stop, saying why. */
const REASONED: ProofShape = { ...EVENT, reason: "required" }
/** A Storage object's key and nothing else. */
const OBJECT: ProofShape = { ...EVENT, objectKey: "required" }

/** The table: what each of the ten kinds carries. */
export const PROOF_SHAPES: Readonly<Record<ProofKind, ProofShape>> = {
  arrival: EVENT,
  completion: EVENT,
  skip: REASONED,
  failure: REASONED,
  problem: { ...REASONED, pickup: "optional", note: "required" },
  photo: { ...OBJECT, pickup: "optional" },
  weight: { ...EVENT, weightKg: "required" },
  signature: OBJECT,
  note: { ...EVENT, pickup: "optional", note: "required" },
  correction: { ...EVENT, reason: "any", outcome: "required", note: "required", source: "dispatch" },
}

/** The columns a `Presence` decides over, in the order the sentence names them. */
const PRESENCE_COLUMNS = ["reason", "objectKey", "weightKg", "outcome", "note"] as const

const holds = (presence: Presence, value: unknown): boolean => (presence === "any" ? true : presence === "required" ? value !== null : value === null)

/** The column that disagrees with the kind's shape, as a sentence; undefined when the row is what its kind carries. */
export function proofShapeIssue(kind: ProofKind, row: ProofRow): string | undefined {
  const shape = PROOF_SHAPES[kind]
  if (shape.pickup === "required" && row.pickupId === null) return `A ${kind} proof names a pickup`
  for (const column of PRESENCE_COLUMNS) {
    if (holds(shape[column], row[column])) continue
    return shape[column] === "required" ? `A ${kind} proof carries ${column}` : `A ${kind} proof carries no ${column}`
  }
  if (shape.source === "dispatch" && row.source !== "dispatch") return `A ${kind} proof comes from dispatch`
  return undefined
}

/** Whether the row is what its kind carries: the pickup, the five columns, the source. */
export const proofShape = (kind: ProofKind, row: ProofRow): boolean => proofShapeIssue(kind, row) === undefined
