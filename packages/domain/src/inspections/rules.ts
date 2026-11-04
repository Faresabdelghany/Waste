// What a field inspection holds to (M23 of #293): its verdict and its
// findings agree — a `compliant` visit found nothing, a `minor` or a `major`
// one found at least one thing, each finding once — and its photos live in
// the private `proofs` bucket under the inspection's own prefix,
// `inspections/<companyId>/<inspectionId>/<photoId>.<extension>`, which the
// API signs an upload for and holds an appended photo's key to.
import type { FieldInspectionOutcome, InspectionFinding } from "./vocabulary"

/** What a compliant inspection naming a finding is told. */
export const COMPLIANT_FINDS_NOTHING = "A compliant inspection names no findings"
/** What a minor or a major inspection naming none is told. */
export const A_FINDING_TO_FOLLOW_UP = "A minor or a major inspection names what was found"
/** What a finding named twice is told. */
export const EACH_FINDING_ONCE = "Name each finding once"

/** The sentence the outcome and the findings disagree in, or undefined where they agree. */
export function findingsIssue(outcome: FieldInspectionOutcome, findings: readonly InspectionFinding[]): string | undefined {
  if (new Set(findings).size !== findings.length) return EACH_FINDING_ONCE
  if (outcome === "compliant") return findings.length === 0 ? undefined : COMPLIANT_FINDS_NOTHING
  return findings.length === 0 ? A_FINDING_TO_FOLLOW_UP : undefined
}

/** The formats an inspection photo may be, the proofs bucket's images. */
export const INSPECTION_PHOTO_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const
export type InspectionPhotoExtension = (typeof INSPECTION_PHOTO_EXTENSIONS)[number]

/** The ids an inspection photo's key is made of. */
export type InspectionPhotoIds = { companyId: string; inspectionId: string; photoId: string }

/** Where an inspection photo's bytes live in the proofs bucket. */
export const inspectionPhotoKeyOf = ({ companyId, inspectionId, photoId }: InspectionPhotoIds, extension: InspectionPhotoExtension): string => `inspections/${companyId}/${inspectionId}/${photoId}.${extension}`

/** Whether a key is a photo of this inspection: its company, its id, and a photo id and format of the bucket's. */
export function inspectionPhotoKeyNames(key: string, ids: { companyId: string; inspectionId: string }): boolean {
  const prefix = `inspections/${ids.companyId}/${ids.inspectionId}/`
  if (!key.startsWith(prefix)) return false
  const rest = key.slice(prefix.length)
  const dot = rest.lastIndexOf(".")
  if (dot <= 0) return false
  const [photoId, extension] = [rest.slice(0, dot), rest.slice(dot + 1)]
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(photoId) && (INSPECTION_PHOTO_EXTENSIONS as readonly string[]).includes(extension)
}

/** The photo id a key of this shape names. */
export const photoIdOf = (key: string): string => key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("."))
