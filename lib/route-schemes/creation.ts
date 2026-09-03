// Scheme creation orchestration (issue #28; docs/new-changes/SPEC.md area A,
// DECISIONS.md D18/D24/D25/D27). Pure data logic — no UI or store
// dependencies — the single planner behind "Create": it composes the existing
// validation outcome (the record's status), the generation engine, and the
// Plan Ahead flag helper, never duplicating their logic. UI submit handlers
// only apply the returned upserts to the record store. Guided Setup calls it
// today; Quick Create joins through its own alignment issue (SPEC area D) so
// the two paths cannot drift apart (P1).
// Harness: scripts/route-scheme-lifecycle-harness.ts.
//
// Create flow (D18): persist scheme → if Validated, immediately generate the
// initial window with each route's Pickups → Plan Ahead on by default →
// Scheduled (displays as Effective when effectiveFrom ≤ today). Draft schemes
// generate nothing. A technically successful generation that plans zero
// routes (all holidays / zero-match day) still counts as successful
// scheduling; only a technical failure leaves the scheme Validated (D25).
// Generation stays decoupled from Vehicle Planning.

import type { BusinessRecord } from "../data/business-modules"
import { calendarFromRecord, type CollectionCalendar } from "./calendar"
import {
  applySchemeGeneration,
  planSchemeGeneration,
  stringValueOf,
  type GenerationSummary,
  type GenerationWindow,
} from "./generation"
import { recordSchemeGeneration } from "./lifecycle"
import { setPlanAhead } from "./plan-ahead"
import {
  addDays,
  formatServiceDate,
  isIsoDate,
  type RecurrenceFrequency,
  type ServiceDay,
  type WeekRotation,
} from "./recurrence"
import { count } from "./text"
import { COLLECTION_GROUPS_KEY } from "./groups"

const INITIAL_WINDOW_DAYS = 7

/**
 * The initial generation window (D24): `start = max(today, effectiveFrom)`,
 * `end = start + 7 days`. Never lengthened to populate the UI — Plan Ahead
 * maintains future coverage.
 */
export function initialGenerationWindow(
  today: string,
  effectiveFrom: string | undefined,
): GenerationWindow {
  const from =
    effectiveFrom && isIsoDate(effectiveFrom) && effectiveFrom > today
      ? effectiveFrom
      : today
  return { from, to: addDays(from, INITIAL_WINDOW_DAYS) }
}

export type SchemeCreationInput = {
  /** The record the create path built — status already Validated or Draft. */
  scheme: BusinessRecord
  today: string
  actorName: string
  /**
   * ISO datetime stamped on the generated routes and the scheme's generation
   * marker; omitted (harness determinism), the marker uses the current time.
   */
  generatedAt?: string
}

export type SchemeCreationRelated = {
  existingRoutes: readonly BusinessRecord[]
  existingPickups: readonly BusinessRecord[]
  /** Container records — rule resolution and pickup enrichment. */
  containers: readonly BusinessRecord[]
  /** Collection Calendar records; the scheme's calendarId resolves here. */
  calendarRecords?: readonly BusinessRecord[]
}

export type SchemeCreationOutcome =
  /** Blocking issues — persisted as Draft, nothing generated (D18). */
  | "draft"
  /** Initial window generated (zero routes included) — Scheduled (D25). */
  | "scheduled"
  /** Validation passed but the generation run failed technically (D25). */
  | "generation-failed"

export type SchemeCreationPlan = {
  /** The scheme record to persist (Plan Ahead flag and status stamp applied). */
  scheme: BusinessRecord
  /** Route records to upsert under route-studio.routes. */
  routes: BusinessRecord[]
  /** Pickup records to upsert under route-studio.pickups. */
  pickups: BusinessRecord[]
  /** The initial window generation ran over; null when nothing ran (Draft). */
  window: GenerationWindow | null
  summary: GenerationSummary | null
  outcome: SchemeCreationOutcome
  /** Human-readable consequence line for toasts. */
  message: string
}

/**
 * The Draft consequence line (D27) — one wording for the review-step preview
 * and the planner's post-create message.
 */
export const SCHEME_DRAFT_CREATION_NOTICE =
  "Saved as Draft — routes will not be generated until the blocking issues are resolved"

/**
 * The creation-orchestration planner (SPEC area A): decides everything that
 * happens after "Create" from the persisted-to-be record and the current
 * related records, and returns every upsert the submit handler must apply.
 * Draft in → Draft out, untouched. Validated in → Plan Ahead on, the initial
 * window generated through the shared engine, and the first-generation stamp
 * (Validated → Scheduled); a run the engine cannot plan or that throws leaves
 * the scheme Validated with Plan Ahead armed for when the configuration is
 * repaired.
 */
export function planSchemeCreation(
  input: SchemeCreationInput,
  related: SchemeCreationRelated,
): SchemeCreationPlan {
  const { scheme, today } = input
  if (scheme.status === "Draft") {
    return {
      scheme,
      routes: [],
      pickups: [],
      window: null,
      summary: null,
      outcome: "draft",
      message: `${SCHEME_DRAFT_CREATION_NOTICE}.`,
    }
  }

  // Plan Ahead on by default for generation-ready schemes (D18) — set before
  // the run so even a failed generation leaves the scheme armed.
  const armed = setPlanAhead(scheme, true)
  const window = initialGenerationWindow(today, stringValueOf(scheme, "effectiveFrom"))
  const windowLabel = `${formatServiceDate(window.from)} → ${formatServiceDate(window.to)}`
  const failed = (): SchemeCreationPlan => ({
    scheme: armed,
    routes: [],
    pickups: [],
    window,
    summary: null,
    outcome: "generation-failed",
    message:
      "Created as Validated — the initial route generation failed, so nothing was scheduled. Use Generate routes to retry.",
  })

  try {
    const calendarId = stringValueOf(scheme, "calendarId")
    const calendar = calendarId
      ? calendarFromRecord(
          related.calendarRecords?.find((record) => record.id === calendarId),
        )
      : null
    const plan = planSchemeGeneration({
      scheme,
      window,
      existingRoutes: related.existingRoutes,
      containers: related.containers,
      calendar,
    })
    // A Validated record the engine cannot read (no structured recurrence) is
    // a technical failure, not scheduling — the scheme stays Validated (D25).
    if (!plan) return failed()
    const result = applySchemeGeneration({
      plan,
      existingPickups: related.existingPickups,
      containers: related.containers,
      actorName: input.actorName,
      ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    })
    const scheduled = recordSchemeGeneration(
      armed,
      input.generatedAt ?? new Date().toISOString(),
    )
    const routesWritten = result.summary.created + result.summary.refreshed
    return {
      scheme: scheduled,
      routes: result.routes,
      pickups: result.pickups,
      window,
      summary: result.summary,
      outcome: "scheduled",
      message:
        routesWritten > 0
          ? `Scheduled — ${count(routesWritten, "route")} with ${count(result.summary.pickups, "pickup")} generated for ${windowLabel}. Plan Ahead is on.`
          : `Scheduled — no routes fall in the initial window (${windowLabel}). Plan Ahead is on and keeps generating future routes.`,
    }
  } catch {
    return failed()
  }
}

/* --------------------- review-step creation preview (D27) ------------------ */

export type SchemeCreationPreviewInput = {
  today: string
  frequency: RecurrenceFrequency
  weekRotation?: WeekRotation
  serviceDays: readonly ServiceDay[]
  effectiveFrom: string
  effectiveTo?: string
  /**
   * Resolved per-(group, day) stop lists — rule matches after tie-breaks or
   * manual picks — one entry per collection group per applicable day.
   */
  groupPlans: ReadonlyArray<{ groupId: string; day: ServiceDay; containerIds: readonly string[] }>
  calendar?: CollectionCalendar | null
}

export type SchemeCreationPreview = {
  window: GenerationWindow
  /** Distinct operating dates a route would be created for, ascending. */
  routeDates: string[]
  /** Routes that would be created — one per collection group per date. */
  routeCount: number
  /**
   * Stop count across those routes — an estimate: rule matches re-resolve at
   * generation time, so the real count can differ (D27 labels it as such).
   */
  estimatedStops: number
  /** Window dates the Collection Calendar invalidates (holiday / non-working). */
  calendarSkipped: number
}

/**
 * What creating the scheme would generate, for the Review & create step
 * (D27): the initial window's route dates and an estimated stop count. Runs
 * the real generation engine over a synthetic record carrying the draft's
 * already-resolved day plans — composition, not a re-implementation — against
 * an empty route set (a new scheme has none; the numbers are labeled
 * estimates). Null when the draft has no structured recurrence yet.
 */
export function previewSchemeCreation(
  input: SchemeCreationPreviewInput,
): SchemeCreationPreview | null {
  // The caller already resolved every group's stops per day, so the synthetic
  // record carries one explicit MANUAL group per (group, day) — the engine
  // then writes exactly one route per group per date, as creation will.
  const groups = input.groupPlans.map((plan) => ({
    id: `${plan.groupId}:${plan.day}`,
    name: plan.groupId,
    days: [plan.day],
    fractions: [],
    stopSource: "manual" as const,
    containerIds: [...plan.containerIds],
  }))
  const scheme: BusinessRecord = {
    id: "scheme-creation-preview",
    name: "Creation preview",
    context: "",
    status: "Validated",
    owner: "",
    value: "",
    updated: "Now",
    description: "",
    facts: {},
    related: [],
    source: "Creation preview",
    freshness: "Now",
    allowedTransitions: [],
    submittedValues: {
      frequency: input.frequency,
      weekRotation: input.weekRotation ?? "",
      serviceDays: input.serviceDays.join(", "),
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? "",
      [COLLECTION_GROUPS_KEY]: JSON.stringify(groups),
    },
  }
  const window = initialGenerationWindow(input.today, input.effectiveFrom)
  const plan = planSchemeGeneration({
    scheme,
    window,
    existingRoutes: [],
    containers: [],
    calendar: input.calendar ?? null,
  })
  if (!plan) return null
  const creates = plan.routes.filter((route) => route.action === "create")
  return {
    window,
    routeDates: Array.from(new Set(creates.map((route) => route.actualDate))),
    routeCount: creates.length,
    estimatedStops: creates.reduce(
      (sum, route) => sum + route.containerIds.length,
      0,
    ),
    calendarSkipped: plan.routes.filter((route) => route.action === "omit").length,
  }
}
