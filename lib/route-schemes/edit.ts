// Edit-save reconciliation orchestration (issue #33; docs/new-changes/SPEC.md
// area G, DECISIONS.md D31). Pure data logic — no UI or store dependencies —
// the single planner behind saving a scheme edit: `Edit → Validate → Save →
// Reconcile future planning window`. It composes the shared live validation
// (lifecycle.ts), the generation engine, and the Plan Ahead flag helper,
// never duplicating their logic; UI submit handlers only apply the returned
// upserts. Harness: scripts/route-scheme-lifecycle-harness.ts.
//
// Flow (D31): a valid edit re-runs generation over the future planning
// window, so recurrence/day/calendar/rule/container/start-time/assignment/
// effective-date changes reflect in future Routes and Stops without manual
// Generate routes and without waiting for Plan Ahead. Touchability: only
// routes in the refreshable statuses (Draft, Planned) are modified —
// Ready/Active/Completed/operationally-Cancelled routes are operational
// history (P2). An edit that invalidates the scheme cancels (never deletes)
// its future refreshable routes with the generation-authored resurrection
// marker; a later valid save re-materializes them idempotently.

import type { BusinessRecord } from "../data/business-modules"
import { calendarFromRecord } from "./calendar"
import {
  applySchemeGeneration,
  approvedDeviationsFromRecords,
  cancelledByGenerationRoute,
  planSchemeGeneration,
  staleGenerationPickup,
  stringValueOf,
  type GenerationSummary,
  type GenerationWindow,
} from "./generation"
import { recordSchemeGeneration, schemeLiveValidation } from "./lifecycle"
import { addDays } from "./recurrence"
import type { SchemeValidationResult } from "./validation"

const EDIT_WINDOW_DAYS = 7

/**
 * The future planning window an edit reconciles: from tomorrow (today's
 * routes are already operating — the Plan Ahead convention) to the later of
 * today + 7 days (the coverage Plan Ahead maintains) or the scheme's furthest
 * future generated route, so previously generated coverage beyond the rolling
 * window cannot silently drift. The engine's walked-range/367-day cap still
 * bounds the walk AND the unserved-date cleanup, so an extreme far-future
 * route can never make the cleanup cancel still-served routes past the
 * truncation point.
 */
export function editReconciliationWindow(
  today: string,
  schemeId: string,
  existingRoutes: readonly BusinessRecord[],
): GenerationWindow {
  const from = addDays(today, 1)
  let to = addDays(today, EDIT_WINDOW_DAYS)
  for (const route of existingRoutes) {
    if (stringValueOf(route, "schemeId") !== schemeId) continue
    const serviceDate = stringValueOf(route, "serviceDate")
    if (serviceDate && serviceDate >= from && serviceDate > to) {
      to = serviceDate
    }
  }
  return { from, to }
}

export type SchemeEditReconciliationInput = {
  /**
   * The stored record as it was before the edit — part of the seam's
   * contract (D31 names the signature `(before, after, related)`). The
   * current planner regenerates the whole window from `after`, so it never
   * diffs against this; it exists for diff-aware refinements (e.g. skipping
   * reconciliation when nothing generation-relevant changed).
   */
  before: BusinessRecord
  /** The edited record (values merged, facts normalized) — status not yet decided. */
  after: BusinessRecord
  today: string
  actorName: string
  /** ISO datetime stamped on written routes; omitted for harness determinism. */
  generatedAt?: string
}

export type SchemeEditReconciliationRelated = {
  /** Every scheme record (this one included; validation excludes it itself). */
  schemes: readonly BusinessRecord[]
  existingRoutes: readonly BusinessRecord[]
  existingPickups: readonly BusinessRecord[]
  /** Container records — rule resolution, pickup enrichment, promises. */
  containers: readonly BusinessRecord[]
  /** Vehicle records — the default vehicle's canonical type. */
  vehicles?: readonly BusinessRecord[]
  /** Vehicle Planning allocation records (issue #11 cross-check). */
  allocations?: readonly BusinessRecord[]
  /** Collection Calendar records; the scheme's calendarId resolves here. */
  calendarRecords?: readonly BusinessRecord[]
  /** Collection Deviation records; approved ones remap window dates. */
  deviationRecords?: readonly BusinessRecord[]
}

export type SchemeEditReconciliationOutcome =
  /** No structured recurrence — nothing to validate or reconcile live. */
  | "legacy"
  /** Blocking issues — Draft; future refreshable routes cancelled, kept. */
  | "draft"
  /** Valid edit — the future window was regenerated/reconciled. */
  | "reconciled"
  /** Validation passed but the generation run failed technically (D25). */
  | "generation-failed"

export type SchemeEditReconciliationPlan = {
  /** The scheme record to persist (status, validation facts, flags applied). */
  scheme: BusinessRecord
  /** Route records to upsert under route-studio.routes. */
  routes: BusinessRecord[]
  /** Pickup records to upsert under route-studio.pickups. */
  pickups: BusinessRecord[]
  /** The window reconciliation ran over; null when nothing ran. */
  window: GenerationWindow | null
  summary: GenerationSummary | null
  /** The live validation outcome the save was judged by; null for legacy. */
  validation: SchemeValidationResult | null
  outcome: SchemeEditReconciliationOutcome
  /** Human-readable consequence line for toasts. */
  message: string
}

/** The one wording for a scheme-became-invalid cancellation (SPEC G). */
export const SCHEME_INVALID_CANCEL_NOTE =
  "Route scheme became invalid — future planning stopped"

const count = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? "" : "s"}`

/** Statuses reconciliation may rewrite — the engine's refreshable set. */
const REFRESHABLE_ROUTE_STATUSES = new Set(["Draft", "Planned"])

/**
 * The furthest future date the engine's day walk can examine — dates past it
 * are never judged, so this pass must not touch them either.
 */
const WALK_CAP_DAYS = 366

/**
 * The scheme's future refreshable routes rewritten as generation-authored
 * cancels — cancelled, never deleted, through the engine's shared cancel
 * shape (cancelledByGenerationRoute) so a later valid save resurrects them.
 * Operational statuses (Ready/Active/Completed, and Cancelled without the
 * marker) are untouched, and so are routes past the walk cap: the fixing
 * save's re-materialization can only reach walked dates, and a cancel it
 * could never resurrect would be a one-way door. Open pickups on the
 * cancelled routes are skipped.
 */
function cancelSchemeFutureRoutes(input: {
  schemeId: string
  today: string
  existingRoutes: readonly BusinessRecord[]
  existingPickups: readonly BusinessRecord[]
  note: string
  generatedAt?: string
}): { routes: BusinessRecord[]; pickups: BusinessRecord[] } {
  const from = addDays(input.today, 1)
  const cap = addDays(from, WALK_CAP_DAYS)
  const routes: BusinessRecord[] = []
  const pickups: BusinessRecord[] = []
  const pickupsByRoute = new Map<string, BusinessRecord[]>()
  for (const pickup of input.existingPickups) {
    const routeId = stringValueOf(pickup, "routeId")
    if (!routeId) continue
    const list = pickupsByRoute.get(routeId) ?? []
    list.push(pickup)
    pickupsByRoute.set(routeId, list)
  }
  for (const route of input.existingRoutes) {
    if (stringValueOf(route, "schemeId") !== input.schemeId) continue
    const serviceDate = stringValueOf(route, "serviceDate")
    if (!serviceDate || serviceDate < from || serviceDate > cap) continue
    if (!REFRESHABLE_ROUTE_STATUSES.has(route.status)) continue
    routes.push(cancelledByGenerationRoute(route, input.note, input.generatedAt))
    for (const pickup of pickupsByRoute.get(route.id) ?? []) {
      const skipped = staleGenerationPickup(pickup, input.note)
      if (skipped) pickups.push(skipped)
    }
  }
  return { routes, pickups }
}

/** The record's facts with the validation outcome re-stamped (history/debug). */
function factsWithValidation(
  record: BusinessRecord,
  validation: SchemeValidationResult,
): BusinessRecord["facts"] {
  const facts = { ...record.facts }
  if (validation.issues.length > 0) {
    facts["Validation issues"] = validation.issues.join(" · ")
  } else {
    delete facts["Validation issues"]
  }
  if (validation.warnings.length > 0) {
    facts["Validation warnings"] = validation.warnings.join(" · ")
  } else {
    delete facts["Validation warnings"]
  }
  return facts
}

/**
 * The edit-save planner (SPEC area G, D31): decides everything that happens
 * after "Save" from the edited record and the current related records, and
 * returns every upsert the submit handler must apply. Live validation (which
 * passes the scheme's own id, so a scheme holding its own Confirmed Vehicle
 * Planning allocation never flips to Draft on save) judges the edit:
 *
 *   valid   → the future window (editReconciliationWindow) is regenerated
 *             through the shared engine — refresh/create/cancel with the
 *             existing touchability and override-preserving semantics — and
 *             the generation marker is restamped (Validated promotes to
 *             Scheduled);
 *   invalid → Draft; future refreshable routes are cancelled with the
 *             resurrection marker, never deleted.
 *
 * Legacy records without structured recurrence save unchanged — there is
 * nothing to validate or reconcile.
 */
export function planSchemeEditReconciliation(
  input: SchemeEditReconciliationInput,
  related: SchemeEditReconciliationRelated,
): SchemeEditReconciliationPlan {
  const { after, today } = input
  const validation = schemeLiveValidation(after, {
    schemes: related.schemes,
    calendars: related.calendarRecords,
    allocations: related.allocations,
    containers: related.containers,
    vehicles: related.vehicles,
  })
  if (!validation) {
    return {
      scheme: after,
      routes: [],
      pickups: [],
      window: null,
      summary: null,
      validation: null,
      outcome: "legacy",
      message: "Saved — no structured recurrence, so no routes were reconciled.",
    }
  }

  if (validation.issues.length > 0) {
    const cancels = cancelSchemeFutureRoutes({
      schemeId: after.id,
      today,
      existingRoutes: related.existingRoutes,
      existingPickups: related.existingPickups,
      note: SCHEME_INVALID_CANCEL_NOTE,
      ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    })
    return {
      scheme: {
        ...after,
        status: "Draft",
        facts: factsWithValidation(after, validation),
      },
      routes: cancels.routes,
      pickups: cancels.pickups,
      window: null,
      summary: null,
      validation,
      outcome: "draft",
      message:
        cancels.routes.length > 0
          ? `Saved as Draft — the edit fails validation, so future planning stopped and ${count(cancels.routes.length, "future route")} ${cancels.routes.length === 1 ? "was" : "were"} cancelled (kept as records). Fixing the scheme re-creates them.`
          : "Saved as Draft — the edit fails validation, so future planning stays stopped until the blocking issues are resolved.",
    }
  }

  // Valid edit. A previously-Draft scheme is (re)validated by this save; a
  // scheme never armed for Plan Ahead gets the generation-ready default
  // (D18) — an explicit off stays off.
  const validated: BusinessRecord = {
    ...after,
    status: after.status === "Draft" ? "Validated" : after.status,
    facts: factsWithValidation(after, validation),
    ...(after.submittedValues?.planAhead === undefined
      ? { submittedValues: { ...after.submittedValues, planAhead: true } }
      : {}),
  }
  const window = editReconciliationWindow(today, after.id, related.existingRoutes)
  const failed = (): SchemeEditReconciliationPlan => ({
    scheme: validated,
    routes: [],
    pickups: [],
    window,
    summary: null,
    validation,
    outcome: "generation-failed",
    message:
      "Saved — reconciling the future routes failed, so they were left as they were. Use Generate routes to retry.",
  })

  try {
    const calendarId = stringValueOf(validated, "calendarId")
    const calendar = calendarId
      ? calendarFromRecord(
          related.calendarRecords?.find((record) => record.id === calendarId),
        )
      : null
    const plan = planSchemeGeneration({
      scheme: validated,
      window,
      existingRoutes: related.existingRoutes,
      deviations: approvedDeviationsFromRecords(related.deviationRecords ?? []),
      containers: related.containers,
      calendar,
    })
    if (!plan) return failed()
    const result = applySchemeGeneration({
      plan,
      existingPickups: related.existingPickups,
      containers: related.containers,
      actorName: input.actorName,
      ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
    })
    const scheme = recordSchemeGeneration(
      validated,
      input.generatedAt ?? new Date().toISOString(),
    )
    const written = result.summary.created + result.summary.refreshed
    const parts = [
      written > 0 ? `${count(written, "future route")} updated` : null,
      result.summary.cancelled > 0
        ? `${count(result.summary.cancelled, "route")} cancelled`
        : null,
    ].filter(Boolean)
    return {
      scheme,
      routes: result.routes,
      pickups: result.pickups,
      window,
      summary: result.summary,
      validation,
      outcome: "reconciled",
      message:
        parts.length > 0
          ? `Saved — ${parts.join(", ")} to match the edited scheme.`
          : "Saved — the future planning window already matches the edited scheme.",
    }
  } catch {
    return failed()
  }
}
