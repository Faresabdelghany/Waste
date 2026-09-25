// Edit-save reconciliation orchestration (issue #33). Pure data logic — no UI or store dependencies —
// the single planner behind saving a scheme edit: `Edit → Validate → Save →
// Reconcile future planning window`. It composes the shared live validation
// (lifecycle.ts), the generation engine, and the Plan Ahead flag helper,
// never duplicating their logic; UI submit handlers only apply the returned
// upserts.
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
//
// The edit policy (issue #38) — "Changes to a running scheme", stored on the
// scheme as `submittedValues.editPolicy` — decides how far an edit of a
// running scheme reaches. A scheme is running once it has generated and is
// not Draft (schemeGenerationRecorded); before that every edit is D31's, and
// so is an edit that shapes no collection — a rename, the policy itself,
// Plan Ahead — whatever the policy says, since there is nothing to apply.
//
//   future  Apply to future collections: the scheme is saved as edited and
//           the window above is regenerated from it, every one-off hold
//           (below) released first, since the template now says what every
//           future collection looks like — the D31 behaviour, now the stored
//           choice.
//   single  This collection only: the edit is a deviation for the next
//           collection and the scheme keeps its stored configuration — the
//           way a recurring appointment edited for "this event only" leaves
//           the series alone. The routes from tomorrow through the next
//           collection (the first date on or after tomorrow the scheme
//           collects on, as stored or as edited, so a collection moved to
//           another day cancels where it was and appears where it goes) are
//           regenerated from the edited configuration and each one written
//           is stamped `thisCollectionOnly` (generation.ts), which every
//           later run, Plan Ahead included, honours by leaving the route as
//           edited: a hold. A rename or a policy change made in the same
//           save lands on the scheme; the shaping inputs do not. An invalid
//           one-off is refused whole — a change for one collection cannot
//           stop the scheme's planning — and nothing changes.
//   ask     Ask each time: the planner does not decide. When the edit shapes
//           a collection and the scheme has a future route a run may still
//           reshape, the plan comes back `outcome: "ask"` with the question —
//           how many future routes, the next collection's date — and no
//           writes at all; the caller shows the choice and plans again with
//           `apply: "future"` or `apply: "single"` in the input. With nothing
//           to reshape the save is D31's, without a question.
//
// An invalidating edit under `ask` or `future` stops future planning as D31
// says (the cancel bounded and marker-carrying as before); a legacy record
// without structured recurrence saves unchanged.

import type { BusinessRecord } from "../prototype-record"
import { isSchemeEditPolicy, type SchemeEditPolicy } from "./creation"
import {
  applySchemeGeneration,
  cancelSchemeFutureRoutes,
  planSchemeGeneration,
  releaseThisCollectionOnly,
  routeIsRefreshable,
  stringValueOf,
  thisCollectionOnlyRoute,
  WALK_CAP_DAYS,
  type GenerationSummary,
  type GenerationWindow,
} from "./generation"
import { schemeGenerationCalendar } from "./project-calendar"
import { recordSchemeGeneration, schemeGenerationRecorded, schemeLiveValidation } from "./lifecycle"
import { generateOccurrences, type SchemeCalendar } from "./occurrences"
import { schemeHolidayPolicy } from "./holidays"
import { addDays, formatServiceDate, recurrenceFromValues } from "./recurrence"
import { count } from "../text"
import type { SchemeValidationResult } from "./validation"

const EDIT_WINDOW_DAYS = 7

/* --------------------------- the edit policy ------------------------------ */

/** The stored policy; a record that predates the field, or carries a stray value, asks — the default creation stamps. */
export function schemeEditPolicy(values: Record<string, string | boolean | undefined> | undefined): SchemeEditPolicy {
  const policy = values?.editPolicy
  return isSchemeEditPolicy(policy) ? policy : "ask"
}

/**
 * How an edit applies once decided: to every future collection, or to the
 * next collection only. The two answers of the "ask" question, and the two
 * policies that never ask.
 */
export type SchemeEditApplication = Exclude<SchemeEditPolicy, "ask">

/**
 * The stored values that shape a collection — what planSchemeGeneration and
 * applySchemeGeneration read off the record: the recurrence, the effective
 * period, the holiday policy, the collection groups in every storage shape,
 * the planned start time, the assignment, the depot and station the routes
 * carry, and the project and area the routes are filed under. Everything
 * else on the form — the name, the edit policy itself, Plan Ahead — changes
 * no collection, so an edit of it is never a one-off and never asks.
 */
const SHAPING_VALUE_KEYS = [
  "frequency",
  "weekRotation",
  "serviceDays",
  "effectiveFrom",
  "effectiveTo",
  "plannedStartTime",
  "holidayPolicy",
  "projectId",
  "planningAreaId",
  "wasteFraction",
  "serviceType",
  "collectionGroups",
  "stopSelection",
  "sameAllDays",
  "containerIds",
  "containersByDay",
  "matchFractions",
  "matchVehicleType",
  "matchContainerTypes",
  "matchRulesByDay",
  "plannedVehicleId",
  "plannedDriverId",
  "serviceProviderId",
  "depotId",
  "unloadingStationId",
] as const

/** The facts generation copies onto every route it writes (applySchemeGeneration): the display names the routes and pickups carry. */
const SHAPING_FACT_KEYS = [
  "Project",
  "Planning area",
  "Vehicle",
  "Driver",
  "Service provider",
  "Departure depot",
  "Unloading station",
] as const

/**
 * Whether the edit changed anything that shapes a collection — the diff-aware
 * refinement D31 left room for. Compares the shaping values and the facts
 * generation copies onto routes; the name, the notes and the policy fields
 * are not among them. An absent value and an empty one are the same value.
 */
export function editChangesGeneration(before: BusinessRecord, after: BusinessRecord): boolean {
  const beforeValues = before.submittedValues ?? {}
  const afterValues = after.submittedValues ?? {}
  for (const key of SHAPING_VALUE_KEYS) {
    if ((beforeValues[key] ?? "") !== (afterValues[key] ?? "")) return true
  }
  for (const key of SHAPING_FACT_KEYS) {
    if ((before.facts[key] ?? "") !== (after.facts[key] ?? "")) return true
  }
  return false
}

/**
 * The scheme's next collection on or after `from`: the first recurrence date
 * the template collects on (a holiday the policy skips is not a collection;
 * a shifted one keeps its recurrence date, the route's identity), or null
 * when the template plans nothing within the engine's walk.
 */
export function nextCollectionDate(
  scheme: BusinessRecord,
  from: string,
  calendar: SchemeCalendar,
): string | null {
  const recurrence = recurrenceFromValues(scheme.submittedValues ?? {})
  if (!recurrence) return null
  const occurrences = generateOccurrences({
    recurrence,
    window: { from, to: addDays(from, WALK_CAP_DAYS) },
    holidayPolicy: schemeHolidayPolicy(scheme.submittedValues),
    calendar,
  })
  const next = occurrences.find((occurrence) => occurrence.status !== "skipped")
  return next?.plannedDate ?? null
}

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

/**
 * The window a one-off reconciles (issue #38): from tomorrow through the next
 * collection of the scheme as stored or as edited, whichever is later — so a
 * collection moved to another day is cancelled where the scheme had it and
 * created where the edit puts it, and a collection taken out is cancelled.
 * Null when neither plans a collection the engine can reach.
 */
export function thisCollectionWindow(
  today: string,
  stored: BusinessRecord,
  edited: BusinessRecord,
  calendar: SchemeCalendar,
): GenerationWindow | null {
  const from = addDays(today, 1)
  const dates = [nextCollectionDate(stored, from, calendar), nextCollectionDate(edited, from, calendar)]
    .filter((date): date is string => date !== null)
    .sort()
  if (dates.length === 0) return null
  return { from, to: dates[dates.length - 1] }
}

/** The scheme's future (from tomorrow) routes a run may still reshape — what "ask" counts. */
export function futureRefreshableRoutes(
  schemeId: string,
  today: string,
  existingRoutes: readonly BusinessRecord[],
): BusinessRecord[] {
  const from = addDays(today, 1)
  return existingRoutes.filter((route) => {
    if (stringValueOf(route, "schemeId") !== schemeId) return false
    const serviceDate = stringValueOf(route, "serviceDate")
    return Boolean(serviceDate && serviceDate >= from) && routeIsRefreshable(route)
  })
}

/**
 * The scheme a one-off leaves behind: the stored record with what the edit
 * changed beside the shaping inputs — the name and every value that shapes
 * no collection (the edit policy, Plan Ahead) — since those are about the
 * scheme, not about a collection. The shaping values and the facts are the
 * stored record's; the one-off's live on the routes it wrote.
 */
export function schemeAfterOneOff(before: BusinessRecord, after: BusinessRecord): BusinessRecord {
  const shaping = new Set<string>(SHAPING_VALUE_KEYS)
  const carried: Record<string, string | boolean> = {}
  for (const [key, value] of Object.entries(after.submittedValues ?? {})) {
    if (!shaping.has(key)) carried[key] = value
  }
  return {
    ...before,
    name: after.name,
    updated: after.updated,
    freshness: after.freshness,
    submittedValues: { ...before.submittedValues, ...carried },
  }
}

export type SchemeEditReconciliationInput = {
  /**
   * The stored record as it was before the edit — part of the seam's
   * contract (D31 names the signature `(before, after, related)`). The
   * planner regenerates from `after` and reads `before` for the policy: whether
   * the scheme is running, whether the edit shapes a collection at all
   * (editChangesGeneration), and, for a one-off, the configuration the
   * scheme keeps.
   */
  before: BusinessRecord
  /** The edited record (values merged, facts normalized) — status not yet decided. */
  after: BusinessRecord
  today: string
  actorName: string
  /** ISO datetime stamped on written routes; omitted for deterministic runs. */
  generatedAt?: string
  /**
   * The answer to the "ask" question (issue #38): how the edit applies. Set
   * by the caller after the person chose in the dialog; it outranks the
   * stored policy. Absent, the stored policy decides — and an "ask" scheme
   * with something to ask about comes back with the question and no writes.
   */
  apply?: SchemeEditApplication
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
  /** Collection Calendar records; the scheme's project holiday list resolves here. */
  calendarRecords?: readonly BusinessRecord[]
  /** Project records (configure.organization); the scheme's project weekend resolves here. */
  projectRecords?: readonly BusinessRecord[]
}

export type SchemeEditReconciliationOutcome =
  /** No structured recurrence — nothing to validate or reconcile live. */
  | "legacy"
  /** Blocking issues — Draft; future refreshable routes cancelled, kept. */
  | "draft"
  /** Valid edit — the future window was regenerated/reconciled. */
  | "reconciled"
  /** Valid edit applied to the next collection only (issue #38) — its routes regenerated from the edit and held; the scheme keeps its configuration. */
  | "single"
  /** A one-off that fails validation (issue #38) — nothing written, nothing changed; a change for one collection cannot stop the scheme's planning. */
  | "refused"
  /** Valid edit under "Ask each time" with future routes to reshape (issue #38) — nothing written; the caller asks and plans again with `apply`. */
  | "ask"
  /** Validation passed but the generation run failed technically (D25). */
  | "generation-failed"

/** What the "ask" dialog says (issue #38): the plan's `question` when the outcome is `ask`. */
export type SchemeEditQuestion = {
  /** The scheme's future routes a run may still reshape, from tomorrow. */
  futureRoutes: number
  /** The next collection's recurrence date — as stored or as edited, whichever comes first — or null when neither plans one. */
  nextCollectionDate: string | null
  /** The two choices, spelled for the dialog. */
  options: Record<SchemeEditApplication, { label: string; description: string }>
}

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
  /** The question to put to the person; set exactly when the outcome is `ask`. */
  question?: SchemeEditQuestion
}

/** The one wording for a scheme-became-invalid cancellation (SPEC G). */
export const SCHEME_INVALID_CANCEL_NOTE =
  "Route scheme became invalid — future planning stopped"

/** The "ask" dialog's two choices (issue #38), spelled once for the dialog and the tests. */
export const SCHEME_EDIT_APPLICATION_OPTIONS: SchemeEditQuestion["options"] = {
  future: {
    label: "Apply to future collections",
    description:
      "The scheme is saved as edited and every future planned route is regenerated from it. Routes that are ready, active or completed stay as they are.",
  },
  single: {
    label: "This collection only",
    description:
      "Only the next collection follows the edit: its routes are regenerated from the change and left as edited by later runs. The scheme itself keeps its current configuration.",
  },
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
 *   valid   → by the edit policy of a running scheme (issue #38, the header):
 *             every future collection — the future window
 *             (editReconciliationWindow) regenerated through the shared
 *             engine, refresh/create/cancel with the existing touchability
 *             and override-preserving semantics, one-off holds released — or
 *             the next collection only — its routes regenerated from the edit
 *             and held, the scheme keeping its configuration — or, under
 *             "ask" with something to ask about, the question and no writes;
 *             a run restamps the generation marker (Validated promotes to
 *             Scheduled);
 *   invalid → Draft; future refreshable routes are cancelled with the
 *             resurrection marker, never deleted — or, for a one-off, refused
 *             whole.
 *
 * Legacy records without structured recurrence save unchanged — there is
 * nothing to validate or reconcile.
 */
export function planSchemeEditReconciliation(
  input: SchemeEditReconciliationInput,
  related: SchemeEditReconciliationRelated,
): SchemeEditReconciliationPlan {
  const { before, after, today } = input
  const validation = schemeLiveValidation(after, {
    schemes: related.schemes,
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

  // The edit policy (issue #38) speaks for a running scheme and an edit that
  // shapes a collection; everything else is D31's save. The caller's answer
  // outranks the stored choice.
  const running = before.status !== "Draft" && schemeGenerationRecorded(before)
  const shaping = editChangesGeneration(before, after)
  const application: SchemeEditApplication | "ask" | null =
    running && shaping ? (input.apply ?? schemeEditPolicy(after.submittedValues)) : null
  const calendar = schemeGenerationCalendar(after, {
    projects: related.projectRecords,
    calendars: related.calendarRecords,
  })

  if (validation.issues.length > 0) {
    if (application === "single") {
      return {
        scheme: before,
        routes: [],
        pickups: [],
        window: null,
        summary: null,
        validation,
        outcome: "refused",
        message: `Not saved — a change for this collection only has to validate, and this one does not: ${validation.issues.join(" · ")}. The scheme and its routes are unchanged.`,
      }
    }
    // Future refreshable routes from tomorrow (today's are operating) through
    // the engine's walk cap: the fixing save's re-materialization can only
    // reach walked dates, and a cancel it could never resurrect would be a
    // one-way door — so, unlike deletion, this cancel is bounded.
    const from = addDays(today, 1)
    const cancels = cancelSchemeFutureRoutes({
      schemeId: after.id,
      from,
      to: addDays(from, WALK_CAP_DAYS),
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

  if (application === "ask") {
    const futureRoutes = futureRefreshableRoutes(after.id, today, related.existingRoutes)
    if (futureRoutes.length > 0) {
      const from = addDays(today, 1)
      const nextDates = [nextCollectionDate(before, from, calendar), nextCollectionDate(validated, from, calendar)]
        .filter((date): date is string => date !== null)
        .sort()
      return {
        scheme: validated,
        routes: [],
        pickups: [],
        window: null,
        summary: null,
        validation,
        outcome: "ask",
        message: `${count(futureRoutes.length, "future route")} can still follow this edit — choose how it applies.`,
        question: {
          futureRoutes: futureRoutes.length,
          nextCollectionDate: nextDates[0] ?? null,
          options: SCHEME_EDIT_APPLICATION_OPTIONS,
        },
      }
    }
  }

  const single = application === "single"
  const window = single
    ? thisCollectionWindow(today, before, validated, calendar)
    : editReconciliationWindow(today, after.id, related.existingRoutes)
  const failed = (): SchemeEditReconciliationPlan => ({
    scheme: single ? schemeAfterOneOff(before, validated) : validated,
    routes: [],
    pickups: [],
    window,
    summary: null,
    validation,
    outcome: "generation-failed",
    message:
      "Saved — reconciling the future routes failed, so they were left as they were. Use Generate routes to retry.",
  })

  if (!window) {
    // A one-off where neither the scheme nor the edit plans a collection the
    // engine can reach: nothing to pin. The scheme keeps its configuration.
    return {
      scheme: schemeAfterOneOff(before, validated),
      routes: [],
      pickups: [],
      window: null,
      summary: null,
      validation,
      outcome: "single",
      message:
        "Saved for this collection only — neither the scheme nor the edit plans an upcoming collection, so no route was changed. The scheme itself is unchanged.",
    }
  }

  try {
    // A shaping edit applied to every future collection releases every
    // one-off hold — the template speaks for every collection again. A new
    // one-off releases the holds on the dates it reshapes (the later edit
    // wins) and leaves other dates' alone; a save that shapes nothing releases
    // nothing, so a rename does not undo a one-off.
    const existingRoutes =
      application === "future"
        ? releaseThisCollectionOnly(after.id, related.existingRoutes)
        : single
          ? related.existingRoutes.map((route) => {
              const serviceDate = stringValueOf(route, "serviceDate")
              return serviceDate && serviceDate >= window.from && serviceDate <= window.to
                ? releaseThisCollectionOnly(after.id, [route], serviceDate)[0]
                : route
            })
          : related.existingRoutes
    const plan = planSchemeGeneration({
      scheme: validated,
      window,
      existingRoutes,
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
    if (single) {
      // Every route this run wrote — created, refreshed or cancelled between
      // tomorrow and the next collection — is the one-off; the marker keeps
      // later runs off it. Cancels are held too: a collection taken off a
      // date must not come back with the next Plan Ahead load. The scheme
      // keeps its configuration and its own generation history — this was
      // not the template's run, so its stamps are not moved.
      const written = result.summary.created + result.summary.refreshed
      const when = formatServiceDate(window.to)
      const parts = [
        written > 0 ? `${count(written, "route")} updated` : null,
        result.summary.cancelled > 0 ? `${count(result.summary.cancelled, "route")} cancelled` : null,
      ].filter(Boolean)
      return {
        scheme: schemeAfterOneOff(before, validated),
        routes: result.routes.map(thisCollectionOnlyRoute),
        pickups: result.pickups,
        window,
        summary: result.summary,
        validation,
        outcome: "single",
        message:
          parts.length > 0
            ? `Saved for this collection only — ${parts.join(", ")} through ${when} and left as edited by later runs. The scheme itself is unchanged.`
            : `Saved for this collection only — no route through ${when} could follow the edit, so none was changed. The scheme itself is unchanged.`,
      }
    }
    const scheme = recordSchemeGeneration(
      validated,
      input.generatedAt ?? new Date().toISOString(),
      plan.matches,
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
