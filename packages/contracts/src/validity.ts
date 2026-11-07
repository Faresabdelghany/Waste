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
import { ENDS_AFTER_IT_STARTS, validityOrdered } from "@waste/domain/periods"
import * as z from "zod"

import { IsoDate } from "./dates"
import { holding, resourceBodies } from "./resource"

/** What a backwards period (@waste/domain/periods) is refused with, and where: the end is the field a caller can move. */
export const endsAfterItStarts = {
  message: ENDS_AFTER_IT_STARTS,
  path: ["validTo"],
}

/** The period a resource carries: the first day in force, and the first day out of it, null while it runs. */
const period = {
  validFrom: IsoDate,
  validTo: IsoDate.nullable(),
}

/** The period as a create takes it: an absent end is an open one, the null the server stores. */
const periodWritten = {
  validFrom: IsoDate,
  validTo: IsoDate.nullable().optional(),
}

/**
 * An effective-dated resource: the base's fields, then the period, held to
 * run forward. The period's fields are not exported on their own, since
 * spreading them takes the fields and not the rule.
 */
export function effectiveDated<Shape extends z.core.$ZodShape, Config extends z.core.$ZodObjectConfig>(base: z.ZodObject<Shape, Config>) {
  const dated = (base as unknown as z.ZodObject).safeExtend(period) as unknown as z.ZodObject<z.core.util.Extend<Shape, typeof period>, Config>
  return holding(dated, validityOrdered, endsAfterItStarts)
}

/**
 * The create and the patch of an effective-dated resource (`resourceBodies`):
 * its fields, then the period, each body held to run forward. A patch that
 * names one bound is judged by the route against the stored row's other
 * (apps/api periods.ts); a patch that may not move the start names
 * `validFrom` among its keys.
 */
export function effectiveDatedBodies<Fields extends z.core.$ZodShape, Key extends keyof (Fields & typeof periodWritten) & string = never, Patch extends z.core.$ZodShape = Record<never, never>>(
  fields: Fields,
  options: { keys?: readonly Key[]; patch?: Patch } = {},
) {
  const { create, patch } = resourceBodies({ ...fields, ...periodWritten }, options)
  return { create: holding(create, validityOrdered, endsAfterItStarts), patch: holding(patch, validityOrdered, endsAfterItStarts) }
}
