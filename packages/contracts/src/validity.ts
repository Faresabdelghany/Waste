// Effective dating on the wire (ADR-0005, Issue #78). An Agreement, a
// Subscription and a Container Service Placement each carry a period instead
// of a status someone has to remember to change: what is in force is what the
// period says about the day asked.
//
// The period is half-open. `validFrom` is the first day the row is in force
// and `validTo` the first day it is not, so yesterday's row and today's meet
// without overlapping — which is what the database's exclusion constraint
// holds (`daterange(valid_from, valid_to, '[)')` in
// packages/db/src/sql/exclude-overlapping.ts) and why an end equal to the
// start is refused here: an empty period is an empty range, and the database
// would not even see it as a conflict. `validTo: null` is open ended, the
// common case for a running agreement.
//
// "Pending", "expiring", "expired" and "terminated" are readings of the
// period against a day; none of them is a column and none is on the wire. A
// list asks for the reading it wants with `validOn`.
//
// Comparing two `YYYY-MM-DD` strings with `>` compares the days: the fields
// are zero-padded and most significant first, so string order is date order
// and nothing has to be parsed to say a period runs backwards.
import * as z from "zod"

import { IsoDate } from "./dates"

/** A period whose end is absent, null or after its start; a half-seen period is not judged, which is what a patch gives. */
export function validityOrdered(value: { validFrom?: string | null; validTo?: string | null }): boolean {
  const { validFrom, validTo } = value
  if (validFrom == null || validTo == null) return true
  return validTo > validFrom
}

/**
 * What a backwards period is told, wherever it is caught. The schemas here
 * refuse a body that holds both bounds; a patch holds one and the stored row
 * the other, so the route that has the row refuses in these same words
 * (apps/api/src/routes/periods.ts). One rule, one sentence — and a constant
 * of its own, because zod normalises the params object a `.refine` is handed
 * and `message` is not there to read back afterwards.
 */
export const ENDS_AFTER_IT_STARTS = "validTo is the first day out of force, so it comes after validFrom"

/** What a backwards period is refused with, and where: the end is the field a caller can move. */
export const endsAfterItStarts = {
  message: ENDS_AFTER_IT_STARTS,
  path: ["validTo"],
}

/**
 * The period a resource carries: both fields, `validTo` null while it runs.
 * A resource spreads `Validity.shape` and refines `validityOrdered` again,
 * since spreading takes the fields and not the rule; that way the two days
 * are spelled once here and every schema that carries them holds the rule.
 */
export const Validity = z
  .object({
    /** The first day the row is in force. */
    validFrom: IsoDate,
    /** The first day it is not; null while it runs. */
    validTo: IsoDate.nullable(),
  })
  .refine(validityOrdered, endsAfterItStarts)
export type Validity = z.infer<typeof Validity>

/** The same period as a create body takes it, to spread into one: an absent end is an open one, the null the server stores. */
export const ValidityCreate = {
  validFrom: IsoDate,
  validTo: IsoDate.nullable().optional(),
}
