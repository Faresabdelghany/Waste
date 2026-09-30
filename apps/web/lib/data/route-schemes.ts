/**
 * Route Schemes — the Route Studio module every scheme surface reads: the
 * list, the scheme page, the wizard, the map's coverage, generation. The
 * module is defined in the Plan workspace's registry and shown in Route
 * Studio only (business-modules.ts), so this is the one place that spells
 * where the records live.
 */
import { schemeLicenceDay, type JudgedDay } from "@waste/domain/planning/checks"
import { editChangesGeneration, futureRefreshableRoutes, schemeEditPolicy, SCHEME_EDIT_APPLICATION_OPTIONS, type SchemeEditApplication, type SchemeEditQuestion } from "@waste/domain/route-schemes/edit"
import { collectionGroupsToValues, type CollectionGroup } from "@waste/domain/route-schemes/groups"
import { schemeGenerationRecorded } from "@waste/domain/route-schemes/lifecycle"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import { isIsoDate } from "@waste/domain/route-schemes/recurrence"
import { isNoMatchIssue, type SchemeValidationResult } from "@waste/domain/route-schemes/validation"

import { typed } from "@/lib/api/records/adapter"

import type { BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"

export const ROUTE_SCHEMES_MODULE = { workspaceId: "route-studio", moduleId: "schemes" } as const satisfies ModuleLocation

/**
 * The status a scheme edit asks the API for on the Pilot, where the API holds
 * the structural rules and generates the routes: the stored one — the web's
 * own validation never lowers a Validated scheme, the API's 409 speaks for
 * what it refuses — and Validated for a Draft the edit leaves without a
 * blocking issue (`issues` from the live validation; null where there is no
 * recurrence to judge), the browser path's rule (D31). So a scheme an edit
 * refused midway left a Draft (PartialWrite) is validated again by the save
 * that fixes it.
 */
export function schemeEditStatusOnApi(stored: string, issues: readonly string[] | null): string {
  return stored === "Draft" && issues !== null && issues.length === 0 ? "Validated" : stored
}

/**
 * The typed values a scheme is created with from a draft — both create
 * paths' (Guided Setup's draft, Quick create's form mapped onto the same
 * shape): the draft's fields under the form's ids and its groups in the one
 * group shape, the legacy single-assignment keys for one group running
 * every service day and the explicit JSON otherwise (D36). `groups` are the
 * draft's with their fleet names denormalized; `extraValues` are the quick
 * form's fields outside the draft, carried verbatim beneath. On the Pilot
 * the route-schemes adapter reads these back into the create body.
 */
export function schemeValuesOfDraft(data: GuidedSchemeData, groups: readonly CollectionGroup[], extraValues: BusinessFormValues = {}): BusinessFormValues {
  return {
    ...extraValues,
    schemeName: data.schemeName.trim(),
    projectId: data.projectId ?? "",
    planningAreaId: data.planningAreaId ?? "",
    wasteFraction: data.wasteFraction,
    serviceType: data.serviceType,
    frequency: data.frequency,
    weekRotation: data.frequency === "every-2-weeks" ? data.weekRotation : "",
    serviceDays: data.serviceDays.join(", "),
    effectiveFrom: data.effectiveFrom,
    effectiveTo: data.effectiveTo,
    plannedStartTime: data.plannedStartTime,
    depotId: data.depotId ?? "",
    unloadingStationId: data.unloadingStationId ?? "",
    // Guided setup options (2026-09-16). Generation applies the holiday
    // policy through the same occurrence generator the wizard previewed with.
    holidayPolicy: data.holidayPolicy,
    createAs: data.createAs,
    // How a later edit of the running scheme applies (issue #38): step 5's
    // choice, or the quick form's; the edit-save planner reads it here.
    editPolicy: data.editPolicy,
    // One group covering every service day stores as the legacy
    // single-assignment shape; anything else stores the groups explicitly
    // (D36) — never both, the group list is the single source of truth.
    ...collectionGroupsToValues(groups, data.serviceDays),
  }
}

/** The timezone the project record of that id names, for its clock's day; undefined when it names none or is not among `projects`. */
export function timezoneOfProject(projects: readonly BusinessRecord[], projectId: string | undefined): string | undefined {
  const timezone = projects.find((record) => record.id === projectId)?.submittedValues?.timezone
  return typeof timezone === "string" && timezone !== "" ? timezone : undefined
}

/** Today on a project's clock, `YYYY-MM-DD`, as the API reads it; the browser's own day for a project that names no timezone the runtime knows. */
export function projectToday(timezone: string | undefined, now: Date = new Date()): string {
  if (timezone) {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
    } catch {
      // An unknown zone reads as the browser's day, below.
    }
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
}

/**
 * The day a collection group's driver is held to their licence on where the
 * API holds it (#178): the scheme's first day or the project's today,
 * whichever is later (`schemeLicenceDay`, @waste/domain/planning/checks) —
 * a draft with no first day yet is judged on today.
 */
export function licenceDayOf(effectiveFrom: string, timezone: string | undefined, now: Date = new Date()): JudgedDay {
  const today = projectToday(timezone, now)
  return schemeLicenceDay(isIsoDate(effectiveFrom) ? effectiveFrom : today, today)
}

/** What the wizard says where the preview's matcher cannot place the API's containers. */
export const PREVIEW_CANNOT_PLACE = "The API matches containers when it generates routes; this preview cannot place them yet."

/**
 * A scheme's validation where the containers it was judged against are the
 * API's (#178): the web's own, less the one issue that is no evidence there.
 * The preview's matcher places no container the API holds (#207 — no
 * planning area on them yet, the fixture words the matcher reads), so its
 * "No containers match the stop rule" says nothing about what generation
 * will find, and the API holds no such rule; a notice stands in its place.
 * Every other issue still blocks, and the status is the web's rule over
 * what is left. With the fixtures' containers the validation is the web's
 * own and there is no notice. Retires with #207.
 */
export function validationOnApi(result: SchemeValidationResult, containersOnApi: boolean): SchemeValidationResult & { notice: string | null } {
  if (!containersOnApi || !result.issues.some(isNoMatchIssue)) return { ...result, notice: null }
  const issues = result.issues.filter((issue) => !isNoMatchIssue(issue))
  return { ...result, status: issues.length === 0 ? "Validated" : "Draft", issues, notice: PREVIEW_CANNOT_PLACE }
}

/** Why the Pilot's question offers "This collection only" disabled, until the API keeps a one-off (#209). */
export const ONE_OFF_NOT_KEPT = "Not offered yet: the API keeps no one-off change, and the next generation run would bring these routes back to the scheme."
/** Why a scheme whose stored policy is the one-off refuses a shaping edit on the Pilot (#209). */
export const STORED_ONE_OFF = "This scheme applies a change to its next collection only, which the API keeps no one-off of yet: set its changes to apply to future collections, or to ask each time, to save one that shapes its collections."
/** Why a shaping edit that would ask is refused while the API's routes are not read. */
export const ROUTES_NOT_READ = "How this change applies is asked over the scheme's routes, which are not read from the API yet: save again once they are."

/** A value as the API reads it: JSON a form wrote (the groups, a rule by day) in one key order, so re-serialising it moves nothing. */
function canonical(value: string | boolean): string | boolean {
  if (typeof value !== "string" || !/^[[{]/.test(value.trim())) return value
  const sorted = (node: unknown): unknown =>
    Array.isArray(node) ? node.map(sorted) : node !== null && typeof node === "object" ? Object.fromEntries(Object.keys(node).sort().map((key) => [key, sorted((node as Record<string, unknown>)[key])])) : node
  try {
    return JSON.stringify(sorted(JSON.parse(value)))
  } catch {
    return value
  }
}

/**
 * Whether an edit shapes a collection as the API reads a scheme: its values
 * alone, the domain's rule (`editChangesGeneration`) over the JSON ones in
 * one key order. The facts are the edit form's display copies by field
 * label, which the API's record never carried and generation never reads.
 */
function shapesCollections(before: BusinessRecord, after: BusinessRecord): boolean {
  const values = (record: BusinessRecord) => Object.fromEntries(Object.entries(record.submittedValues ?? {}).map(([key, value]) => [key, canonical(value)]))
  return editChangesGeneration({ ...before, submittedValues: values(before) }, { ...after, facts: before.facts, submittedValues: values(after) })
}

/** What a scheme edit does on the Pilot: ask how it applies, refuse it with the reason, or save it — `following` the routes the save reaches when they are next generated. */
export type SchemeEditOnApi = { kind: "save"; following: number } | { kind: "ask"; question: SchemeEditQuestion } | { kind: "refuse"; message: string }

/**
 * What a scheme edit does on the Pilot (#179), the fixture path's
 * reconciliation (@waste/domain/route-schemes/edit,
 * `planSchemeEditReconciliation`) over the routes the API holds — `routes`,
 * or null while they are not read. An edit of a scheme that is not running
 * (a Draft, never generated) or that shapes no collection saves. Otherwise
 * the policy decides — the answer given, else the one stored before the edit,
 * so a save that switches "Ask each time" off still asks: "future" saves, the
 * one-off is refused, since the API keeps none yet (#209) — the answer is
 * shown disabled, a stored one-off says to change the policy — and "ask"
 * asks while planned routes of the scheme after `today`, the project's day,
 * can still follow the edit (`futureRefreshableRoutes`, the rule the fixture
 * path counts with: a dispatched route is frozen), the next collection the
 * earliest of them, and saves when none can. Without the routes read the
 * question cannot be asked, so that edit is refused until they are.
 */
export function schemeEditOnApi(before: BusinessRecord, after: BusinessRecord, routes: readonly BusinessRecord[] | null, today: string, apply?: SchemeEditApplication): SchemeEditOnApi {
  const following = () =>
    futureRefreshableRoutes(before.id, today, routes ?? [])
      .map((route) => typed(route, "serviceDate") ?? "")
      .sort()
  if (before.status === "Draft" || !schemeGenerationRecorded(before) || !shapesCollections(before, after)) return { kind: "save", following: 0 }
  const policy = apply ?? schemeEditPolicy(before.submittedValues)
  if (policy === "future") return { kind: "save", following: following().length }
  if (policy === "single") return { kind: "refuse", message: apply === "single" ? ONE_OFF_NOT_KEPT : STORED_ONE_OFF }
  if (routes === null) return { kind: "refuse", message: ROUTES_NOT_READ }
  const dates = following()
  if (dates.length === 0) return { kind: "save", following: 0 }
  return {
    kind: "ask",
    question: {
      futureRoutes: dates.length,
      nextCollectionDate: dates[0],
      options: {
        future: {
          label: SCHEME_EDIT_APPLICATION_OPTIONS.future.label,
          description: "The scheme is saved as edited, and its planned routes follow it when its routes are next generated — Generate on its page, or the nightly Plan Ahead run over the days it covers. Routes that are ready, active or completed stay as they are.",
        },
        single: { ...SCHEME_EDIT_APPLICATION_OPTIONS.single, unavailable: ONE_OFF_NOT_KEPT },
      },
    },
  }
}
