// The proofs' purge (O1 of #290): a driver's photo or signature older than
// the retention days leaves Storage, unless an open ticket names its stop —
// or, for a proof of the route itself, its route — so a dispute still being
// worked keeps its evidence, and the night after the ticket closes removes
// it. Nightly, across companies as the worker role, over every proof older
// than the days: a missed night, a retention lowered or the key set late is
// caught up by the next, and a key removed before is asked again and counts
// nothing, Storage answering only what it held. That is one call per hundred
// expired keys a night, a handful at the Pilot's volume; a record of what was
// purged is the step when it is not. The proof's row stays — it is the
// ledger's — and the office's read of it says the object is gone (a null URL,
// `GET /pickups/:id/proof-objects`). The days and Storage's key are the
// deployment's settings (`PROOF_RETENTION_DAYS`, `SUPABASE_SERVICE_ROLE_KEY`,
// apps/pilot/README.md), never code defaults: without either, the job
// removes nothing and says so.
import type { ProofStorage } from "@waste/db/storage"
import { OPEN_TICKET_STATUSES } from "@waste/domain/resolution/vocabulary"
import { sql } from "drizzle-orm"

import { defineJob, type JobContext } from "./definition"

export const PURGE_PROOF_OBJECTS_QUEUE = "execution.purge-proof-objects"
/** 03:45 UTC every day: after Plan Ahead and the routing sweep, the quiet hour. */
export const PURGE_PROOF_OBJECTS_SCHEDULE = "45 3 * * *"
/** Keys removed per call to Storage. */
export const PURGE_BATCH = 100

const DAY_MS = 24 * 60 * 60 * 1000

export type PurgeProofObjectsData = {
  /** Where the purge came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

/** One object the purge removes, with the company it is whose. */
export type ExpiredObject = { companyId: string; objectKey: string }

/**
 * The photos and signatures recorded more than `days` ago whose stop — or,
 * for a proof of the route itself, whose route — no open ticket names:
 * across companies, as the worker role, oldest first. It reads and writes
 * nothing else.
 */
export async function expiredProofObjects(worker: JobContext["worker"], at: Date, days: number): Promise<ExpiredObject[]> {
  const before = new Date(at.getTime() - days * DAY_MS).toISOString()
  const open = sql.join(
    OPEN_TICKET_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )
  const rows = await worker.db.execute<{ company_id: string; object_key: string }>(sql`
    select p.company_id, p.object_key
      from wms.proof_of_service p
     where p.object_key is not null
       and p.kind in ('photo', 'signature')
       and p.occurred_at < ${before}::timestamptz
       and not exists (
         select 1 from wms.ticket t
          where t.company_id = p.company_id
            and t.route_id = p.route_id
            and (p.pickup_id is null or t.pickup_id = p.pickup_id)
            and t.status in (${open})
       )
     order by p.occurred_at, p.id
  `)
  return rows.map((row) => ({ companyId: row.company_id, objectKey: row.object_key }))
}

/** What a night came to: the objects Storage removed, or why none could be. */
export type PurgeOutcome = { removed: number } | { skipped: "no-storage" | "no-retention" }

export async function purgeProofObjects(context: JobContext): Promise<PurgeOutcome> {
  const storage: ProofStorage | undefined = context.proofStorage
  if (storage === undefined) {
    context.log("proofs: no Storage key on this deployment; no photo or signature is purged")
    return { skipped: "no-storage" }
  }
  const days = context.proofRetentionDays
  if (days === undefined) {
    context.log("proofs: PROOF_RETENTION_DAYS is unset; no photo or signature is purged")
    return { skipped: "no-retention" }
  }
  const expired = await expiredProofObjects(context.worker, context.now(), days)
  // Storage is called outside any transaction (#124 §4): the read above has ended.
  let removed = 0
  for (let start = 0; start < expired.length; start += PURGE_BATCH) {
    removed += await storage.remove(expired.slice(start, start + PURGE_BATCH).map((object) => object.objectKey))
  }
  context.log(`proofs: removed ${removed} photos and signatures older than ${days} days, of ${expired.length} past them`)
  return { removed }
}

export const purgeProofObjectsJob = defineJob<PurgeProofObjectsData>({
  queue: PURGE_PROOF_OBJECTS_QUEUE,
  description: "Removes from Storage the photos and signatures older than the retention days whose stop no open ticket names (O1 of #290).",
  handler: async (_jobs, context) => await purgeProofObjects(context),
  schedule: PURGE_PROOF_OBJECTS_SCHEDULE,
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "once" },
  // No retry: the next night is the retry, asking again for every key past the days.
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 604_800 },
})
