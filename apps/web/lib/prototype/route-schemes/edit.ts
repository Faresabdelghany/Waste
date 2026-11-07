// The edit policy's question (issue #38). "Changes to a running scheme",
// stored on the scheme as `submittedValues.editPolicy`, decides how far an
// edit of a running scheme reaches: to every future collection, to the next
// collection only, or — "ask each time" — whichever the person answers. The
// STORED policy decides, the one on `before`: a policy picked in the same
// save is itself an edit, saved for the next time like a rename. An edit
// that shapes no collection — a rename, the policy itself, Plan Ahead —
// never asks, since there is nothing to apply. The web asks the question
// over the routes the API holds (lib/data/route-schemes.ts) and the API
// generates them.

import type { BusinessRecord } from "../prototype-record"
import { isSchemeEditPolicy, type SchemeEditPolicy } from "./creation"
import { addDays } from "@waste/domain/days"
import { stringValue } from "./validation"

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
 * The stored values that shape a collection — what generation reads off the
 * scheme: the recurrence, the effective period, the holiday policy, the
 * collection groups in every storage shape,
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

/** The facts generation copies onto every route it writes: the display names the routes and pickups carry. */
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
 * A shaping value as generation reads it. The one boolean among the shaping
 * keys, `sameAllDays`, is read `!== false` by every reader (matching.ts,
 * validation.ts): a record that never stored it IS same-all-days, so the
 * `true` the groups editor writes for it (collectionGroupsToValues) is no
 * change. Every other key is a string, and an absent one is "".
 */
function shapingValue(
  values: Record<string, string | boolean | undefined>,
  key: (typeof SHAPING_VALUE_KEYS)[number],
): string | boolean {
  if (key === "sameAllDays") return values[key] !== false
  return values[key] ?? ""
}

/**
 * Whether the edit changed anything that shapes a collection — the diff-aware
 * refinement D31 left room for. Compares the shaping values and the facts
 * generation copies onto routes; the name, the notes and the policy fields
 * are not among them. An absent value and an empty one are the same value,
 * and an absent boolean is the value its readers take for it.
 */
export function editChangesGeneration(before: BusinessRecord, after: BusinessRecord): boolean {
  const beforeValues = before.submittedValues ?? {}
  const afterValues = after.submittedValues ?? {}
  for (const key of SHAPING_VALUE_KEYS) {
    if (shapingValue(beforeValues, key) !== shapingValue(afterValues, key)) return true
  }
  for (const key of SHAPING_FACT_KEYS) {
    if ((before.facts[key] ?? "") !== (after.facts[key] ?? "")) return true
  }
  return false
}

const REFRESHABLE_STATUSES = new Set(["Draft", "Planned"])

/** A route generation may still reshape: Draft or Planned — nothing that has reached operations. */
const routeIsRefreshable = (route: BusinessRecord): boolean => REFRESHABLE_STATUSES.has(route.status)

/** The scheme's future (from tomorrow) routes a run may still reshape — what "ask" counts. */
export function futureRefreshableRoutes(
  schemeId: string,
  today: string,
  existingRoutes: readonly BusinessRecord[],
): BusinessRecord[] {
  const from = addDays(today, 1)
  return existingRoutes.filter((route) => {
    if (stringValue(route.submittedValues ?? {}, "schemeId") !== schemeId) return false
    const serviceDate = stringValue(route.submittedValues ?? {}, "serviceDate")
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

/** What the "ask" dialog says (issue #38): the plan's `question` when the outcome is `ask`. */
export type SchemeEditQuestion = {
  /** The scheme's future routes a run may still reshape, from tomorrow. */
  futureRoutes: number
  /** The next collection's recurrence date — as stored or as edited, whichever comes first — or null when neither plans one. */
  nextCollectionDate: string | null
  /** The two choices, spelled for the dialog; `unavailable` says why one is shown but not offered (the Pilot's one-off, #209). */
  options: Record<SchemeEditApplication, { label: string; description: string; unavailable?: string }>
}

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
