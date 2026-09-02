// Plan Ahead auto-generation (spec docs/specs/ROUTE_SCHEMES.md FR-11,
// ticket #8). Pure data logic — no UI or store dependencies — over the same
// generation engine as the manual flow, so auto-runs obey the identical
// idempotency rules (scripts/route-scheme-plan-ahead-harness.ts).
//
// Rules:
//   the toggle is a scheme flag (submittedValues.planAhead + a "Plan ahead"
//   fact) — flipping it never touches generated routes;
//   an auto-run covers the next 7 days starting tomorrow (the manual
//   dialog's default window) and only processes schemes that are enabled,
//   not soft-deleted (issue #34, D32), in Validated or later (never Draft,
//   never Expired), structurally able to generate, and whose effective
//   window overlaps the run window.

import type { BusinessRecord } from "../data/business-modules"
import { isSoftDeleted } from "../data/record-visibility"
import { calendarFromRecord } from "./calendar"
import {
  applySchemeGeneration,
  planSchemeGeneration,
  stringValueOf,
  type GenerationWindow,
} from "./generation"
import {
  effectiveSchemeStatus,
  recordSchemeGeneration,
  schemeGenerationRecorded,
} from "./lifecycle"
import { addDays, recurrenceFromValues } from "./recurrence"

const PLAN_AHEAD_DAYS = 7

/** Tomorrow through the next 7 days — today's routes are already operating. */
export function planAheadWindow(today: string): GenerationWindow {
  return { from: addDays(today, 1), to: addDays(today, PLAN_AHEAD_DAYS) }
}

export function isPlanAheadEnabled(scheme: BusinessRecord): boolean {
  const value = scheme.submittedValues?.planAhead
  return value === true || value === "true"
}

/** The toggled scheme record to upsert; the input is left untouched. */
export function setPlanAhead(
  scheme: BusinessRecord,
  enabled: boolean,
): BusinessRecord {
  return {
    ...scheme,
    updated: "Now",
    freshness: "Now",
    facts: { ...scheme.facts, "Plan ahead": enabled ? "On" : "Off" },
    submittedValues: { ...scheme.submittedValues, planAhead: enabled },
  }
}

/**
 * Whether an auto-run today should process this scheme at all. A scheme
 * whose effective window misses the run window is skipped entirely rather
 * than planned-to-zero: auto-runs must never touch out-of-window schemes'
 * routes (leftover cleanup stays a manual-generation decision).
 */
export function schemeAutoGenerates(
  scheme: BusinessRecord,
  today: string,
): boolean {
  if (!isPlanAheadEnabled(scheme)) return false
  // Deletion stops Plan Ahead (D32). The marker is the guard, not the flag:
  // a scheme soft-deleted before deletion turned the flag off must stop too.
  if (isSoftDeleted(scheme)) return false
  // "Validated or later, never Draft, never Expired" — through the canonical
  // derived status (issue #25), so a stale persisted status string can
  // neither qualify nor disqualify a scheme.
  const status = effectiveSchemeStatus(scheme, today)
  if (status === "Draft" || status === "Expired") return false
  const recurrence = recurrenceFromValues(scheme.submittedValues ?? {})
  if (!recurrence) return false
  const window = planAheadWindow(today)
  if (recurrence.effectiveFrom > window.to) return false
  if (recurrence.effectiveTo && recurrence.effectiveTo < window.from) return false
  return true
}

export type PlanAheadSummary = {
  /** Schemes whose run produced at least one write. */
  schemes: number
  created: number
  refreshed: number
  cancelled: number
  skipped: number
  /** Dates the schemes' Collection Calendars invalidated (holiday / non-working). */
  calendarSkipped: number
  pickups: number
}

export type PlanAheadRunResult = {
  routes: BusinessRecord[]
  pickups: BusinessRecord[]
  /**
   * Scheme records to upsert: schemes whose FIRST successful generation this
   * run performed, stamped by recordSchemeGeneration (Validated → Scheduled
   * plus the persisted marker). Already-recorded schemes are never restamped,
   * so applying these writes cannot retrigger a run loop.
   */
  schemes: BusinessRecord[]
  summary: PlanAheadSummary
}

/**
 * One Route Studio load's auto-generation: every route and pickup record to
 * upsert across all Plan-Ahead-enabled schemes. Route identity is
 * (schemeId, serviceDate), so schemes never collide and re-running against
 * the produced records refreshes instead of duplicating.
 */
export function runPlanAhead(input: {
  schemes: readonly BusinessRecord[]
  today: string
  existingRoutes: readonly BusinessRecord[]
  existingPickups: readonly BusinessRecord[]
  /** Collection Calendar records; each scheme's calendarId resolves here. */
  calendarRecords?: readonly BusinessRecord[]
  containers: readonly BusinessRecord[]
  actorName: string
  /** ISO datetime stamped on every written route (FR-13's "Last generated"). */
  generatedAt?: string
}): PlanAheadRunResult {
  const window = planAheadWindow(input.today)
  const calendarRecords = input.calendarRecords ?? []
  const routes: BusinessRecord[] = []
  const pickups: BusinessRecord[] = []
  const schemes: BusinessRecord[] = []
  const summary: PlanAheadSummary = {
    schemes: 0,
    created: 0,
    refreshed: 0,
    cancelled: 0,
    skipped: 0,
    calendarSkipped: 0,
    pickups: 0,
  }

  for (const scheme of input.schemes) {
    if (!schemeAutoGenerates(scheme, input.today)) continue
    const calendarId = stringValueOf(scheme, "calendarId")
    const calendar = calendarId
      ? calendarFromRecord(
          calendarRecords.find((record) => record.id === calendarId),
        )
      : null
    const plan = planSchemeGeneration({
      scheme,
      window,
      existingRoutes: input.existingRoutes,
      // Rule-mode schemes (issue #19) resolve their stop-matching rules
      // against these records — the same set manual generation uses.
      containers: input.containers,
      calendar,
    })
    if (!plan) continue
    const result = applySchemeGeneration({
      plan,
      existingPickups: input.existingPickups,
      containers: input.containers,
      actorName: input.actorName,
      ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    })
    // First successful generation → Scheduled (D25). A run that plans zero
    // writes is still a successful generation; only the structural inability
    // above (no plan) is not.
    if (!schemeGenerationRecorded(scheme)) {
      schemes.push(
        recordSchemeGeneration(
          scheme,
          input.generatedAt ?? new Date().toISOString(),
        ),
      )
    }
    summary.created += result.summary.created
    summary.refreshed += result.summary.refreshed
    summary.cancelled += result.summary.cancelled
    summary.skipped += result.summary.skipped
    summary.calendarSkipped += result.summary.calendarSkipped
    summary.pickups += result.summary.pickups
    if (result.routes.length === 0 && result.pickups.length === 0) continue
    summary.schemes += 1
    routes.push(...result.routes)
    pickups.push(...result.pickups)
  }

  return { routes, pickups, schemes, summary }
}
