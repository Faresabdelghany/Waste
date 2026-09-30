/**
 * Route Schemes — the Route Studio module every scheme surface reads: the
 * list, the scheme page, the wizard, the map's coverage, generation. The
 * module is defined in the Plan workspace's registry and shown in Route
 * Studio only (business-modules.ts), so this is the one place that spells
 * where the records live.
 */
import { schemeLicenceDay, type JudgedDay } from "@waste/domain/planning/checks"
import { editChangesGeneration, schemeEditPolicy, SCHEME_EDIT_APPLICATION_OPTIONS, type SchemeEditQuestion } from "@waste/domain/route-schemes/edit"
import { collectionGroupsToValues, type CollectionGroup } from "@waste/domain/route-schemes/groups"
import { schemeGenerationRecorded } from "@waste/domain/route-schemes/lifecycle"
import type { GuidedSchemeData } from "@waste/domain/route-schemes/quick-create"
import { isIsoDate } from "@waste/domain/route-schemes/recurrence"
import { isNoMatchIssue, type SchemeValidationResult } from "@waste/domain/route-schemes/validation"

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
export const ONE_OFF_NOT_KEPT = "The API keeps no one-off change yet: the next generation run would bring these routes back to the scheme."

const typedValue = (record: BusinessRecord, key: string) => {
  const value = record.submittedValues?.[key]
  return typeof value === "string" ? value : ""
}

/**
 * The question a scheme edit asks on the Pilot (#179), or null when it asks
 * none — the fixture path's rule (@waste/domain/route-schemes/edit,
 * `planSchemeEditReconciliation`) over the routes the API holds: under the
 * stored policy "Ask each time" (the one before the edit decides, so a save
 * that switches the policy off still asks), for a running scheme (a
 * generation recorded, never a Draft), an edit that shapes a collection, and
 * routes of the scheme that can still follow it — planned, since a
 * dispatched route is frozen, on a service date after `today`, the
 * project's day. The next collection is the earliest of them. "Apply to
 * future collections" saves the scheme and the next generation run brings
 * those routes to it; "This collection only" is shown and not offered
 * (`ONE_OFF_NOT_KEPT`, #209).
 */
export function schemeEditQuestionOnApi(before: BusinessRecord, after: BusinessRecord, routes: readonly BusinessRecord[], today: string): SchemeEditQuestion | null {
  if (schemeEditPolicy(before.submittedValues) !== "ask") return null
  if (before.status === "Draft" || !schemeGenerationRecorded(before)) return null
  if (!editChangesGeneration(before, after)) return null
  const following = routes
    .filter((route) => typedValue(route, "schemeId") === before.id && typedValue(route, "status") === "planned" && typedValue(route, "serviceDate") > today)
    .map((route) => typedValue(route, "serviceDate"))
    .sort()
  if (following.length === 0) return null
  return {
    futureRoutes: following.length,
    nextCollectionDate: following[0],
    options: {
      future: {
        label: SCHEME_EDIT_APPLICATION_OPTIONS.future.label,
        description: "The scheme is saved as edited, and the next generation run brings every future planned route to it. Routes that are ready, active or completed stay as they are.",
      },
      single: { ...SCHEME_EDIT_APPLICATION_OPTIONS.single, unavailable: ONE_OFF_NOT_KEPT },
    },
  }
}
