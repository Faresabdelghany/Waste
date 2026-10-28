// The one delete path into a ledger (O8 of #290, decided on #344): a
// position is personal location data (#381), kept `POSITION_RETENTION_DAYS`
// days and then removed by the worker's purge, which sweeps every company at
// once. The worker's role reads across companies and writes nothing
// (worker.ts, migration 0011); this grants it DELETE on the one ledger whose
// retention it holds, and nothing else — not UPDATE, not INSERT, not another
// table — hand-written into the file that creates the table, below its fence
// and the revoke that keeps the API role from deleting the same rows:
//
//   GRANT DELETE ON "wms"."session_position" TO wms_worker;
//
// `wms_worker` bypasses row-level security by construction, so the grant is
// what the purge needs and the fence does not stand in its way; the owner
// keeps its own rights, as on every ledger.
import type { PgTable } from "drizzle-orm/pg-core"

import { columnNamed, qualifiedTable } from "../names"
import { WORKER_ROLE } from "../roles"

const HELPER = "retentionPurge"

/** The statement that lets the worker's purge remove a ledger's rows past their retention, for the ledger's migration file. */
export function retentionPurge(table: PgTable): string[] {
  const target = qualifiedTable(table, HELPER)
  if (!columnNamed(table, "recorded_at")) {
    throw new Error(`${HELPER}: ${target} has no recorded_at; the purge's grant is for a ledger, which no other role may delete from`)
  }
  return [`GRANT DELETE ON ${target} TO ${WORKER_ROLE};`]
}
