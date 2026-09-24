// Plan Ahead auto-generation (ticket #8). Pure data logic — no UI or store dependencies — over the same
// generation engine as the manual flow, so auto-runs obey the identical
// idempotency rules.
//
// Rules:
//   the toggle is a scheme flag (submittedValues.planAhead + a "Plan ahead"
//   fact) — flipping it never touches generated routes;
//   an auto-run covers the next 7 days starting tomorrow (the manual
//   dialog's default window) and only processes schemes that are enabled,
//   not soft-deleted (issue #34, D32), in Validated or later (never Draft,
//   never Expired), structurally able to generate, and whose effective
//   window overlaps the run window.

import type { BusinessRecord } from "../prototype-record"
import { isSoftDeleted } from "../record-visibility"
import { containerDriftWarning } from "./container-drift"
import { schemeGenerationCalendar } from "./project-calendar"
import {
  applySchemeGeneration,
  planSchemeGeneration,
  type GenerationWindow,
} from "./generation"
import { effectiveSchemeStatus, recordGenerationRun } from "./lifecycle"
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
  const runWindow = planAheadWindow(today)
  if (recurrence.effectiveFrom > runWindow.to) return false
  if (recurrence.effectiveTo && recurrence.effectiveTo < runWindow.from) return false
  return true
}

export type PlanAheadSummary = {
  /** Schemes whose run produced at least one write. */
  schemes: number
  created: number
  refreshed: number
  cancelled: number
  skipped: number
  /** Planned dates the schemes' holiday policies skipped. */
  holidaySkipped: number
  pickups: number
  /**
   * Schemes whose matched containers shifted past the threshold since their
   * previous run (issue #41), each with its Attention sentence — the run
   * summary's note, since an auto-run has no preview a planner could read.
   */
  containerDrift: Array<{ schemeId: string; schemeName: string; warning: string }>
}

export type PlanAheadRunResult = {
  routes: BusinessRecord[]
  pickups: BusinessRecord[]
  /**
   * Scheme records to upsert: what each run left on the scheme through
   * recordGenerationRun — the first-generation stamp (Validated → Scheduled
   * plus the persisted marker) and, on every run, the matches stamp when it
   * moved. A run that recorded nothing new returns no scheme, so a quiet
   * load writes nothing and applying these writes cannot retrigger a run loop.
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
  /** Collection Calendar records; each scheme's project holiday list resolves here. */
  calendarRecords?: readonly BusinessRecord[]
  /** Project records (configure.organization); each scheme's project weekend resolves here. */
  projectRecords?: readonly BusinessRecord[]
  containers: readonly BusinessRecord[]
  actorName: string
  /** ISO datetime stamped on every written route (FR-13's "Last generated"). */
  generatedAt?: string
}): PlanAheadRunResult {
  const runWindow = planAheadWindow(input.today)
  const calendarRecords = input.calendarRecords ?? []
  const projectRecords = input.projectRecords ?? []
  const routes: BusinessRecord[] = []
  const pickups: BusinessRecord[] = []
  const schemes: BusinessRecord[] = []
  const summary: PlanAheadSummary = {
    schemes: 0,
    created: 0,
    refreshed: 0,
    cancelled: 0,
    skipped: 0,
    holidaySkipped: 0,
    pickups: 0,
    containerDrift: [],
  }

  for (const scheme of input.schemes) {
    if (!schemeAutoGenerates(scheme, input.today)) continue
    const plan = planSchemeGeneration({
      scheme,
      window: runWindow,
      existingRoutes: input.existingRoutes,
      // Rule-mode schemes (issue #19) resolve their stop-matching rules
      // against these records — the same set manual generation uses.
      containers: input.containers,
      calendar: schemeGenerationCalendar(scheme, {
        projects: projectRecords,
        calendars: calendarRecords,
      }),
    })
    if (!plan) continue
    const result = applySchemeGeneration({
      plan,
      existingPickups: input.existingPickups,
      containers: input.containers,
      actorName: input.actorName,
      ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    })
    // First successful generation → Scheduled (D25), and on every run the
    // matches stamp (issue #41). A run that plans zero writes is still a
    // successful generation; only the structural inability above (no plan)
    // is not. The stamp comes back unchanged when it did not move.
    const stamped = recordGenerationRun(
      scheme,
      input.generatedAt ?? new Date().toISOString(),
      plan.matches,
    )
    if (stamped !== scheme) schemes.push(stamped)
    const drift = containerDriftWarning(plan.containerDrift)
    if (drift) {
      summary.containerDrift.push({ schemeId: scheme.id, schemeName: scheme.name, warning: drift })
    }
    summary.created += result.summary.created
    summary.refreshed += result.summary.refreshed
    summary.cancelled += result.summary.cancelled
    summary.skipped += result.summary.skipped
    summary.holidaySkipped += result.summary.holidaySkipped
    summary.pickups += result.summary.pickups
    if (result.routes.length === 0 && result.pickups.length === 0) continue
    summary.schemes += 1
    routes.push(...result.routes)
    pickups.push(...result.pickups)
  }

  return { routes, pickups, schemes, summary }
}
