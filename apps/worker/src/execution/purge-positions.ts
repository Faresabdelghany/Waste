// The positions' purge (O8 of #290, decided on #344): where a session's
// vehicle was is personal location data (#381), kept the domain's
// `POSITION_RETENTION_DAYS` (@waste/domain/execution/positions), thirty, and
// no longer. Nightly, across companies, by the fix's own instant: a missed
// night is caught up by the next.
//
// The delete runs as the worker role, the one write it makes: migration
// 0060 grants `wms_worker` DELETE on `session_position` and on no other
// table (`retentionPurge`, @waste/db/sql/retention-purge), and the API role
// may not delete from the ledger at all, so this is the only way a position
// leaves short of the owner's hand. It goes in batches of `PURGE_BATCH`
// rows, each statement its own transaction, so a night that finds a month's
// backlog never holds a long lock or one large transaction on the Pilot's
// small pool. Nothing else of the session is touched: the receipt never held
// the points (routes/driver.ts, `withoutPoints`).
import { POSITION_RETENTION_DAYS } from "@waste/domain/execution/positions"
import { sql } from "drizzle-orm"

import { defineJob, type JobContext } from "../runtime/definition"

export const PURGE_POSITIONS_QUEUE = "execution.purge-positions"
/** 03:40 UTC every day: after Plan Ahead and the routing sweep, before the proofs' purge. */
export const PURGE_POSITIONS_SCHEDULE = "40 3 * * *"
/** Rows deleted per statement. */
export const PURGE_BATCH = 5_000

const DAY_MS = 24 * 60 * 60 * 1000

export type PurgePositionsData = {
  source: "schedule" | "manual"
}

export type PurgePositionsOutcome = { removed: number; days: number }

async function deleteBatch(worker: JobContext["worker"], before: string): Promise<number> {
  const rows = await worker.db.execute<{ id: string }>(sql`
    delete from wms.session_position
     where id in (
       select id from wms.session_position
        where fixed_at < ${before}::timestamptz
        order by fixed_at
        limit ${PURGE_BATCH}
     )
    returning id
  `)
  return rows.length
}

export async function purgePositions(context: JobContext): Promise<PurgePositionsOutcome> {
  const before = new Date(context.now().getTime() - POSITION_RETENTION_DAYS * DAY_MS).toISOString()
  let removed = 0
  for (;;) {
    const batch = await deleteBatch(context.worker, before)
    removed += batch
    if (batch < PURGE_BATCH) break
  }
  context.log(`positions: removed ${removed} fixed more than ${POSITION_RETENTION_DAYS} days ago`)
  return { removed, days: POSITION_RETENTION_DAYS }
}

export const purgePositionsJob = defineJob<PurgePositionsData>({
  queue: PURGE_POSITIONS_QUEUE,
  description: "Removes the positions older than the retention days, thirty (O8 of #290).",
  handler: async (_jobs, context) => await purgePositions(context),
  schedule: PURGE_POSITIONS_SCHEDULE,
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "once" },
  // No retry: the next night is the retry, sweeping everything past the days.
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 604_800 },
})
