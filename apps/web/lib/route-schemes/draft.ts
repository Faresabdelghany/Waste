// Guided-setup draft readers shared by the wizard and the create handler.
// Pure data logic — no UI or store dependencies — so the wizard steps, the
// record creation path in business-workspace, and the review previews all
// resolve the same draft the same way. Moved here from the wizard component
// (2026-09-16) so the wizard can import them without an import cycle.

import type { BusinessRecord } from "../data/business-modules"
import { schemeFrequencyPromiseOfRecord } from "../data/service-frequencies"
import {
  collectionGroupContainerIds,
  flattenGroupPlans,
  resolveCollectionGroupPlans,
  schemeAssignmentSources,
  schemeStopRuleSources,
  schemeValidationGroups,
  type CollectionGroup,
  type CollectionGroupResolution,
} from "./groups"
import { schemesInPlanning } from "./lifecycle"
import { vehicleTypeOfRecord } from "./matching"
import type { GuidedSchemeData } from "./quick-create"
import type { SchemeRecurrence } from "./recurrence"
import {
  allocationConflictSources,
  validateScheme,
  type SchemeDayPlan,
  type SchemeFrequencyPromise,
  type SchemeValidationResult,
} from "./validation"

const draftProjectIds = (data: GuidedSchemeData): string[] | undefined =>
  data.projectId ? [data.projectId] : undefined

/**
 * The draft's collection groups with the scheme's waste fraction applied:
 * the fraction is scoped once on the scheme (step 1) and every group
 * inherits it — the single source of truth for what the rules match. A
 * draft without a scheme-level fraction (a quick-created multi-fraction
 * rule) keeps each group's own list.
 */
export function draftGroups(data: GuidedSchemeData): CollectionGroup[] {
  if (!data.wasteFraction) return data.groups
  return data.groups.map((group) => ({ ...group, fractions: [data.wasteFraction] }))
}

/**
 * The draft's collection groups resolved per day against the live container
 * records — the same seam generation uses once the scheme is saved (manual
 * picks, rule matches, and the manual-beats-rule / first-rule-group-wins
 * tie-breaks between groups on a shared day).
 */
export function resolvedDraftGroups(
  data: GuidedSchemeData,
  containers: readonly BusinessRecord[],
): CollectionGroupResolution {
  return resolveCollectionGroupPlans({
    groups: draftGroups(data),
    serviceDays: data.serviceDays,
    areaId: data.planningAreaId,
    projectIds: draftProjectIds(data),
    containers,
  })
}

/** Day-flattened view: every stop any group serves per service day (counts line). */
export function resolvedDraftPlans(
  data: GuidedSchemeData,
  containers: readonly BusinessRecord[],
): SchemeDayPlan[] {
  return flattenGroupPlans(resolvedDraftGroups(data, containers), data.serviceDays)
}

/**
 * FR-5 over the wizard draft plus every existing scheme's planned assignments
 * and the Vehicle Planning allocations (issue #11). Groups validate their own
 * days, assignment, and stops (D33–D35) — the containers and vehicles are
 * needed to resolve the matches and each group's vehicle type. The resolved
 * stops also feed the promised-service-frequency reconciliation (issue #21).
 */
/** The distinct fractions the draft's groups name, in first-seen order. */
function draftFractions(data: GuidedSchemeData): string[] {
  return [...new Set(draftGroups(data).flatMap((group) => group.fractions))]
}

export function validateGuidedScheme(
  data: GuidedSchemeData,
  existingSchemes: readonly BusinessRecord[],
  allocations: readonly BusinessRecord[],
  containers: readonly BusinessRecord[],
  vehicles: readonly BusinessRecord[],
): SchemeValidationResult {
  // Soft-deleted schemes have left planning (issue #34) — the same sibling
  // filter the edit path's schemeLiveValidation applies.
  const siblings = schemesInPlanning(existingSchemes)
  const resolution = resolvedDraftGroups(data, containers)
  const linkedContainerIds = new Set(collectionGroupContainerIds(resolution))
  const promises = containers
    .filter((container) => linkedContainerIds.has(container.id))
    .map((container) => schemeFrequencyPromiseOfRecord(container))
    .filter((promise): promise is SchemeFrequencyPromise => promise !== null)
  const result = validateScheme(
    {
      serviceDays: data.serviceDays,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
      areaId: data.planningAreaId,
      frequencyReconciliation: { frequency: data.frequency, promises },
      ...schemeValidationGroups(
        draftGroups(data),
        resolution,
        (vehicleId) =>
          vehicleTypeOfRecord(vehicles.find((vehicle) => vehicle.id === vehicleId)),
        (containerId) => containers.find((container) => container.id === containerId)?.name,
      ),
    },
    siblings.flatMap((record) => schemeAssignmentSources(record.name, record.submittedValues)),
    allocationConflictSources(allocations),
    schemeStopRuleSources(siblings),
  )
  // A route scheme plans one waste fraction (round 3): Guided Setup enforces
  // it through inheritance; the quick form's multi-fraction rule is the one
  // way a mixed scheme could still be created, so both paths block here.
  const fractions = draftFractions(data)
  if (fractions.length > 1) {
    return {
      ...result,
      status: "Draft",
      issues: [
        `A route scheme plans one waste fraction — this one names ${fractions.join(", ")}`,
        ...result.issues,
      ],
    }
  }
  return result
}

/** The draft's recurrence, or null while it has no service days or start date. */
export function draftRecurrence(data: GuidedSchemeData): SchemeRecurrence | null {
  if (data.serviceDays.length === 0 || !data.effectiveFrom) return null
  return {
    frequency: data.frequency,
    serviceDays: data.serviceDays,
    ...(data.frequency === "every-2-weeks" ? { weekRotation: data.weekRotation } : {}),
    effectiveFrom: data.effectiveFrom,
    effectiveTo: data.effectiveTo,
    startTime: data.plannedStartTime,
  }
}
