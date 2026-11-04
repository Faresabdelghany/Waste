// Right-sizing's nightly run (M23b of #293, row 26.5): every company's
// subscriptions judged on their containers' latest fill estimates, and
// proposed a size down or up, or a frequency, where the estimates ask
// (`proposeRightSizing`, @waste/db/commands/right-sizing, which the office's
// `POST /right-sizing-proposals/run` runs too). Nothing is changed but
// proposals: the office approves them.
//
// The companies with an active project are read across tenants as
// `wms_worker`; each company's run writes as `wms_api` under its fence, one
// after another. A company that fails is logged and the rest run; the job
// fails at the end, so pg-boss retries it once, and the companies that
// already ran propose nothing twice, since one proposal is open per
// subscription and a later one needs newer evidence.
import { company, project } from "@waste/db/schema/organisation"
import { proposeRightSizing } from "@waste/db/commands/right-sizing"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"
import type { Job } from "pg-boss"

import { defineJob, type JobContext } from "./definition"

export type ProposeRightSizingData = {
  /** Where the run came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

/** The companies with an active project, in id order: the one cross-tenant read. */
async function companiesToRun({ worker }: JobContext): Promise<string[]> {
  const rows = await worker.db
    .selectDistinct({ id: company.id })
    .from(company)
    .innerJoin(project, and(eq(project.companyId, company.id), eq(project.status, "active")))
    .orderBy(asc(company.id))
  return rows.map((row) => row.id)
}

export const proposeRightSizingJob = defineJob<ProposeRightSizingData>({
  queue: "customers.propose-right-sizing",
  description: "Proposes right-sizing for every company's subscriptions from their containers' fill estimates, nightly; proposals only, which the office approves.",
  // 03:23 UTC: after a day's routes have ended on every clock the Pilot serves, and clear of the other nightly sweeps.
  schedule: "23 3 * * *",
  scheduleData: { source: "schedule" },
  scheduleOptions: { tz: "UTC", missed: "once" },
  queueOptions: { retryLimit: 1, retryDelay: 300, deleteAfterSeconds: 60 * 60 * 24 * 7 },
  handler: async (jobs: Job<ProposeRightSizingData>[], context: JobContext) => {
    const failed: string[] = []
    for (const job of jobs) {
      for (const companyId of await companiesToRun(context)) {
        try {
          const { proposed } = await withCompany(context.api.db, companyId, (tx) => proposeRightSizing(tx, companyId, context.now()))
          if (proposed.length > 0) context.log(`customers.propose-right-sizing: company ${companyId} → ${proposed.length} proposals (job ${job.id})`)
        } catch (error) {
          failed.push(`${companyId} (${error instanceof Error ? error.message : String(error)})`)
        }
      }
    }
    if (failed.length > 0) throw new Error(`customers.propose-right-sizing: ${failed.length} companies failed: ${failed.join("; ")}`)
  },
})
