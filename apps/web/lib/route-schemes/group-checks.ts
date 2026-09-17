// Collection-group checks for the guided setup's step 3 (2026-09-16
// redesign): every scheme service day has a group, no vehicle or driver is
// on two groups the same day, and no group collects container types outside
// the scheme's service type (round 3). Pure data logic — no UI or store
// dependencies. Messages are the product's exact wording; the engine's
// validateScheme raises the first three conditions with older wording, which
// withoutDuplicatedEngineIssues filters so the wizard never lists one
// problem twice.

import type { CollectionGroup } from "./groups"
import { containerTypeShortLabel } from "./matching"
import {
  SERVICE_DAY_LABELS,
  sortServiceDays,
  type ServiceDay,
} from "./recurrence"
import { containerTypesOutsideServiceType } from "./scope"

export type GroupCheckKind = "coverage" | "vehicle" | "driver" | "service-type"

export type GroupCheckIssue = {
  kind: GroupCheckKind
  text: string
  /** The groups the issue names (empty for coverage). */
  groupIds: string[]
  /** The clashing vehicle or driver id (clash issues only). */
  resourceId?: string
  days: ServiceDay[]
}

export type GroupCheckInput = {
  groups: readonly CollectionGroup[]
  serviceDays: readonly ServiceDay[]
  /** The scheme's service type (scope.ts); absent = no container-type restriction. */
  serviceType?: string
  /** Display label for a vehicle id ("WH-07"); falls back to the id. */
  vehicleLabelOf?: (vehicleId: string) => string | undefined
  /** Display name for a driver id; falls back to the id. */
  driverNameOf?: (driverId: string) => string | undefined
}

const fullDays = (days: readonly ServiceDay[]) =>
  sortServiceDays(days).map((day) => SERVICE_DAY_LABELS[day]).join(", ")

function clashes(
  input: GroupCheckInput,
  field: "vehicleId" | "driverId",
  kind: "vehicle" | "driver",
): GroupCheckIssue[] {
  // (resource, day) → the groups holding it that day, in group order.
  const seen = new Map<string, CollectionGroup[]>()
  for (const group of input.groups) {
    const resourceId = group[field]
    if (!resourceId) continue
    for (const day of group.days) {
      if (!input.serviceDays.includes(day)) continue
      const key = `${resourceId}|${day}`
      seen.set(key, [...(seen.get(key) ?? []), group])
    }
  }
  // Fold days per (resource, same group set) so one clash reads as one line.
  const reported = new Map<string, { resourceId: string; groups: CollectionGroup[]; days: ServiceDay[] }>()
  for (const [key, groups] of seen) {
    if (groups.length < 2) continue
    const [resourceId, day] = key.split("|") as [string, ServiceDay]
    const reportKey = `${resourceId}|${groups.map((group) => group.id).join(",")}`
    const entry = reported.get(reportKey)
    if (entry) entry.days.push(day)
    else reported.set(reportKey, { resourceId, groups, days: [day] })
  }
  const label = kind === "vehicle" ? "Vehicle" : "Driver"
  return [...reported.values()].map((entry) => {
    const who =
      kind === "vehicle"
        ? input.vehicleLabelOf?.(entry.resourceId) ?? entry.resourceId
        : input.driverNameOf?.(entry.resourceId) ?? entry.resourceId
    const days = sortServiceDays(entry.days)
    return {
      kind,
      text: `${label} ${who} is on ${entry.groups.map((group) => group.name).join(" and ")} on ${fullDays(days)}`,
      groupIds: entry.groups.map((group) => group.id),
      resourceId: entry.resourceId,
      days,
    }
  })
}

/** "Residual · medium bins has container types outside Kerbside collection: 660 L" — a step 1 change left the group out of scope. */
function outsideServiceType(input: GroupCheckInput): GroupCheckIssue[] {
  if (!input.serviceType) return []
  const serviceType = input.serviceType
  return input.groups.flatMap((group) => {
    const outside = containerTypesOutsideServiceType(group.containerTypes ?? [], serviceType)
    if (outside.length === 0) return []
    return [
      {
        kind: "service-type" as const,
        text: `${group.name} has container types outside ${serviceType}: ${outside
          .map(containerTypeShortLabel)
          .join(", ")}`,
        groupIds: [group.id],
        days: sortServiceDays(group.days),
      },
    ]
  })
}

/**
 * The step's issue list: uncovered days first ("Friday has no collection
 * group"), then vehicle clashes, then driver clashes ("Vehicle WH-07 is on
 * Residual · large bins and Organic on Tuesday, Thursday"), then groups
 * outside the scheme's service type.
 */
export function checkCollectionGroups(input: GroupCheckInput): GroupCheckIssue[] {
  const issues: GroupCheckIssue[] = []
  for (const day of sortServiceDays(input.serviceDays)) {
    if (input.groups.some((group) => group.days.includes(day))) continue
    issues.push({
      kind: "coverage",
      text: `${SERVICE_DAY_LABELS[day]} has no collection group`,
      groupIds: [],
      days: [day],
    })
  }
  issues.push(...clashes(input, "vehicleId", "vehicle"))
  issues.push(...clashes(input, "driverId", "driver"))
  issues.push(...outsideServiceType(input))
  return issues
}

/**
 * The validateScheme wordings for the three conditions checkCollectionGroups
 * already reports. Kept next to the messages they shadow; the unit test pins
 * the engine's current wording so a drift there fails loudly.
 */
export const DUPLICATED_ENGINE_ISSUE_PATTERNS: readonly RegExp[] = [
  /^Add a collection group$/,
  /^No collection group covers /,
  /^Vehicle is planned on both /,
  /^Driver is planned on both /,
]

export function withoutDuplicatedEngineIssues(issues: readonly string[]): string[] {
  return issues.filter(
    (issue) => !DUPLICATED_ENGINE_ISSUE_PATTERNS.some((pattern) => pattern.test(issue)),
  )
}
