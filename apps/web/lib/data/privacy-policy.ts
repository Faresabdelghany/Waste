// A project's privacy policy as Settings › Privacy, audit & retention reads
// and writes it on the Pilot (#291 C19): the days its drivers' positions and
// its stops' photos and signatures are kept, and why it records positions.
// The project record carries the wire's policy as JSON under
// `PRIVACY_POLICY_KEY` (lib/api/records/organisation.ts); the pane writes it
// whole through `PUT /projects/:id/privacy-policy`, never the project's
// patch. A part left empty is no policy of the project's own: the
// deployment's setting stands, as before policies. Pure.
import type { GpsPurpose, PrivacyPolicy } from "@waste/contracts/organisation"
import { RETENTION_DAYS_BOUNDS, type RetentionKind } from "@waste/domain/privacy/retention"
import { GPS_PURPOSES } from "@waste/domain/privacy/vocabulary"

import type { BusinessRecord } from "./business-modules"

/** Where a project record carries its policy, as the wire's JSON. */
export const PRIVACY_POLICY_KEY = "privacyPolicy"

export const NO_PRIVACY_POLICY: PrivacyPolicy = { positionRetentionDays: null, proofRetentionDays: null, gpsPurpose: null }

/** The project's policy as its record carries it; no policy where it carries none or a value that is not one. */
export function privacyPolicyOf(project: BusinessRecord): PrivacyPolicy {
  const raw = project.submittedValues?.[PRIVACY_POLICY_KEY]
  if (typeof raw !== "string") return NO_PRIVACY_POLICY
  try {
    const parsed = JSON.parse(raw) as Partial<PrivacyPolicy>
    return {
      positionRetentionDays: typeof parsed.positionRetentionDays === "number" ? parsed.positionRetentionDays : null,
      proofRetentionDays: typeof parsed.proofRetentionDays === "number" ? parsed.proofRetentionDays : null,
      gpsPurpose: (GPS_PURPOSES as readonly string[]).includes(parsed.gpsPurpose ?? "") ? (parsed.gpsPurpose as GpsPurpose) : null,
    }
  } catch {
    return NO_PRIVACY_POLICY
  }
}

const PURPOSE_LABELS: Record<GpsPurpose, string> = { dispatch: "Dispatch", "dispatch-and-proof": "Dispatch and proof of service" }

/** The purposes a policy may name, as the form offers them. */
export const GPS_PURPOSE_OPTIONS = GPS_PURPOSES.map((purpose) => ({ value: purpose, label: PURPOSE_LABELS[purpose] }))

/** A purpose as a person reads it; none declared where the policy names none. */
export const gpsPurposeLabel = (purpose: GpsPurpose | null): string => (purpose === null ? "Not declared" : PURPOSE_LABELS[purpose])

/** A kind's days as a person reads them; the deployment's setting where the policy names none. */
export const retentionLabel = (days: number | null): string => (days === null ? "Deployment setting" : `${days} day${days === 1 ? "" : "s"}`)

/** What the form holds: each kind's days as typed (empty is no policy of its own), and the purpose or empty. */
export type PrivacyPolicyForm = { positionRetentionDays: string; proofRetentionDays: string; gpsPurpose: GpsPurpose | "" }

export const privacyPolicyFormOf = (policy: PrivacyPolicy): PrivacyPolicyForm => ({
  positionRetentionDays: policy.positionRetentionDays === null ? "" : String(policy.positionRetentionDays),
  proofRetentionDays: policy.proofRetentionDays === null ? "" : String(policy.proofRetentionDays),
  gpsPurpose: policy.gpsPurpose ?? "",
})

const KIND_NOUNS: Record<RetentionKind, string> = { positions: "Positions", proofs: "Photos and signatures" }

/** Why a kind's typed days will not do, or null: empty, or a whole number within the kind's bounds. */
export function retentionRefusalOf(kind: RetentionKind, typed: string): string | null {
  const text = typed.trim()
  if (text === "") return null
  const { min, max } = RETENTION_DAYS_BOUNDS[kind]
  const days = Number(text)
  if (!/^\d+$/.test(text) || days < min || days > max) return `${KIND_NOUNS[kind]} are kept a whole number of days from ${min} to ${max}`
  return null
}

/** The body the form's values make, or null while a part will not do. */
export function privacyPolicyFromForm(form: PrivacyPolicyForm): PrivacyPolicy | null {
  if (retentionRefusalOf("positions", form.positionRetentionDays) !== null || retentionRefusalOf("proofs", form.proofRetentionDays) !== null) return null
  const days = (typed: string) => (typed.trim() === "" ? null : Number(typed.trim()))
  return { positionRetentionDays: days(form.positionRetentionDays), proofRetentionDays: days(form.proofRetentionDays), gpsPurpose: form.gpsPurpose === "" ? null : form.gpsPurpose }
}
