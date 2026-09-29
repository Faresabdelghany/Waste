// The nightly sweep (Issue #97 part B, §5 "Cron"): `planning.plan-ahead` at
// 03:00 UTC — past midnight in every timezone the demo serves, so "today" is
// the same day everywhere it is read — finds every validated route scheme
// with `plan_ahead` on whose period overlaps the coming week in its
// project's timezone, and gives each a generation run over
// `planAheadWindow(today)`: tomorrow through the next seven days, today's
// routes being already operating (the domain's rule, route-schemes/
// plan-ahead.ts). Every row is written as `wms_api` under `withCompany`, the
// run and its job in one transaction through `sendGenerateRoutes`
// (`@waste/db/jobs`, the spelling the API's trigger shares, Issue #168), so
// neither is left without the other.
//
// The sweep is the one statement in the system that reads across tenants,
// and the reason `wms_worker` has BYPASSRLS: one `select` over route_scheme
// joined to project, "today" being `now()` rendered in each project's
// timezone by Postgres (`at time zone`), so a scheme in Cairo and one in
// Copenhagen are each judged on their own day at one instant. It reads on
// the worker role's pool and writes nothing; a write there is 42501 by grant.
//
// A scheme mid-generation is not queued twice: `planning.generate-routes` is
// an `exclusive` queue and every send carries the scheme's id as
// `singletonKey`, so a send while a job of that scheme is queued or active
// answers null, and the sweep then writes no run for it — the run that is
// queued or running will cover the week. The run row is inserted before the
// send and rolled back with it when the send answers null, so a null never
// leaves a `queued` run nobody will pick up.
//
// The handler answers what it did, and logs one line per sweep; a failure of
// one company's transaction is logged and the sweep goes on to the next,
// since one tenant's trouble is not another's, and the job then fails so the
// count shows on /readyz.
import { sendGenerateRoutes } from "@waste/db/jobs"
import { generationRun } from "@waste/db/schema/generation"
import { withCompany } from "@waste/db/tenant"
import { planAheadWindow } from "@waste/domain/route-schemes/plan-ahead"
import { sql } from "drizzle-orm"

import { defineJob, type JobContext } from "./definition"
import { loggable } from "./loggable"

export const PLAN_AHEAD_QUEUE = "planning.plan-ahead"
/** 03:00 UTC every day: past midnight in every timezone the demo serves. */
export const PLAN_AHEAD_SCHEDULE = "0 3 * * *"

export type PlanAheadData = {
  /** Where the sweep came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

/** One scheme the sweep found, with the day it is judged on. */
export type EligibleScheme = { companyId: string; projectId: string; routeSchemeId: string; today: string }

/**
 * The sweep: every validated scheme with plan-ahead on whose period overlaps
 * tomorrow through today + 7, today being `at` in the project's timezone.
 * Across companies, as the worker role. `validTo` is the first day out of
 * force, so a scheme ending on the window's first day is not in it.
 */
export async function eligibleSchemes(worker: JobContext["worker"], at: Date): Promise<EligibleScheme[]> {
  const rows = await worker.db.execute<{ company_id: string; project_id: string; route_scheme_id: string; today: string }>(sql`
    select s.company_id, s.project_id, s.id as route_scheme_id, (${at.toISOString()}::timestamptz at time zone p.timezone)::date::text as today
    from wms.route_scheme s
    join wms.project p on p.company_id = s.company_id and p.id = s.project_id
    where s.plan_ahead and s.status = 'validated'
      and s.valid_from <= (${at.toISOString()}::timestamptz at time zone p.timezone)::date + 7
      and (s.valid_to is null or s.valid_to > (${at.toISOString()}::timestamptz at time zone p.timezone)::date + 1)
    order by s.company_id, s.project_id, s.id
  `)
  return rows.map((row) => ({ companyId: row.company_id, projectId: row.project_id, routeSchemeId: row.route_scheme_id, today: row.today }))
}

/** What one sweep did: the runs it wrote and sent, the schemes it found already mid-generation, and the companies whose writes failed. */
export type PlanAheadOutcome = { eligible: number; queued: string[]; alreadyQueued: string[]; failed: string[] }

/**
 * Writes a `cron` run over `planAheadWindow(today)` for each eligible scheme
 * and sends its job in the same fenced transaction; a scheme whose job is
 * already queued or active gets no run. Companies are taken one at a time,
 * each in its own transactions, so a fenced write for one never sees another.
 */
export async function planAhead({ api, worker, now, log, send }: JobContext, jobId: string | null = null): Promise<PlanAheadOutcome> {
  const at = now()
  const schemes = await eligibleSchemes(worker, at)
  const outcome: PlanAheadOutcome = { eligible: schemes.length, queued: [], alreadyQueued: [], failed: [] }
  for (const scheme of schemes) {
    try {
      const sent = await withCompany(api.db, scheme.companyId, async (tx) => {
        const window = planAheadWindow(scheme.today)
        const [run] = await tx
          .insert(generationRun)
          .values({ companyId: scheme.companyId, projectId: scheme.projectId, routeSchemeId: scheme.routeSchemeId, trigger: "cron", windowFrom: window.from, windowTo: window.to, status: "queued" })
          .returning({ id: generationRun.id })
        const sentJobId = await sendGenerateRoutes(send, tx, { generationRunId: run.id, companyId: scheme.companyId, routeSchemeId: scheme.routeSchemeId })
        if (sentJobId === null) {
          // A job of this scheme is queued or active: the run is rolled back with the send, and that run covers the week.
          throw new AlreadyQueued()
        }
        await tx.update(generationRun).set({ jobId: sentJobId }).where(sql`${generationRun.id} = ${run.id}`)
        return run.id
      })
      outcome.queued.push(sent)
    } catch (error) {
      if (error instanceof AlreadyQueued) {
        outcome.alreadyQueued.push(scheme.routeSchemeId)
        continue
      }
      log(`${PLAN_AHEAD_QUEUE}: company ${scheme.companyId}, scheme ${scheme.routeSchemeId} failed: ${JSON.stringify(loggable(error))}`)
      outcome.failed.push(scheme.routeSchemeId)
    }
  }
  log(`${PLAN_AHEAD_QUEUE}: ${at.toISOString()} swept ${outcome.eligible} eligible ${outcome.eligible === 1 ? "scheme" : "schemes"}: ${outcome.queued.length} queued, ${outcome.alreadyQueued.length} already queued, ${outcome.failed.length} failed${jobId === null ? "" : ` (job ${jobId})`}`)
  return outcome
}

/** Thrown inside the fenced transaction to roll the run back when its job was not sent; caught by the sweep. */
class AlreadyQueued extends Error {
  constructor() {
    super("a generation job of this scheme is already queued or active")
  }
}

export const planAheadJob = defineJob<PlanAheadData>({
  queue: PLAN_AHEAD_QUEUE,
  description: "Sweeps every validated route scheme with plan-ahead on, across companies, and queues a generation run over the coming week for each, as wms_api under its company.",
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
