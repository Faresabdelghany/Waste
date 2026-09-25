// A ledger is appended and never rewritten (Issue #101, ADR-0003: the Stock
// Movement ledger and the Vehicle Allocation events). The foundation's
// default privileges gave the API role SELECT, INSERT, UPDATE and DELETE on
// every future table of `wms`; this takes the two back for the one role that
// writes, hand-written into the ledger's migration file below its fence:
//
//   REVOKE UPDATE, DELETE ON "wms"."stock_movement" FROM wms_api;
//
// The owner keeps both — for tests, and for an erasure someone with the owner's
// connection decides on — so a row nobody can change through the API is still
// a row a person can remove by hand. A table that spreads `timestamps` is not
// a ledger: its `updated_at` says rows change, and asking to revoke UPDATE on
// it is a mistake this refuses. The gate (hand-written.ts) writes this for
// every table without `updated_at`, in the place the trigger goes for one
// with it.
import type { PgTable } from "drizzle-orm/pg-core"

import { columnNamed, qualifiedTable } from "../names"
import { API_ROLE } from "../roles"

const HELPER = "appendOnly"

/** The statement that takes UPDATE and DELETE on this ledger back from the API role, for the ledger's migration file. */
export function appendOnly(table: PgTable): string[] {
  const target = qualifiedTable(table, HELPER)
  if (columnNamed(table, "updated_at")) {
    throw new Error(`${HELPER}: ${target} has updated_at; a ledger spreads recorded, not timestamps, since its rows are never updated`)
  }
  return [`REVOKE UPDATE, DELETE ON ${target} FROM ${API_ROLE};`]
}
