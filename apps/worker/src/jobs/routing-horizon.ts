// The horizon (#172, decided on #132 §2–4 and #124 §2 and §4): which Routes
// get a Plan without anyone asking. Eager inside the Plan Ahead window —
// tomorrow through today + 7 on the project's clock, `planAheadWindow` — and
// on demand beyond it: an Optimise click, a reorder's measurement, a
// dispatch. Two ways in, one door out:
//
//   generation — `planReshaped`, which generate-routes.ts calls once its
//                run's transaction has committed, with the routes the run
//                created or reshaped: stops inserted, moved, brought back or
//                skipped, the depot or the station changed. A route the run
//                left alone is the sweep's;
//   the sweep  — `routing.sweep-horizon` at 03:30 UTC, half an hour after
//                Plan Ahead, once however many nights were missed: a
//                cross-tenant read on the worker role of every planned or
//                ready route of an active project operating inside the
//                window with an open stop, Plan Ahead on or not, nearest date
//                first, of which it asks for each with no active Plan or a
//                stale one (`planIsStale`); then every calculating Plan more
//                than a day old whose job pg-boss no longer holds — its
//                retries spent, or lost across an outage — has its job
//                re-sent under its key.
//
// Each route is its own transaction as `wms_api` under `withCompany`, under
// the route's row lock (the office's order: a route before its Plans), so the
// route read is the route asked for, and one route's trouble is a line in the
// log, never another route's and never the run's failure: the sweep is the
// net under a generation whose ask failed, and a Route without a Plan is
// complete (#132 §2). What is asked is `horizonRequest`
// (@waste/domain/routing/plans): the Optimise request's size rule — the
// optimiser for fifty open stops or fewer from a depot, a baseline above or
// without one — unless the active Plan is a dispatcher's manual order, which
// the horizon extends and never replaces. The door is the office's own,
// `ensurePlan` (@waste/db/commands/plans), asked `batch`: its cache
// re-activates a ready match and holds a calculating one, so a second run
// over unchanged inputs or a second sweep in a night enqueues nothing, and
// its job is sent in the route's transaction under the Plan's id, at the
// priority the batch class and the operating date give it. No provider is
// called here: the jobs call it, outside any transaction (#124 §4).
import type { Database, Tx } from "@waste/db/client"
import { ensurePlan, planStopIds, routingJobHeld, routingQueueOf, sendRoutingJob } from "@waste/db/commands/plans"
import { projectToday } from "@waste/db/commands/project-clock"
import { pickup, route } from "@waste/db/schema/execution"
import { plan } from "@waste/db/schema/routing"
import { withCompany } from "@waste/db/tenant"
import { orderIsOpen } from "@waste/domain/execution/transitions"
import type { RouteStatus } from "@waste/domain/execution/vocabulary"
import { planAheadWindow } from "@waste/domain/route-schemes/plan-ahead"
import { horizonRequest, planIsStale } from "@waste/domain/routing/plans"
import type { PlanSolver } from "@waste/domain/routing/vocabulary"
import { DEFAULT_PROFILE } from "@waste/routing/provider"
import { and, asc, eq, sql } from "drizzle-orm"

import { defineJob, type JobContext } from "./definition"
import { loggable } from "./loggable"

export const SWEEP_HORIZON_QUEUE = "routing.sweep-horizon"
/** 03:30 UTC every day: half an hour after Plan Ahead (plan-ahead.ts), whose runs ask for their own routes first. */
export const SWEEP_HORIZON_SCHEDULE = "30 3 * * *"

export type SweepHorizonData = {
  /** Where the sweep came from: the schedule, or a caller who sent one by hand. */
  source: "schedule" | "manual"
}

/** The horizon on one project's clock: tomorrow through today + 7. */
type Horizon = ReturnType<typeof planAheadWindow>

/** What one route's turn came to: a Plan asked for (written, or found in the cache), a Plan that still reads fresh, or not a route of the horizon at all. */
type Turn = "asked" | "fresh" | "outside"

/** When a route is asked for: generation's reshaped route whatever its Plan reads, the sweep's only with no active Plan or a stale one. */
type Occasion = "reshaped" | "missing-or-stale"

/** The active Plan as `horizonRequest` reads it: its solver and the stops it names; null when its row is gone. */
async function activePlanOf(tx: Tx, companyId: string, planId: string): Promise<{ solver: PlanSolver; named: string[] } | null> {
  const [row] = await tx
    .select({ solver: plan.solver })
    .from(plan)
    .where(and(eq(plan.companyId, companyId), eq(plan.id, planId)))
  if (row === undefined) return null
  return { solver: row.solver as PlanSolver, named: await planStopIds(tx, { companyId, planId }) }
}

/**
 * One route's turn, in a fenced transaction under its row lock: a planned or
 * ready route operating inside the horizon with an open stop is asked a Plan
 * through the office's door, `batch`; the sweep leaves one whose active Plan
 * still reads fresh.
 */
async function planRoute(context: JobContext, companyId: string, routeId: string, horizon: Horizon, occasion: Occasion): Promise<Turn> {
  return withCompany(context.api.db, companyId, async (tx: Tx): Promise<Turn> => {
    const [row] = await tx
      .select({ id: route.id, projectId: route.projectId, status: route.status, operatingDate: route.operatingDate, depotId: route.depotId, unloadingStationId: route.unloadingStationId, activePlanId: route.activePlanId })
      .from(route)
      .where(and(eq(route.companyId, companyId), eq(route.id, routeId)))
      .for("update")
    if (row === undefined || !orderIsOpen(row.status as RouteStatus) || row.operatingDate < horizon.from || row.operatingDate > horizon.to) return "outside"
    const stops = await tx
      .select({ id: pickup.id, status: pickup.status, reason: pickup.reason })
      .from(pickup)
      .where(and(eq(pickup.companyId, companyId), eq(pickup.routeId, routeId)))
      .orderBy(asc(pickup.position), asc(pickup.id))
    const open = stops.filter((stop) => stop.status === "planned").map((stop) => stop.id)
    // Nothing open is no order to measure: a route whose rule matched nothing, or whose stops are all decided.
    if (open.length === 0) return "outside"
    const active = row.activePlanId === null ? null : await activePlanOf(tx, companyId, row.activePlanId)
    if (occasion === "missing-or-stale" && active !== null) {
      const removed = stops.filter((stop) => stop.status === "skipped" && stop.reason === "regeneration").map((stop) => stop.id)
      if (!planIsStale({ named: active.named, open, removed })) return "fresh"
    }
    const request = horizonRequest({ open, hasDepot: row.depotId !== null, active })
    await ensurePlan(tx, companyId, row, { ...request, class: "batch" }, { routing: { name: context.routing.name, profile: DEFAULT_PROFILE }, send: context.send })
    return "asked"
  })
}

/** A route a generation run created or reshaped, with the day it operates on now. */
export type ReshapedRoute = { id: string; operatingDate: string }

/** What the horizon did for a run's routes: those it asked a Plan for, nearest date first, and those whose turn failed. */
export type HorizonAsks = { asked: string[]; failed: string[] }

/**
 * Generation's routing jobs (#124 §4: outside the generation transaction):
 * after a run has committed, a Plan asked for each route it created or
 * reshaped that operates inside the horizon on the project's clock, nearest
 * date first. Never throws: a failure is a line in the log, and the route
 * waits for the night's sweep.
 */
export async function planReshaped(context: JobContext, scope: { companyId: string; projectId: string }, routes: readonly ReshapedRoute[]): Promise<HorizonAsks> {
  const asks: HorizonAsks = { asked: [], failed: [] }
  if (routes.length === 0) return asks
  let horizon: Horizon
  try {
    horizon = planAheadWindow(await withCompany(context.api.db, scope.companyId, (tx: Tx) => projectToday(tx, scope, context.now)()))
  } catch (error) {
    context.log(`routing: project ${scope.projectId}'s horizon could not be read (${JSON.stringify(loggable(error))}); its routes wait for the night's sweep`)
    return { asked: [], failed: routes.map((row) => row.id) }
  }
  const inside = routes
    .filter((row) => row.operatingDate >= horizon.from && row.operatingDate <= horizon.to)
    .sort((left, right) => left.operatingDate.localeCompare(right.operatingDate) || left.id.localeCompare(right.id))
  for (const row of inside) {
    try {
      if ((await planRoute(context, scope.companyId, row.id, horizon, "reshaped")) === "asked") asks.asked.push(row.id)
    } catch (error) {
      context.log(`routing: route ${row.id} was asked no Plan (${JSON.stringify(loggable(error))}); the night's sweep asks again`)
      asks.failed.push(row.id)
    }
  }
  return asks
}

/** A route the sweep looks at: its company, and today on its project's clock. */
type HorizonRoute = { companyId: string; routeId: string; today: string }

/**
 * Every planned or ready route of an active project operating inside
 * tomorrow…today + 7 (`planAheadWindow`'s bounds, spelled in SQL), today
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
      and r.operating_date between d.today + 1 and d.today + 7
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
async function recoverPlan(context: JobContext, aged: AgedPlan): Promise<boolean> {
  return withCompany(context.api.db, aged.companyId, async (tx: Tx): Promise<boolean> => {
    const [locked] = await tx
      .select({ status: plan.status, solver: plan.solver, routeId: plan.routeId })
      .from(plan)
      .where(and(eq(plan.companyId, aged.companyId), eq(plan.id, aged.planId)))
      .for("update")
    if (locked?.status !== "calculating") return false
    const queue = routingQueueOf(locked.solver as PlanSolver)
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
 * The night's sweep: every route inside the horizon with no active Plan or a
 * stale one asked a Plan, then every aged calculating Plan whose job is gone
 * given its job back. Each route and each Plan is its own transaction, so one
 * company's trouble is logged and the sweep goes on.
 */
export async function sweepHorizon(context: JobContext, jobId: string | null = null): Promise<SweepOutcome> {
  const at = context.now()
  const routes = await horizonRoutes(context.worker, at)
  const outcome: SweepOutcome = { inWindow: routes.length, asked: [], recovered: [], failed: [] }
  for (const candidate of routes) {
    try {
      if ((await planRoute(context, candidate.companyId, candidate.routeId, planAheadWindow(candidate.today), "missing-or-stale")) === "asked") outcome.asked.push(candidate.routeId)
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

export const sweepHorizonJob = defineJob<SweepHorizonData>({
  queue: SWEEP_HORIZON_QUEUE,
  description: "Asks a Plan, across companies, for every planned or ready route of an active project operating inside tomorrow…today + 7 with no active Plan or a stale one, and re-sends the job of a calculating Plan a day old whose job is gone.",
  schedule: SWEEP_HORIZON_SCHEDULE,
  scheduleData: { source: "schedule" },
  // A worker back after a night off sweeps once, not once per missed night: the horizon is tonight's.
  scheduleOptions: { tz: "UTC", missed: "once" },
  // A second sweep re-asks only what the first left unasked, and at most a route whose optimisation failed finally; one retry is enough.
  queueOptions: { retryLimit: 1, retryDelay: 60, deleteAfterSeconds: 60 * 60 * 24 * 7 },
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
