// What a route module repeats that belongs to no family: the stamp a record
// is written with when a set that travels with it is replaced, and the clock
// bound every recorded instant a body carries is held within. What a route
// declares is operation.ts's (the path id, the bodies the document describes,
// a create's 201 and Location), a family's rows scoped.ts's, a reference a
// body names references.ts's; the row lock, the numbering, the database's
// refusals and how the wire spells a row's time are `@waste/db/commands/shared`
// and `@waste/db/shapes/times`, which the commands both processes run read too.
import { aheadOfClock, RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"
import { sql, type SQL } from "drizzle-orm"

import { invalidRequest } from "../problem"

/**
 * What a record's own row is set to when a set that travels with it is
 * replaced (a Property's parties, a Collection Group's rule): nothing but the
 * stamp, since the set is what changed. The trigger would move `updated_at`
 * whatever the update said; naming it is naming what changed, and the update
 * is also what answers "there is no such record here" under the caller's
 * scope. One spelling for a Registry set and a Planning set alike.
 */
export const stamp = (): { updatedAt: SQL } => ({ updatedAt: sql`now()` })

// Execution (Issue #104, ADR-0004): the clock bounds every recorded instant
// is held within. The skew, `OCCURRED_AT_SKEW_MS`, is the domain's
// (`@waste/domain/execution/commands`), where the Stock Movement ledger
// (`@waste/db/commands/stock-ledger`) reads it too, and `requireNotAhead` is
// the route's check over it, spelled once since Resolution's review (Issue
// #109) found it spelled four times; `COMMAND_BACKDATE_MS` is the lower bound
// only a device's queue needs, since an office command's instant defaults to
// the request's clock and a device's may be two days old.

/**
 * Holds a recorded instant to the skew: the body's instant — a ticket's or a
 * movement's `occurredAt`, an unload's, an alert's `detectedAt` — may run
 * ahead of the request's clock `at` by `OCCURRED_AT_SKEW_MS` and no further,
 * refused as a 400 at `path` in the domain's words (`RECORDED_AFTER_IT_HAPPENED`),
 * and has no lower bound here, since the office records a complaint made
 * yesterday and the ledger a movement found in last week's paperwork; the
 * forty-eight-hour floor is the driver door's alone (`COMMAND_BACKDATE_MS`,
 * judged in the domain beside the skew). The ticket create, the alert raise
 * and the unload capture read this one check; a batch ingest that answers
 * each reading on its own reads the domain's `aheadOfClock`.
 */
export function requireNotAhead(instant: Date, at: Date, path = "occurredAt"): void {
  if (aheadOfClock(instant, at)) throw invalidRequest("body", [{ path, message: RECORDED_AFTER_IT_HAPPENED }])
}
