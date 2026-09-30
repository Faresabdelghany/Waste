// A dated Route's routing on the map (#173, decided on #124 §5 and #132 §5):
// every per-route reading off the route's active Plan alone — never a join
// to the quota — and when the map asks `GET /plans/:id` of it.
//
//   Not measured           no active Plan: the generated order stands, drawn dashed
//   Measuring…             calculating, its job due
//   Waiting for routing quota, resumes at 14:32
//                          calculating, the quota putting it off until then
//   18.5 km · 31 min       ready: its legs drawn, the totals, "Not optimised"
//                          beside a baseline's (#124 §4)
//   Routing failed: <the sentence>
//                          failed, with Retry (= Optimise); the sentence is the
//                          Plan's own, read with it when the map draws
//   · Stale                beside any of them when the route's stops moved under the Plan
//
// The route's record carries its active Plan as the list answered it
// (ROUTE_ACTIVE_PLAN_KEY, lib/data/routes.ts). What the map fetches of the
// Plan since, and the Plan a Retry answered while it is still on its way,
// are fresher, and a reading takes them over the record's.
import type { ActivePlan, Plan, PlanDetail } from "@waste/contracts/plans"
import { PLAN_SOLVERS, PLAN_STATUSES, PLAN_TRIPS } from "@waste/domain/routing/vocabulary"

import { typed } from "@/lib/api/records/adapter"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { ROUTE_ACTIVE_PLAN_KEY } from "@/lib/data/routes"
import { resumesPhrase, WAITING_FOR_QUOTA } from "@/lib/routing/readings"

import { formatDistance, formatDuration } from "./format"

const oneOf = <Token extends string>(tokens: readonly Token[], value: unknown): value is Token => typeof value === "string" && (tokens as readonly string[]).includes(value)

const wholeOrNull = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0)

/** The route's active Plan as its record carries it, or null: no Plan, the key absent, "null", or anything that does not read as one. */
export function activePlanOf(record: Pick<BusinessRecord, "submittedValues"> | undefined): ActivePlan | null {
  const text = record === undefined ? undefined : typed(record, ROUTE_ACTIVE_PLAN_KEY)
  if (text === undefined) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const { id, solver, status, trip, distanceMetres, durationSeconds, stale, deferredUntil } = value as Record<string, unknown>
  if (typeof id !== "string" || !oneOf(PLAN_SOLVERS, solver) || !oneOf(PLAN_STATUSES, status) || !oneOf(PLAN_TRIPS, trip)) return null
  if (!wholeOrNull(distanceMetres) || !wholeOrNull(durationSeconds) || typeof stale !== "boolean") return null
  if (deferredUntil !== null && typeof deferredUntil !== "string") return null
  return { id, solver, status, trip, distanceMetres, durationSeconds, stale, deferredUntil }
}

/** The Plan a route's reading is taken from, at its freshest. */
export type RoutePlan = Pick<Plan, "id" | "solver" | "status" | "distanceMetres" | "durationSeconds" | "deferredUntil" | "failureReason"> & {
  stale: boolean
}

/**
 * The Plan a drawn route reads: the one a Retry answered, while the map
 * holds it, else the route's active Plan — its status, totals, deferral and
 * failure as the map last fetched them where it fetched this very Plan,
 * unless that fetch still said calculating of a Plan read finished since,
 * and `stale` off the route's own reading (a Retry's Plan is over the stops
 * as they stand).
 */
export function routePlanOf(active: ActivePlan | null, retried: Plan | null, fetched: PlanDetail | undefined): RoutePlan | null {
  const base = retried ?? active
  if (base === null) return null
  // A result is written once and never undone (#124): a finished status, whichever read it came from, is later than a calculating one.
  const current = fetched !== undefined && fetched.id === base.id && !(fetched.status === "calculating" && base.status !== "calculating") ? fetched : undefined
  const fresh = current ?? retried
  return {
    id: base.id,
    solver: fresh?.solver ?? base.solver,
    status: fresh?.status ?? base.status,
    distanceMetres: fresh?.distanceMetres ?? base.distanceMetres,
    durationSeconds: fresh?.durationSeconds ?? base.durationSeconds,
    deferredUntil: fresh === null || fresh === undefined ? base.deferredUntil : fresh.deferredUntil,
    failureReason: fresh?.failureReason ?? null,
    stale: retried === null && active !== null && active.id === base.id ? active.stale : false,
  }
}

export type PlanReadingKind = "not-measured" | "measuring" | "waiting" | "measured" | "failed"

export type PlanReading = {
  kind: PlanReadingKind
  /** What the route card says. */
  sentence: string
  /** Whether the card offers Retry, which is Optimise (#132 §5). */
  retry: boolean
}

/** What a drawn route's routing reads, on the browser's clock. */
export function planReading(plan: RoutePlan | null, now: Date): PlanReading {
  if (plan === null) return { kind: "not-measured", sentence: "Not measured", retry: false }
  const stale = plan.stale ? " · Stale" : ""
  if (plan.status === "failed") return { kind: "failed", sentence: `Routing failed${plan.failureReason ? `: ${plan.failureReason}` : ""}${stale}`, retry: true }
  if (plan.status === "calculating") {
    const deferred = plan.deferredUntil === null ? Number.NaN : Date.parse(plan.deferredUntil)
    if (Number.isFinite(deferred) && deferred > now.getTime() && plan.deferredUntil !== null) {
      return { kind: "waiting", sentence: `${WAITING_FOR_QUOTA}, ${resumesPhrase(plan.deferredUntil, now)}${stale}`, retry: false }
    }
    return { kind: "measuring", sentence: `Measuring…${stale}`, retry: false }
  }
  const totals = plan.distanceMetres !== null && plan.durationSeconds !== null ? `${formatDistance(plan.distanceMetres)} · ${formatDuration(plan.durationSeconds)}` : "Measured"
  return { kind: "measured", sentence: `${totals}${plan.solver === "baseline" ? " · Not optimised" : ""}${stale}`, retry: false }
}

/** How often the map asks again of a Plan it draws while the Plan calculates with its job due. */
export const PLAN_POLL_MS = 10_000

/** When the map next asks for a drawn route's Plan: never, now, or at an instant (milliseconds). */
export type PlanFetch = { kind: "never" } | { kind: "now" } | { kind: "at"; at: number }

/**
 * Once for a ready Plan (its legs) and once for a failed one (its sentence)
 * — a result is written once and never patched (#124) — every PLAN_POLL_MS
 * while it calculates with its job due, and not before its `deferredUntil`
 * while the quota puts it off, so a deferral hours away costs nothing.
 */
export function nextPlanFetch(plan: RoutePlan, fetched: PlanDetail | undefined, fetchedAt: number | undefined, now: number): PlanFetch {
  const known = fetched !== undefined && fetched.id === plan.id ? fetched : undefined
  if (plan.status !== "calculating") return known !== undefined && known.status === plan.status ? { kind: "never" } : { kind: "now" }
  const deferred = plan.deferredUntil === null ? Number.NaN : Date.parse(plan.deferredUntil)
  if (Number.isFinite(deferred) && deferred > now) return { kind: "at", at: deferred }
  if (known === undefined || fetchedAt === undefined) return { kind: "now" }
  const due = fetchedAt + PLAN_POLL_MS
  return due <= now ? { kind: "now" } : { kind: "at", at: due }
}
