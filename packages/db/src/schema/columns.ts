// The column sets every domain table is built from, one per Data model rule
// (docs/architecture/backend-architecture.md). A table spreads the sets it
// needs into its columns and adds the checks that go with them:
//
//   export const agreement = wms.table(
//     "agreement",
//     { ...id, ...projectScoped, ...timestamps, ...validity, containerId: uuid().notNull() },
//     (columns) => [validPeriod(columns)],
//   )
//
// `id`: a UUID version 7 (ADR-0004), minted by the database when the insert
// carries none and taken as given when it does (a driver's device mints ids
// for what it queues offline; the contracts `Id` schema has checked the shape
// by then).
//
// `tenant` and `projectScoped`: every table carries `company_id`; a
// project-scoped table carries `project_id` too, and spreads `projectScoped`
// alone, which includes the tenant column. Both are bare `uuid not null` here;
// the foreign keys arrive with the Company and Project tables (Issue 3). The
// tenant fence (sql/tenant-fence.ts) reads `company_id` and refuses a table
// without it.
//
// `timestamps`: instants are instants, `timestamptz`, read as Date. Both
// default to the transaction's `now()` on insert; `updated_at` is then kept by
// the `wms.touch_updated_at()` trigger that sql/touch-updated-at.ts adds to the
// table. Days are days: a service date or a validity bound is a `date`, read
// as a `YYYY-MM-DD` string, the contracts' `IsoDate`.
//
// `validity`: effective dating (ADR-0005). `valid_from` inclusive, `valid_to`
// exclusive and null when open-ended. `validPeriod(columns)` is the check the
// table adds beside them, `<table>_validity`: `valid_to` is null or later than
// `valid_from`, strictly, because an empty period is an empty range to the
// exclusion constraint (sql/exclude-overlapping.ts) and would slip through it
// unseen. The exclusion constraint itself is hand-written SQL in the
// migration, since Drizzle has no builder for it; `excludeOverlapping` refuses
// a table without this check. query/valid-on.ts asks which row was valid on a
// date.
//
// `recorded` (Issue #101): the one stamp a ledger row has. A ledger is
// appended and never updated, so it has no `updated_at` to keep and no trigger
// (sql/append-only.ts revokes UPDATE and DELETE from the API role instead); a
// ledger spreads `recorded`, not `timestamps`. The gate in sql/hand-written.ts
// reads the absence of `updated_at` as the mark of a ledger.
//
// `window`: a reservation on a clock (Issue #101, the Vehicle Allocation),
// which is not effective dating. Two routes a day on one vehicle is ordinary
// and a reservation without an end is not a plan, so both bounds are
// `timestamptz` and NOT NULL, read as Dates, and `orderedWindow(columns)` is
// the check beside them, `<table>_window`: `planned_to` after `planned_from`,
// strictly, for the same reason `validPeriod` is strict — an empty window is
// an empty range to the exclusion constraint (sql/exclude-overlapping-window.ts),
// which refuses a table without this check. A table that copies the two
// columns as a snapshot (a ledger of what an allocation was) spreads `window`
// without the check, and is then not a reservation the gate asks a constraint
// of.
import { sql } from "drizzle-orm"
import { check, date, timestamp, uuid, type CheckBuilder, type PgColumn } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"

export const id = {
  id: uuid().primaryKey().default(sql`wms.uuidv7()`),
}

export const tenant = {
  companyId: uuid().notNull(),
}

export const projectScoped = {
  ...tenant,
  projectId: uuid().notNull(),
}

export const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}

/** The one stamp of a ledger row: when it was appended. Spread instead of `timestamps`. */
export const recorded = {
  recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}

export const validity = {
  validFrom: date().notNull(),
  validTo: date(),
}

/** A reservation's bounds on a clock: both instants, both given. */
export const window = {
  plannedFrom: timestamp({ withTimezone: true }).notNull(),
  plannedTo: timestamp({ withTimezone: true }).notNull(),
}

/** The two window columns of a table that spread `window`, as its extra-config callback receives them. */
export type WindowColumns = { plannedFrom: PgColumn; plannedTo: PgColumn }

/** The suffix of the check `orderedWindow` adds; `excludeOverlappingWindow` looks for it by name. */
export const WINDOW_CHECK = "window"

export function orderedWindow(columns: WindowColumns): CheckBuilder {
  return check(tableObjectName(columns.plannedFrom.table, WINDOW_CHECK, "orderedWindow"), sql`${columns.plannedTo} > ${columns.plannedFrom}`)
}

/** The two validity columns of a table that spread `validity`, as its extra-config callback receives them. */
export type ValidityColumns = { validFrom: PgColumn; validTo: PgColumn }

/** The suffix of the check `validPeriod` adds; `excludeOverlapping` looks for it by name. */
export const VALIDITY_CHECK = "validity"

export function validPeriod(columns: ValidityColumns): CheckBuilder {
  return check(
    tableObjectName(columns.validFrom.table, VALIDITY_CHECK, "validPeriod"),
    sql`${columns.validTo} is null or ${columns.validTo} > ${columns.validFrom}`,
  )
}
