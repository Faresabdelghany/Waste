// A ticket answered with evidence (Issue #293, M6): what the stop a ticket
// is about recorded — its outcome, when, where the device stood for it, and
// the proofs taken there — read as one thing for the office's ticket and for
// the reply a resident is sent, so the two say the same.
//
// The outcome's place is its latest outcome proof's (a completion, a skip, a
// failure, or the office's correction, which stands nowhere); an outcome
// recorded without a place lends the arrival's. A missed-collection report
// against a stop recorded `not-presented` is answered by the record itself
// (`answeredByRecord`): the bin was not out, and the case need not open.
//
// The reply's words are English until M21. The time it quotes is given
// already written on the project's clock, since this module reads no clock
// and formats no date: the caller does, as every date rule here leaves it.
import type { PickupReason, PickupStatus, ProofKind } from "../execution/vocabulary"
import type { TicketKind } from "./vocabulary"

/** A coordinate pair, longitude first, as the wire's points are. */
export type Coordinates = readonly [number, number]

/** The stop as its record reads. */
export type EvidenceStop = { status: PickupStatus; reason: PickupReason | null; arrivedAt: string | null; outcomeAt: string | null }

/** One proof recorded at the stop. */
export type EvidenceProof = { id: string; kind: ProofKind; occurredAt: string; location: Coordinates | null; objectKey: string | null }

/** What the stop's record says: the outcome, when, where, and the proofs a resident may be told of. */
export type StopEvidence = { outcome: PickupStatus; reason: PickupReason | null; at: string | null; location: Coordinates | null; proofs: EvidenceProof[] }

/** The proofs that record an outcome; the office's correction is one, and stands where it was recorded, nowhere. */
const OUTCOME_KINDS: ReadonlySet<ProofKind> = new Set(["completion", "skip", "failure", "correction"])
/** The route's own proofs, never the stop's. */
const ROUTE_KINDS: ReadonlySet<ProofKind> = new Set(["route-started", "route-ended"])

/** The stop's evidence from its row and its proofs in recording order. */
export function stopEvidenceOf(stop: EvidenceStop, proofs: readonly EvidenceProof[]): StopEvidence {
  const told = proofs.filter((proof) => !ROUTE_KINDS.has(proof.kind))
  const outcome = [...told].reverse().find((proof) => OUTCOME_KINDS.has(proof.kind))
  const arrival = told.find((proof) => proof.kind === "arrival")
  const location = outcome === undefined ? (arrival?.location ?? null) : outcome.kind === "correction" ? outcome.location : (outcome.location ?? arrival?.location ?? null)
  return { outcome: stop.status, reason: stop.reason, at: stop.outcomeAt ?? stop.arrivedAt, location, proofs: told }
}

/** Whether a case of `kind` is answered by the stop's record alone: a missed collection where the bin was not presented. */
export const answeredByRecord = (kind: TicketKind, evidence: StopEvidence): boolean =>
  kind === "missed-collection" && (evidence.outcome === "failed" || evidence.outcome === "skipped") && evidence.reason === "not-presented"

/** Why a stop was not collected, as a resident reads it. */
const NOT_COLLECTED_BECAUSE: Partial<Record<PickupReason, string>> = {
  inaccessible: "the bin could not be reached",
  contamination: "the bin held waste that does not belong in it",
  capacity: "the vehicle was full",
  safety: "it was not safe to collect it",
}

/** The reply that quotes the stop's record, `when` being its time already written on the project's clock. */
export function replyFromRecord(evidence: StopEvidence, when: string | null): string {
  if (evidence.outcome === "planned" || when === null) return "The collection has not been recorded yet."
  if (evidence.outcome === "completed") return `Our driver collected the bin at ${when}.`
  const photo = evidence.proofs.some((proof) => proof.kind === "photo") ? " A photo was taken at the stop." : ""
  if (evidence.reason === "not-presented") return `Our driver was at the address at ${when} and recorded that the bin was not put out for collection.${photo}`
  const because = (evidence.reason === null ? undefined : NOT_COLLECTED_BECAUSE[evidence.reason]) ?? "the collection did not take place"
  return `Our driver was at the address at ${when} and could not collect the bin: ${because}.${photo}`
}
