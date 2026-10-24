// A ticket answered with evidence (Issue #293, M6): what the stop a ticket
// is about recorded — its outcome, when, where the device stood for it, and
// the proofs taken there — read as one thing for the office's ticket and for
// the reply a resident is sent, so the two say the same.
//
// The outcome's place is its latest outcome proof's (a completion, a skip, a
// failure, or the office's correction, which stands nowhere); an outcome
// recorded without a place lends the arrival's. An outcome that stands on
// the office's correction is the office's word and never the driver's: the
// reply says the office reviewed it, and it answers no case by itself. A
// missed-collection report against an emptying the driver recorded
// `not-presented` is answered by the record itself (`answeredByRecord`): the
// bin was not out, and the case need not open.
//
// The reply says only what happened. A stop the driver never reached — the
// route ended or was cancelled, the dispatcher took it off, generation
// replanned it — is never "our driver was at the address"; a work order is
// a visit to the container, never a collection of the bin.
//
// The reply's words are English until M21. The time it quotes is given
// already written on the project's clock, since this module reads no clock
// and formats no date: the caller does, as every date rule here leaves it.
import type { PickupReason, PickupService, PickupStatus, ProofKind } from "../execution/vocabulary"
import type { TicketKind } from "./vocabulary"

/** A coordinate pair, longitude first, as the wire's points are. */
export type Coordinates = readonly [number, number]

/** The stop as its record reads. */
export type EvidenceStop = { status: PickupStatus; reason: PickupReason | null; service: PickupService; arrivedAt: string | null; outcomeAt: string | null }

/** One proof recorded at the stop, in recording order: the stop's own, since a route's proofs name no stop. */
export type EvidenceProof = { id: string; kind: ProofKind; occurredAt: string; location: Coordinates | null; objectKey: string | null }

/** What the stop's record says: the outcome, whether the office's correction set it, when, where, and the proofs a resident may be told of. */
export type StopEvidence = {
  outcome: PickupStatus
  reason: PickupReason | null
  service: PickupService
  corrected: boolean
  at: string | null
  location: Coordinates | null
  proofs: EvidenceProof[]
}

/** The proofs that record an outcome; the office's correction is one, and stands where it was recorded, nowhere. */
const OUTCOME_KINDS: ReadonlySet<ProofKind> = new Set(["completion", "skip", "failure", "correction"])

/** The stop's evidence from its row and its proofs in recording order. */
export function stopEvidenceOf(stop: EvidenceStop, proofs: readonly EvidenceProof[]): StopEvidence {
  const outcome = [...proofs].reverse().find((proof) => OUTCOME_KINDS.has(proof.kind))
  const arrival = proofs.find((proof) => proof.kind === "arrival")
  const corrected = outcome?.kind === "correction"
  const location = outcome === undefined ? (arrival?.location ?? null) : corrected ? outcome.location : (outcome.location ?? arrival?.location ?? null)
  return { outcome: stop.status, reason: stop.reason, service: stop.service, corrected, at: stop.outcomeAt ?? stop.arrivedAt, location, proofs: [...proofs] }
}

/** Whether a case of `kind` is answered by the stop's record alone: a missed collection where the driver recorded the bin was not presented. */
export const answeredByRecord = (kind: TicketKind, evidence: StopEvidence): boolean =>
  kind === "missed-collection" &&
  evidence.service === "empty" &&
  !evidence.corrected &&
  (evidence.outcome === "failed" || evidence.outcome === "skipped") &&
  evidence.reason === "not-presented"

/** What happened at a stop the driver reached and did not serve, as a resident reads it. */
const WHAT_HAPPENED: Partial<Record<PickupReason, string>> = {
  "not-presented": "the bin was not put out for collection",
  inaccessible: "the bin could not be reached",
  contamination: "the bin held waste that does not belong in it",
  capacity: "the vehicle was full",
  safety: "it was not safe to collect it",
}

/** Why a stop the driver never reached was not served, at the time given. */
const NEVER_REACHED: Partial<Record<PickupReason, (when: string) => string>> = {
  "route-ended": (when) => `the route ended at ${when} before our driver reached it`,
  "route-cancelled": (when) => `the route was cancelled at ${when}`,
  "removed-by-dispatcher": (when) => `the stop was taken off the route at ${when}`,
  regeneration: (when) => `the collection was planned again at ${when}`,
}

/** A work order's verb, as "could not …" and "… the container" read it. */
const VISIT_VERBS: Readonly<Record<Exclude<PickupService, "empty">, { done: string; do: string }>> = {
  deliver: { done: "delivered", do: "deliver" },
  remove: { done: "removed", do: "remove" },
  swap: { done: "swapped", do: "swap" },
  repair: { done: "repaired", do: "repair" },
  wash: { done: "washed", do: "wash" },
}

/** The reply that quotes the stop's record, `when` being its time already written on the project's clock. */
export function replyFromRecord(evidence: StopEvidence, when: string | null): string {
  if (evidence.outcome === "planned" || when === null) return evidence.service === "empty" ? "The collection has not been recorded yet." : "The visit has not been recorded yet."
  const emptying = evidence.service === "empty"
  const verbs = evidence.service === "empty" ? { done: "collected", do: "collect" } : VISIT_VERBS[evidence.service]
  const what = emptying ? "the bin" : "the container"
  const happened = (evidence.reason === null ? undefined : WHAT_HAPPENED[evidence.reason]) ?? (emptying ? "the collection did not take place" : "the visit did not take place")
  if (evidence.corrected) {
    const visit = emptying ? "the collection" : "the visit"
    return evidence.outcome === "completed" ? `Our office reviewed ${visit} at ${when} and recorded ${what} as ${verbs.done}.` : `Our office reviewed ${visit} at ${when} and recorded that ${happened}.`
  }
  if (evidence.outcome === "completed") return `Our driver ${verbs.done} ${what} at ${when}.`
  const unreached = evidence.reason === null ? undefined : NEVER_REACHED[evidence.reason]
  if (unreached !== undefined) return `${emptying ? "The bin was not collected" : "The visit did not take place"}: ${unreached(when)}.`
  const photo = evidence.proofs.some((proof) => proof.kind === "photo") ? " A photo was taken at the stop." : ""
  if (emptying && evidence.reason === "not-presented") return `Our driver was at the address at ${when} and recorded that ${happened}.${photo}`
  return `Our driver was at the address at ${when} and could not ${verbs.do} ${what}: ${happened}.${photo}`
}
