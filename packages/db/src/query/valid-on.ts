// The query side of effective dating (ADR-0005): which rows were valid on a
// day. Generation asks which Service Placement was valid on the service date,
// billing which Price List on the day of the pickup, authorisation which
// Service Area Assignment on the day of the request; each passes its own date,
// and none of them asks "which is current" without saying when.
//
//   db.select().from(agreement).where(and(eq(agreement.containerId, id), validOn(agreement, serviceDate)))
//
// `valid_from` is inclusive and `valid_to` exclusive, matching the half-open
// range the exclusion constraint guards, so exactly one row of a key answers
// for any day it covers. The day is the contracts' `IsoDate` spelling,
// `YYYY-MM-DD`, or a SQL expression that yields a date (`current_date`, a
// column of another table); any other string is refused here rather than
// left to Postgres, which would read "Jan 1 2026" happily and keep two
// spellings in circulation.
import { sql, type SQL } from "drizzle-orm"

import type { ValidityColumns } from "../schema/columns"

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The condition that the row was valid on `day`, for a `where`. */
export function validOn(columns: ValidityColumns, day: string | SQL): SQL {
  if (typeof day === "string" && !ISO_DATE.test(day)) {
    throw new Error(`validOn: "${day}" is not a YYYY-MM-DD day`)
  }
  return sql`(${columns.validFrom} <= ${day} and (${columns.validTo} is null or ${columns.validTo} > ${day}))`
}
