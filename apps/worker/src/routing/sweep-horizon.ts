// The horizon's night (#172): `routing.sweep-horizon` at 03:30 UTC, half an
// hour after Plan Ahead, once however many nights were missed. It reads,
// across companies on the worker role, every planned or ready route of an
// active project operating inside the window with an open stop, nearest date
// first, and hands each to the horizon (horizon.ts) to be asked a Plan where
// its active one is missing or no longer answers it; then every calculating
// Plan more than a day old whose job pg-boss no longer holds — its retries
// spent, or lost across an outage — has its job re-sent under its key. Each
// route and each Plan is its own transaction, so one company's trouble is a
// line in the log and the sweep goes on.
import type { Database, Tx } from "@waste/db/client"
import { routingJobHeld, routingQueueOf, sendRoutingJob } from "@waste/db/commands/plans"
import { route } from "@waste/db/schema/execution"
import { plan } from "@waste/db/schema/routing"
import { loggable } from "@waste/db/sqlstate"
import { withCompany } from "@waste/db/tenant"
import { and, eq, sql } from "drizzle-orm"

import { defineJob, type JobContext } from "../runtime/definition"
import type { RoutingContext } from "./engine"
import { HORIZON_DAYS, horizonFrom, planRoute } from "./horizon"

export const SWEEP_HORIZON_QUEUE = "routing.sweep-horizon"
/** 03:30 UTC every day: half an hour after Plan Ahead (../planning/plan-ahead.ts), whose runs ask for their own routes first. */
export const SWEEP_HORIZON_SCHEDULE = "30 3 * * *"

export type SweepHorizonData = {
  /** Where the sweep came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

/** A route the sweep looks at: its company, and today on its project's clock. */
type HorizonRoute = { companyId: string; routeId: string; today: string }

/**
 * Every planned or ready route of an active project operating inside
 * tomorrow…today + `HORIZON_DAYS` (`horizonFrom`'s bounds), today
 * being `at` rendered in the project's timezone by Postgres, with an open
 * stop: across companies, as the worker role — plan-ahead's precedent —
 * nearest date first. It reads and writes nothing else.
 */
async function horizonRoutes(worker: Database, at: Date): Promise<HorizonRoute[]> {
  const rows = await worker.db.execute<{ company_id: string; route_id: string; today: string }>(sql`
    select r.company_id, r.id as route_id, d.today::text as today
    from wms.route r
    join wms.project p on p.company_id = r.company_id and p.id = r.project_id
    cross join lateral (select (${at.toISOString()}::timestamptz at time zone p.timezone)::date as today) d
    where p.status = 'active'
      and r.status in ('planned', 'ready')
      and r.operating_date between d.today + 1 and d.today + ${HORIZON_DAYS}::int
      and exists (select 1 from wms.pickup k where k.company_id = r.company_id and k.route_id = r.id and k.status = 'planned')
    order by r.operating_date, r.company_id, r.id
  `)
  return rows.map((row) => ({ companyId: row.company_id, routeId: row.route_id, today: row.today }))
}

/** A calculating Plan created more than a day before the sweep: one whose job may be gone. */
type AgedPlan = { companyId: string; planId: string }

/** Every calculating Plan created more than a day before `at`, across companies, as the worker role, oldest first. */
async function agedCalculatingPlans(worker: Database, at: Date): Promise<AgedPlan[]> {
  const rows = await worker.db.execute<{ company_id: string; id: string }>(sql`
    select company_id, id from wms.plan
    where status = 'calculating' and created_at < ${at.toISOString()}::timestamptz - interval '1 day'
    order by created_at, id
  `)
  return rows.map((row) => ({ companyId: row.company_id, planId: row.id }))
}

/**
 * Re-sends an aged Plan's job, `batch`, under the Plan's row lock, when it is
 * still calculating and pg-boss holds no live job under its key; whether it
 * did. The job itself settles a Plan the route has moved past, or a route
 * whose order is closed, without a call.
 */
async function recoverPlan(context: Pick<JobContext, "api" | "send">, aged: AgedPlan): Promise<boolean> {
  return withCompany(context.api.db, aged.companyId, async (tx: Tx): Promise<boolean> => {
    const [locked] = await tx
      .select({ status: plan.status, solver: plan.solver, routeId: plan.routeId })
      .from(plan)
      .where(and(eq(plan.companyId, aged.companyId), eq(plan.id, aged.planId)))
      .for("update")
    if (locked?.status !== "calculating") return false
    const queue = routingQueueOf(locked.solver)
    if (await routingJobHeld(tx, queue, aged.planId)) return false
    const [ofRoute] = await tx
      .select({ operatingDate: route.operatingDate })
      .from(route)
      .where(and(eq(route.companyId, aged.companyId), eq(route.id, locked.routeId)))
    if (ofRoute === undefined) return false
    await sendRoutingJob(context.send, tx, queue, { planId: aged.planId, companyId: aged.companyId, class: "batch" }, ofRoute)
    return true
  })
}

/** What one sweep did: the routes it looked at, those it asked a Plan for (nearest date first), the lost jobs it re-sent, and the routes and Plans whose transaction failed. */
export type SweepOutcome = { inWindow: number; asked: string[]; recovered: string[]; failed: string[] }

/**
 * The night's sweep: every route inside the horizon whose active Plan is
 * missing or no longer answers it asked a Plan, then every aged calculating
 * Plan whose job is gone given its job back. Each route and each Plan is its
 * own transaction, so one company's trouble is logged and the sweep goes on.
 */
export async function sweepHorizon(context: RoutingContext, jobId: string | null = null): Promise<SweepOutcome> {
  const at = context.now()
  const routes = await horizonRoutes(context.worker, at)
  const outcome: SweepOutcome = { inWindow: routes.length, asked: [], recovered: [], failed: [] }
  for (const candidate of routes) {
    try {
      if ((await planRoute(context, candidate.companyId, candidate.routeId, horizonFrom(candidate.today), "unanswered")) === "asked") outcome.asked.push(candidate.routeId)
    } catch (error) {
      context.log(`${SWEEP_HORIZON_QUEUE}: company ${candidate.companyId}, route ${candidate.routeId} failed: ${JSON.stringify(loggable(error))}`)
      outcome.failed.push(candidate.routeId)
    }
  }
  for (const aged of await agedCalculatingPlans(context.worker, at)) {
    try {
      if (await recoverPlan(context, aged)) outcome.recovered.push(aged.planId)
    } catch (error) {
      context.log(`${SWEEP_HORIZON_QUEUE}: company ${aged.companyId}, plan ${aged.planId} failed: ${JSON.stringify(loggable(error))}`)
      outcome.failed.push(aged.planId)
    }
  }
  context.log(
    `${SWEEP_HORIZON_QUEUE}: ${at.toISOString()} swept ${outcome.inWindow} ${outcome.inWindow === 1 ? "route" : "routes"} inside the horizon: ${outcome.asked.length} asked a Plan, ${outcome.recovered.length} lost ${outcome.recovered.length === 1 ? "job" : "jobs"} re-sent, ${outcome.failed.length} failed${jobId === null ? "" : ` (job ${jobId})`}`,
  )
  return outcome
}

export const sweepHorizonJob = defineJob<SweepHorizonData, RoutingContext>({
  queue: SWEEP_HORIZON_QUEUE,
  description: "Asks a Plan, across companies, for every planned or ready route of an active project operating inside tomorrow…today + 7 whose active Plan is missing or no longer answers it, and re-sends the job of a calculating Plan a day old whose job is gone.",
  schedule: SWEEP_HORIZON_SCHEDULE,
  scheduleData: { source: "schedule" },
  // A worker back after a night off sweeps once, not once per missed night: the horizon is tonight's.
  scheduleOptions: { tz: "UTC", missed: "once" },
  // No retry: the next night is the retry. A second pass the same night would take every lock again and re-ask a route whose optimisation or measurement failed finally in the minute between, paying the provider twice; a failed sweep shows on /readyz meanwhile.
  queueOptions: { retryLimit: 0, deleteAfterSeconds: 60 * 60 * 24 * 7 },
  handler: async (jobs, context) => {
    const sweeps: SweepOutcome[] = []
    for (const job of jobs) {
      const outcome = await sweepHorizon(context, job.id)
      sweeps.push(outcome)
      if (outcome.failed.length > 0) throw new Error(`${SWEEP_HORIZON_QUEUE}: ${outcome.failed.length} routes or Plans could not be planned (job ${job.id})`)
    }
    return { sweeps }
  },
})
