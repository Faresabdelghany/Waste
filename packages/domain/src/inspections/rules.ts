// What a field inspection holds to (M23 of #293): its verdict and its
// findings agree — a `compliant` visit found nothing, a `minor` or a `major`
// one found at least one thing, each finding once. Its photos live in the
// private `proofs` bucket under the inspection's own prefix
// (../storage-objects), which the API signs an upload for and holds an appended
// photo's key to.
import type { FieldInspectionOutcome, InspectionFinding } from "./vocabulary"

/** What a compliant inspection naming a finding is told. */
export const COMPLIANT_FINDS_NOTHING = "A compliant inspection names no findings"
/** What a minor or a major inspection naming none is told. */
export const A_FINDING_TO_FOLLOW_UP = "A minor or a major inspection names what was found"
/** What a finding named twice is told. */
export const EACH_FINDING_ONCE = "Name each finding once"
/** What an inspection naming both a container and a property, or neither, is told. */
export const ONE_SUBJECT = "An inspection is of a container or of a property, exactly one"

/** The sentence the outcome and the findings disagree in, or undefined where they agree. */
export function findingsIssue(outcome: FieldInspectionOutcome, findings: readonly InspectionFinding[]): string | undefined {
  if (new Set(findings).size !== findings.length) return EACH_FINDING_ONCE
  if (outcome === "compliant") return findings.length === 0 ? undefined : COMPLIANT_FINDS_NOTHING
  return findings.length === 0 ? A_FINDING_TO_FOLLOW_UP : undefined
}
