// The positions' purge (O8 of #290, decided on #344): where a session's
// vehicle was is personal location data (#381), kept `POSITION_RETENTION_DAYS`
// days and never more than the domain's ceiling of thirty, which is also what
// is kept when the setting is unset (@waste/domain/execution/positions) — the
// one retention here with a default, since keeping a track for good by
// omission is the mistake the ceiling exists to rule out. A project whose
// privacy policy names days of its own (#291 C19) is kept those instead, under
// the same ceiling (`effectiveRetentionDays`, @waste/domain/privacy/retention),
// read off its row in the same statement. Nightly, across companies, by the
// fix's own instant: a missed night or a retention lowered is caught up by
// the next.
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
import { POSITION_RETENTION_CEILING_DAYS, positionRetentionDays } from "@waste/domain/execution/positions"
import { sql } from "drizzle-orm"

import { defineJob, type JobContext } from "./definition"

export const PURGE_POSITIONS_QUEUE = "execution.purge-positions"
/** 03:40 UTC every day: after Plan Ahead and the routing sweep, before the proofs' purge. */
export const PURGE_POSITIONS_SCHEDULE = "40 3 * * *"
/** Rows deleted per statement. */
export const PURGE_BATCH = 5_000


export type PurgePositionsData = {
  /** Where the purge came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

/** What a night came to: the positions removed, and the deployment's days — a project with a policy of its own was held to its own. */
export type PurgePositionsOutcome = { removed: number; days: number }

/**
 * Deletes one batch of positions past their project's days, oldest first,
 * across companies, as the worker role; answers how many went. A project's
 * days are its policy's where it names them, else `days` — the deployment's
 * — and never past the ceiling, which the database also holds its policy to.
 */
async function deleteBatch(worker: JobContext["worker"], now: string, days: number): Promise<number> {
  const rows = await worker.db.execute<{ id: string }>(sql`
    delete from wms.session_position
     where id in (
       select fix.id
         from wms.session_position fix
         join wms.project project on project.company_id = fix.company_id and project.id = fix.project_id
        where fix.fixed_at < ${now}::timestamptz - make_interval(days => least(coalesce(project.position_retention_days, ${days}::integer), ${POSITION_RETENTION_CEILING_DAYS}::integer))
        order by fix.fixed_at
        limit ${PURGE_BATCH}
     )
    returning id
  `)
  return rows.length
}

export async function purgePositions(context: JobContext): Promise<PurgePositionsOutcome> {
  const days = positionRetentionDays(context.positionRetentionDays)
  const now = context.now().toISOString()
  let removed = 0
  for (;;) {
    const batch = await deleteBatch(context.worker, now, days)
    removed += batch
    if (batch < PURGE_BATCH) break
  }
  context.log(`positions: removed ${removed} fixed more than ${days} days ago${context.positionRetentionDays === undefined ? " (POSITION_RETENTION_DAYS is unset: the ceiling)" : ""}`)
  return { removed, days }
}

export const purgePositionsJob = defineJob<PurgePositionsData>({
  queue: PURGE_POSITIONS_QUEUE,
  description: "Removes the positions older than the retention days, thirty at most (O8 of #290).",
  handler: async (_jobs, context) => await purgePositions(context),
  schedule: PURGE_POSITIONS_SCHEDULE,
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "once" },
  // No retry: the next night is the retry, sweeping everything past the days.
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 604_800 },
})
