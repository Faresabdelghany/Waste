// The scheduled billing run (Issue #112 §7.2 and its deferrals table: "the
// worker runs the same function on a schedule when there is one"). One pg-boss
// queue, `finance.run-billing`, on a cron: the first of each month at 12:00
// UTC, the one hour of the day that is the first of the month on every
// inhabited clock at once — from UTC−11 (01:00 on the 1st) to UTC+11 (23:00
// on the 1st); at UTC+12 and beyond it is already the 2nd, which `monthBefore`
// reads the same way — so the day the run reads on each project's clock is
// the first and the month before it is the month that just ended. (04:00 UTC,
// the earlier choice, was the 1st only east of UTC−4: in Chicago it was still
// 23:00 on the last of the month before, and the run billed the month before
// that, a month late.) A run sent by hand carries a `projectId`, or `null`
// for every project, and an `on` day, or `null` for the process's clock: what
// the schedule sends, `{ projectId: null, on: null }`, is the sweep.
//
// The sweep is the one statement here that reads across tenants — which
// active projects there are — and it runs on the worker role's pool
// (`wms_worker`, BYPASSRLS, the precedent #97's plan-ahead and #104's relay
// set). Everything else is one company's: per project, under `withCompany` on
// the API role's pool, the day is read on the project's clock
// (`dayInTimezone`), the period is the calendar month before it
// (`monthBefore`, the domain's), and `runBilling` — the same command
// `POST /billing-runs` runs in a request — runs it with `null` for the person,
// which is what `billing_run.requested_by` and `invoice.issued_by` are
// nullable for. A `BillingRunStatus` other than `completed` is never written:
// a run is one transaction or nothing, so a company whose run fails leaves no
// `requested` or `failed` row behind — the vocabulary's two other statuses are
// for a run that is enqueued before it is done, which this is not.
//
// One project, one transaction, and one project's failure is not another's:
// a run that refuses (too many ready events — a `Refused`, the ceiling
// the API answers 409) or throws is logged with the project and the job goes
// on to the next; the job fails at the end if any project failed, so pg-boss
// retries it and the count reaches `/readyz`. The retry, and the schedule's
// next occurrence after an office `POST /billing-runs` covered the month,
// skip a project the schedule has already run over the period: a `completed`
// `billing_run` of the project with the same `period_from` and `period_to`
// and `requested_by` null is the schedule's own record that the month was
// looked at, and a second one would be an empty row per healthy project per
// retry — logged `already-run`, nothing written. A person's run over the same
// month (`requested_by` set) does not count as the schedule's: the schedule
// still writes its own row, which then issues nothing (§3: a second run over
// a period issues nothing), so the month has the schedule's record beside the
// person's. Two runs of one project take turns on the project's lock inside
// `runBilling`, so the schedule and an office `POST /billing-runs` over the
// same month never invoice an event twice.
//
// An `onboarding` project is not billed: nothing runs there yet, and the
// schedule reads `status = 'active'`. A project with nothing ready in the
// month gets a completed run of zero invoices, as the API's does, which is the
// record that the month was looked at.
import type { Tx } from "@waste/db/client"
import { runBilling } from "@waste/db/commands/billing-runs"
import { dayInTimezone } from "@waste/db/commands/days"
import { lockRow } from "@waste/db/commands/shared"
import { newId } from "@waste/db/ids"
import { billingRun } from "@waste/db/schema/finance"
import { project } from "@waste/db/schema/organisation"
import { withCompany } from "@waste/db/tenant"
import { monthBefore } from "@waste/domain/finance/periods"
import { and, asc, eq, isNull } from "drizzle-orm"
import type { Job } from "pg-boss"

import { defineJob, type JobContext } from "./definition"

export type RunBillingData = {
  /** One project, or null for every active project of every company: what the schedule sends. */
  projectId: string | null
  /** The `YYYY-MM-DD` day to run as of, on the project's clock, or null for the process's clock rendered on it; the period is the calendar month before that day. */
  on: string | null
}

/** What one project's run came to, for the log and the job's output: completed with its counts, skipped because the schedule already ran over the period (`already-run`, the earlier run named), or failed with the reason. */
export type ProjectRun = { companyId: string; projectId: string; periodFrom: string; periodTo: string } & ({ outcome: "completed"; runId: string; eventCount: number; invoiceCount: number } | { outcome: "already-run"; runId: string } | { outcome: "failed"; reason: string })

/** The active projects to bill, across every company, in id order: the one cross-tenant read, on the worker role's pool. */
async function projectsToBill({ worker }: JobContext, projectId: string | null): Promise<{ companyId: string; id: string; timezone: string }[]> {
  return await worker.db
    .select({ companyId: project.companyId, id: project.id, timezone: project.timezone })
    .from(project)
    .where(and(eq(project.status, "active"), projectId === null ? undefined : eq(project.id, projectId)))
    .orderBy(asc(project.id))
}

/** The schedule's own completed run over exactly this period, if it has one: `requested_by` null, since a person's run over the month is theirs and not the schedule's record. Read under the project's lock, the one `runBilling` takes, so two sweeps of one project see each other's row. */
async function scheduledRunOver(tx: Tx, scope: { companyId: string; projectId: string; periodFrom: string; periodTo: string }): Promise<{ id: string } | undefined> {
  await lockRow(tx, project, { companyId: scope.companyId, id: scope.projectId })
  const [found] = await tx
    .select({ id: billingRun.id })
    .from(billingRun)
    .where(and(eq(billingRun.companyId, scope.companyId), eq(billingRun.projectId, scope.projectId), eq(billingRun.periodFrom, scope.periodFrom), eq(billingRun.periodTo, scope.periodTo), eq(billingRun.status, "completed"), isNull(billingRun.requestedBy)))
    .orderBy(asc(billingRun.id))
    .limit(1)
  return found
}

/** One project's run: the day on its clock, the month before, the schedule's earlier run over it if any, else `runBilling` under the company's fence; what it came to either way. */
async function runOne(context: JobContext, found: { companyId: string; id: string; timezone: string }, on: string | null): Promise<ProjectRun> {
  const where = { companyId: found.companyId, projectId: found.id }
  try {
    const day = on ?? dayInTimezone(context.now(), found.timezone)
    const scope = { ...where, ...monthBefore(day) }
    return await withCompany(context.api.db, found.companyId, async (tx): Promise<ProjectRun> => {
      const before = await scheduledRunOver(tx, scope)
      if (before !== undefined) return { ...scope, outcome: "already-run", runId: before.id }
      const { run } = await runBilling(tx, { ...scope, note: null, requestedBy: null, newId, now: context.now })
      return { ...scope, outcome: "completed", runId: run.id, eventCount: run.eventCount, invoiceCount: run.invoiceCount }
    })
  } catch (error) {
    // A day that is not one has no month before it: the period is the day itself, so the log names what was asked.
    return { ...where, periodFrom: on ?? "", periodTo: on ?? "", outcome: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
}

export const runScheduledBilling = defineJob<RunBillingData>({
  queue: "finance.run-billing",
  description: "Runs billing for every active project over the calendar month before, on the first of each month; a run sent by hand names one project or a day.",
  // Noon UTC: the first of the month on every clock from UTC−11 to UTC+11 at once (the header says why not 04:00).
  schedule: "0 12 1 * *",
  scheduleData: { projectId: null, on: null },
  scheduleOptions: { tz: "UTC", missed: "once" },
  // One retry: a project that failed is retried once the next poll, the ones that succeeded then skipped as already run; the rows are kept a month, since a run is a record someone reads back.
  queueOptions: { retryLimit: 1, retryDelay: 60, deleteAfterSeconds: 60 * 60 * 24 * 30 },
  handler: async (jobs: Job<RunBillingData>[], context: JobContext) => {
    const runs: ProjectRun[] = []
    for (const job of jobs) {
      const { projectId, on } = job.data
      for (const found of await projectsToBill(context, projectId)) {
        const outcome = await runOne(context, found, on)
        runs.push(outcome)
        context.log(
          outcome.outcome === "completed"
            ? `finance.run-billing: project ${outcome.projectId} ${outcome.periodFrom}..${outcome.periodTo} → run ${outcome.runId}, ${outcome.eventCount} events, ${outcome.invoiceCount} invoices (job ${job.id})`
            : outcome.outcome === "already-run"
              ? `finance.run-billing: project ${outcome.projectId} ${outcome.periodFrom}..${outcome.periodTo} → already-run (run ${outcome.runId}; job ${job.id})`
              : `finance.run-billing: project ${outcome.projectId} ${outcome.periodFrom}..${outcome.periodTo} → failed: ${outcome.reason} (job ${job.id})`,
        )
      }
    }
    const failed = runs.filter((run) => run.outcome === "failed")
    if (failed.length > 0) throw new Error(`finance.run-billing: ${failed.length} of ${runs.length} project runs failed: ${failed.map((run) => `${run.projectId} (${run.outcome === "failed" ? run.reason : ""})`).join("; ")}`)
    return { runs }
  },
})
