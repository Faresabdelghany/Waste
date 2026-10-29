// How long a project keeps each kind of personal data (#291 C19, #381): the
// positions its drivers' phones recorded, and the photos and signatures taken
// at its stops. (A ticket comment's attachment joins them when attachments
// are stored: no deployment has their bucket yet, so there is nothing to
// keep or purge.) A project's policy
// names days for each, or nothing; nothing is the deployment's own setting,
// which is what was kept before projects had policies, so a project with no
// policy keeps exactly what it kept then. The worker's purges read the
// effective days, project by project.
//
// The bounds are the policy's, and the database holds the same in its
// checks: a position never past the ceiling of thirty days (O8 of #290, the
// owner's decision on #344), a photo or a signature never past ten years —
// longer than any bookkeeping or claims period a stop's evidence serves.
import { POSITION_RETENTION_CEILING_DAYS, positionRetentionDays } from "../execution/positions"

/** The kinds of personal data a project's policy keeps for a number of days. */
export const RETENTION_KINDS = ["positions", "proofs"] as const
export type RetentionKind = (typeof RETENTION_KINDS)[number]

/** The days a policy may name, by kind: at least one, and at most the kind's ceiling. */
export const RETENTION_DAYS_BOUNDS: Readonly<Record<RetentionKind, { min: number; max: number }>> = {
  positions: { min: 1, max: POSITION_RETENTION_CEILING_DAYS },
  proofs: { min: 1, max: 3650 },
}

/**
 * The days a purge keeps a project's data of one kind: the project's own
 * policy where it names one, else the deployment's setting; a position never
 * past its ceiling, whichever says. Null is kept for good: a photo with
 * neither a policy nor a setting is never purged, as before.
 */
export function effectiveRetentionDays(kind: RetentionKind, project: number | null, deployment: number | undefined): number | null {
  if (kind === "positions") return positionRetentionDays(project ?? deployment)
  return project ?? deployment ?? null
}
