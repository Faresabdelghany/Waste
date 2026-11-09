// The nightly sweep (Issue #97 part B, §5 "Cron"): `planning.plan-ahead` at
// 03:00 UTC — past midnight in every timezone the demo serves, so "today" is
// the same day everywhere it is read — finds every validated route scheme
// with `plan_ahead` on, not archived, whose period overlaps its Plan Ahead
// window in its project's timezone, and gives each a generation run over
// `planAheadRunWindow(today, plan_ahead_days)`: tomorrow through the
// scheme's number of days ahead, 7 unless the office set another (O21 of
// #290), today's routes being already operating (the domain's rule,
// planning/lifecycle.ts). An archived scheme has Plan Ahead off by the
// database's shape; the sweep asks for both all the same. Every row is written as `wms_api` under `withCompany`, the
// run and its job in one transaction through `startGenerationRun`
// (`@waste/db/commands/generation`, the start the API's trigger shares,
// Issue #168), so neither is left without the other.
//
// The sweep is the one statement in the system that reads across tenants,
// and the reason `wms_worker` has BYPASSRLS: one `select` over route_scheme
// joined to project, "today" being the job's `now` on each project's clock
// (`todayOnClock`, @waste/db/query/project-clock), so a scheme in Cairo and
// one in Copenhagen are each judged on their own day at one instant. It reads on
// the worker role's pool and writes nothing; a write there is 42501 by grant.
//
// A scheme mid-generation is not queued twice: `planning.generate-routes` is
// an `exclusive` queue and every send carries the scheme's id as
// `singletonKey`, so a send while a job of that scheme is queued or active
// answers null, and the sweep then writes no run for it — the run that is
// queued or running will cover the week. The job is sent before the run is
// written, so a null never leaves a `queued` run nobody will pick up.
//
// The handler answers what it did, and logs one line per sweep; a failure of
// one company's transaction is logged and the sweep goes on to the next,
// since one tenant's trouble is not another's, and the job then fails so the
// count shows on /readyz.
import { startGenerationRun } from "@waste/db/commands/generation"
import { todayOnClock } from "@waste/db/query/project-clock"
import { loggable } from "@waste/db/sqlstate"
import { sweepEach } from "@waste/db/sweeps"
import { withCompany } from "@waste/db/tenant"
import { planAheadRunWindow } from "@waste/domain/planning/lifecycle"
import { sql } from "drizzle-orm"

import { defineJob, type JobContext } from "../runtime/definition"

export const PLAN_AHEAD_QUEUE = "planning.plan-ahead"
/** 03:00 UTC every day: past midnight in every timezone the demo serves. */
export const PLAN_AHEAD_SCHEDULE = "0 3 * * *"

export type PlanAheadData = {
  source: "schedule" | "manual"
}

export type EligibleScheme = { companyId: string; projectId: string; routeSchemeId: string; today: string; planAheadDays: number }

/**
 * The sweep: every validated scheme with plan-ahead on, not archived, whose
 * period overlaps tomorrow through today + its `plan_ahead_days`, today
 * being `at` in the project's timezone.
 * Across companies, as the worker role. `validTo` is the first day out of
 * force, so a scheme ending on the window's first day is not in it.
 */
export async function eligibleSchemes(worker: JobContext["worker"], at: Date): Promise<EligibleScheme[]> {
  const today = todayOnClock(at, sql`p.timezone`)
  const rows = await worker.db.execute<{ company_id: string; project_id: string; route_scheme_id: string; today: string; plan_ahead_days: number }>(sql`
    select s.company_id, s.project_id, s.id as route_scheme_id, ${today}::text as today, s.plan_ahead_days
    from wms.route_scheme s
    join wms.project p on p.company_id = s.company_id and p.id = s.project_id
    where s.plan_ahead and s.status = 'validated' and s.archived_at is null
      and s.valid_from <= ${today} + s.plan_ahead_days
      and (s.valid_to is null or s.valid_to > ${today} + 1)
    order by s.company_id, s.project_id, s.id
  `)
  return rows.map((row) => ({ companyId: row.company_id, projectId: row.project_id, routeSchemeId: row.route_scheme_id, today: row.today, planAheadDays: row.plan_ahead_days }))
}

export type PlanAheadOutcome = { eligible: number; queued: string[]; alreadyQueued: string[]; failed: string[] }

/**
 * Writes a `cron` run over its Plan Ahead window for each eligible scheme
 * and sends its job in the same fenced transaction; a scheme whose job is
 * already queued or active gets no run. Companies are taken one at a time,
 * each in its own transactions, so a fenced write for one never sees another.
 */
export async function planAhead({ api, worker, now, log, send }: JobContext, jobId: string | null = null): Promise<PlanAheadOutcome> {
  const at = now()
  const schemes = await eligibleSchemes(worker, at)
  const outcome: PlanAheadOutcome = { eligible: schemes.length, queued: [], alreadyQueued: [], failed: [] }
  const failed = await sweepEach(
    schemes,
    async (scheme) => {
      const window = planAheadRunWindow(scheme.today, scheme.planAheadDays)
      const runId = await withCompany(api.db, scheme.companyId, (tx) => startGenerationRun(tx, send, { companyId: scheme.companyId, projectId: scheme.projectId, routeSchemeId: scheme.routeSchemeId, trigger: "cron", window }))
      // A job of this scheme is queued or active: no run is written, and that run covers the week.
      if (runId === null) outcome.alreadyQueued.push(scheme.routeSchemeId)
      else outcome.queued.push(runId)
    },
    (scheme, error) => log(`${PLAN_AHEAD_QUEUE}: company ${scheme.companyId}, scheme ${scheme.routeSchemeId} failed: ${JSON.stringify(loggable(error))}`),
  )
  outcome.failed.push(...failed.map((scheme) => scheme.routeSchemeId))
  log(`${PLAN_AHEAD_QUEUE}: ${at.toISOString()} swept ${outcome.eligible} eligible ${outcome.eligible === 1 ? "scheme" : "schemes"}: ${outcome.queued.length} queued, ${outcome.alreadyQueued.length} already queued, ${outcome.failed.length} failed${jobId === null ? "" : ` (job ${jobId})`}`)
  return outcome
}

export const planAheadJob = defineJob<PlanAheadData>({
  queue: PLAN_AHEAD_QUEUE,
  description: "Sweeps every validated route scheme with plan-ahead on and not archived, across companies, and queues a generation run over its Plan Ahead window (the coming week unless the scheme says otherwise) for each, as wms_api under its company.",
  schedule: PLAN_AHEAD_SCHEDULE,
  scheduleData: { source: "schedule" },
  // A worker back after a night off sweeps once, not once per missed night: the week is the same week.
  scheduleOptions: { tz: "UTC", missed: "once" },
  // The sweep is idempotent by construction, so a retry costs nothing but a second sweep; one is enough.
  queueOptions: { retryLimit: 1, retryDelay: 60, deleteAfterSeconds: 60 * 60 * 24 * 7 },
  handler: async (jobs, context) => {
    const outcomes: PlanAheadOutcome[] = []
    for (const job of jobs) {
      const outcome = await planAhead(context, job.id)
      outcomes.push(outcome)
      if (outcome.failed.length > 0) throw new Error(`${PLAN_AHEAD_QUEUE}: ${outcome.failed.length} of ${outcome.eligible} schemes could not be queued (job ${job.id})`)
    }
    return { sweeps: outcomes }
  },
})
