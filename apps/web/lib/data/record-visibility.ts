// Soft-delete visibility marker shared by every record surface. Deleting a
// record marks it instead of removing it (the central deletion log needs a
// record to point at), so every read path that lists, counts, validates
// against or plans from records must skip marked ones — or a deleted record
// gets counted, adjusted, generated for, or resurrected.

import type { BusinessRecord } from "./business-modules"

export const REGISTRY_VISIBILITY_FACT = "Registry visibility"
export const SOFT_DELETED = "Soft deleted"

export function isSoftDeleted(record: BusinessRecord): boolean {
  return record.facts[REGISTRY_VISIBILITY_FACT] === SOFT_DELETED
}

/** What a soft delete records about itself — who, why, and which log entry. */
export type SoftDeletion = {
  /** The structured deletion reason the confirm dialog collected. */
  reason: string
  /** Who deleted the record. */
  actorName: string
  /** The deletion-log audit event id the soft-deleted record links to. */
  deletionLogId: string
}

/**
 * The one soft-delete shape: the record marked with the visibility fact, the
 * structured reason and actor, and a link to its deletion-log audit event.
 * Written by commitRecordAction (business-workspace.tsx) for every module
 * and by planSchemeDeletion (lib/route-schemes/deletion.ts) for route
 * schemes; the input is left untouched.
 */
export function softDeletedRecord(
  record: BusinessRecord,
  deletion: SoftDeletion,
): BusinessRecord {
  return {
    ...record,
    updated: "Now",
    facts: {
      ...record.facts,
      [REGISTRY_VISIBILITY_FACT]: SOFT_DELETED,
      "Deletion reason": deletion.reason,
      "Deleted by": deletion.actorName,
    },
    related: [`Deletion log ${deletion.deletionLogId}`, ...record.related],
  }
}
