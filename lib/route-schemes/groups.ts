// Collection groups inside a Route Scheme. Pure data logic — no UI, store, or fixture
// dependencies — so the wizard, the scheme detail page, validation, and the
// generation engine all read one definition of "which groups does this scheme
// have, on which days, with which vehicle, driver, and stops".
//
// A collection group is the unit generation materializes: one Route per group
// per applicable service day, carrying the group's vehicle, default driver,
// optional service provider, and its stops — matched by rule (waste fractions
// + optional vehicle type inside the scheme's planning area) or picked
// manually. The scheme owns the geography (one planning area), the calendar,
// the recurrence, and the service days; groups inherit all of them.
//
// Storage. Explicit groups are serialized as JSON under
// submittedValues.collectionGroups. Every scheme without that key — the two
// fixtures, every Quick Create scheme, every scheme saved before groups
// existed — resolves to IMPLICIT groups derived from the legacy single-
// assignment shape (plannedVehicleId / plannedDriverId / serviceProviderId +
// stopSelection + the shared or per-day rule / container lists). Implicit
// groups keep the legacy route identity (schemeId, serviceDate), so nothing
// already generated moves; explicit groups extend it with the group id.

import type { BusinessRecord } from "../data/business-modules"
import {
  EMPTY_STOP_MATCH_RULE,
  matchPlansFromValues,
  matchPlansToValues,
  resolveStopMatches,
  stopSelectionMode,
  type StopMatchExclusion,
} from "./matching"
import {
  SERVICE_DAYS,
  SERVICE_DAY_SHORT_LABELS,
  serviceDaysFromValues,
  sortServiceDays,
  type ServiceDay,
} from "./recurrence"
import {
  dayPlansFromValues,
  dayPlansToValues,
  stringValue,
  type SchemeDayPlan,
  type SchemeDefaultsSource,
  type SchemeGroupValidationInput,
  type SchemeStopRuleSource,
  type SchemeValidationInput,
} from "./validation"

export const COLLECTION_GROUPS_KEY = "collectionGroups"

/** The implicit single group's id — the legacy shared-plan shape. */
export const IMPLICIT_GROUP_ID = "default"

export type CollectionGroupStopSource = "rule" | "manual"

export type CollectionGroup = {
  /** Stable within the scheme; part of the route identity for explicit groups. */
  id: string
  name: string
  /** The service days this group runs on — a subset of the scheme's. */
  days: ServiceDay[]
  /** Waste fractions: the matching criterion for rule groups, descriptive for manual ones. */
  fractions: string[]
  /** Required for a Validated scheme; optional in the shape so drafts can exist. */
  vehicleId?: string
  /** The default driver — required for Validated, refined per route at dispatch. */
  driverId?: string
  serviceProviderId?: string
  /** Display names denormalized at save time (the record's facts do the same). */
  vehicleName?: string
  driverName?: string
  serviceProviderName?: string
  stopSource: CollectionGroupStopSource
  /** Rule groups only: the vehicle type the matched containers must be serviceable by. */
  ruleVehicleType?: string
  /** Manual groups only: the picked container ids in stop order. */
  containerIds: string[]
}

export type ResolvedCollectionGroup = CollectionGroup & {
  /** Derived from the legacy single-assignment shape — keeps the legacy route identity. */
  implicit: boolean
}

type StoredValues = Record<string, string | boolean | undefined>

const isServiceDay = (value: unknown): value is ServiceDay =>
  typeof value === "string" && (SERVICE_DAYS as readonly string[]).includes(value)

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : []

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

const compact = <T extends object>(object: T): T => {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) result[key] = value
  }
  return result as T
}

/* --------------------------------- parsing -------------------------------- */

/**
 * Lenient JSON parse of the explicit groups: entries without an id are
 * dropped, unknown days and non-string fractions are filtered, an unknown
 * stop source is manual (never silently a rule — the rule-vs-manual choice is
 * a source of truth, so it is never guessed). Hand-edited or corrupted
 * storage yields no groups, which then falls back to the implicit shape.
 */
export function parseCollectionGroups(raw: string | undefined): CollectionGroup[] {
  if (!raw || !raw.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const groups: CollectionGroup[] = []
  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue
    const entry = candidate as Record<string, unknown>
    const id = optionalString(entry.id)
    if (!id) continue
    const days = sortServiceDays(
      Array.from(new Set((Array.isArray(entry.days) ? entry.days : []).filter(isServiceDay))),
    )
    groups.push(
      compact({
        id,
        name: optionalString(entry.name) ?? id,
        days,
        fractions: stringList(entry.fractions),
        vehicleId: optionalString(entry.vehicleId),
        driverId: optionalString(entry.driverId),
        serviceProviderId: optionalString(entry.serviceProviderId),
        vehicleName: optionalString(entry.vehicleName),
        driverName: optionalString(entry.driverName),
        serviceProviderName: optionalString(entry.serviceProviderName),
        stopSource: entry.stopSource === "rule" ? "rule" : "manual",
        ruleVehicleType: optionalString(entry.ruleVehicleType),
        containerIds: stringList(entry.containerIds),
      }),
    )
  }
  return groups
}

/**
 * The explicitly stored groups, or null when the key is absent or not a JSON
 * array. An explicitly stored EMPTY list is explicit too (a scheme whose
 * groups were all removed): it must validate as "Add a collection group", not
 * fall back to the legacy shape and complain about missing containers.
 */
function explicitCollectionGroups(values: StoredValues | undefined): CollectionGroup[] | null {
  const raw = stringValue(values ?? {}, COLLECTION_GROUPS_KEY)
  if (!raw) return null
  try {
    if (!Array.isArray(JSON.parse(raw))) return null
  } catch {
    return null
  }
  return parseCollectionGroups(raw)
}

export function hasExplicitCollectionGroups(values: StoredValues | undefined): boolean {
  return explicitCollectionGroups(values) !== null
}

/* ------------------------------- resolution ------------------------------- */

/**
 * The groups a scheme's stored values resolve to: the explicit list when
 * present, else the implicit groups derived from the legacy shape — one
 * group covering every service day for a shared plan, one group per day
 * (named by its short day label, so validation messages read "Pick
 * containers for Wed, Sun" exactly as before) for per-day plans. Service
 * days default to the stored `serviceDays`; a draft that has not serialized
 * them yet passes its own. Facts supply the denormalized vehicle/driver/
 * service-provider names the legacy shape keeps only as display facts.
 */
export function collectionGroupsOf(
  values: StoredValues | undefined,
  options: {
    serviceDays?: readonly ServiceDay[]
    facts?: Record<string, string> | undefined
  } = {},
): ResolvedCollectionGroup[] {
  const stored = values ?? {}
  const explicit = explicitCollectionGroups(stored)
  if (explicit) {
    return explicit.map((group) => ({ ...group, implicit: false }))
  }

  const serviceDays = sortServiceDays(options.serviceDays ?? serviceDaysFromValues(stored))
  const facts = options.facts ?? {}
  const assignment = compact({
    vehicleId: stringValue(stored, "plannedVehicleId"),
    driverId: stringValue(stored, "plannedDriverId"),
    serviceProviderId: stringValue(stored, "serviceProviderId"),
    vehicleName: facts.Vehicle?.trim() || undefined,
    driverName: facts.Driver?.trim() || undefined,
    serviceProviderName: facts["Service provider"]?.trim() || undefined,
  })
  const schemeName = stringValue(stored, "schemeName")

  if (stopSelectionMode(stored) === "rule") {
    const plans = matchPlansFromValues(stored)
    if (plans.sameAllDays) {
      return [
        compact({
          id: IMPLICIT_GROUP_ID,
          name: schemeName ?? "Collection",
          days: serviceDays,
          fractions: [...plans.sharedRule.fractions],
          ...assignment,
          stopSource: "rule" as const,
          ruleVehicleType: plans.sharedRule.vehicleType,
          containerIds: [],
          implicit: true,
        }),
      ]
    }
    return serviceDays.map((day) => {
      const rule = plans.rulesByDay[day] ?? EMPTY_STOP_MATCH_RULE
      return compact({
        id: `day-${day}`,
        name: SERVICE_DAY_SHORT_LABELS[day],
        days: [day],
        fractions: [...rule.fractions],
        ...assignment,
        stopSource: "rule" as const,
        ruleVehicleType: rule.vehicleType,
        containerIds: [],
        implicit: true,
      })
    })
  }

  const plans = dayPlansFromValues(stored)
  if (plans.sameAllDays) {
    return [
      compact({
        id: IMPLICIT_GROUP_ID,
        name: schemeName ?? "Collection",
        days: serviceDays,
        fractions: [],
        ...assignment,
        stopSource: "manual" as const,
        containerIds: [...plans.sharedContainerIds],
        implicit: true,
      }),
    ]
  }
  return serviceDays.map((day) =>
    compact({
      id: `day-${day}`,
      name: SERVICE_DAY_SHORT_LABELS[day],
      days: [day],
      fractions: [],
      ...assignment,
      stopSource: "manual" as const,
      containerIds: [...(plans.containersByDay[day] ?? [])],
      implicit: true,
    }),
  )
}

/** Record-level convenience: values plus the record's display facts. */
export function collectionGroupsOfRecord(
  record: Pick<BusinessRecord, "submittedValues" | "facts">,
  serviceDays?: readonly ServiceDay[],
): ResolvedCollectionGroup[] {
  return collectionGroupsOf(record.submittedValues, { serviceDays, facts: record.facts })
}

/* ------------------------------ serialization ----------------------------- */

const sameDaySet = (a: readonly ServiceDay[], b: readonly ServiceDay[]): boolean => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((day) => right.has(day))
}

/**
 * The submittedValues a list of groups stores as. One group covering every
 * service day is the legacy shape itself (planned vehicle/driver/provider +
 * stopSelection + one shared rule or container list) — so single-group
 * schemes keep their route identity, their edit dialog, and every legacy
 * reader unchanged. Anything else — several groups, or a single group that
 * does not cover every day (the coverage gap must survive the save so
 * validation can name it) — serializes explicitly and clears the legacy
 * keys, which would otherwise be inert data pretending to be a source of
 * truth.
 */
export function collectionGroupsToValues(
  groups: readonly CollectionGroup[],
  serviceDays: readonly ServiceDay[],
): Record<string, string | boolean> {
  const cleared = {
    plannedVehicleId: "",
    plannedDriverId: "",
    serviceProviderId: "",
    matchFractions: "",
    matchVehicleType: "",
    matchRulesByDay: "",
    containerIds: "",
    containersByDay: "",
  }
  const [only] = groups
  if (groups.length === 1 && only && sameDaySet(only.days, serviceDays)) {
    const stopValues =
      only.stopSource === "rule"
        ? matchPlansToValues({
            sameAllDays: true,
            sharedRule: {
              fractions: [...only.fractions],
              ...(only.ruleVehicleType ? { vehicleType: only.ruleVehicleType } : {}),
            },
            rulesByDay: {},
          })
        : dayPlansToValues({
            sameAllDays: true,
            sharedContainerIds: [...only.containerIds],
            containersByDay: {},
          })
    return {
      ...cleared,
      [COLLECTION_GROUPS_KEY]: "",
      stopSelection: only.stopSource,
      sameAllDays: true,
      plannedVehicleId: only.vehicleId ?? "",
      plannedDriverId: only.driverId ?? "",
      serviceProviderId: only.serviceProviderId ?? "",
      ...stopValues,
    }
  }
  return {
    ...cleared,
    [COLLECTION_GROUPS_KEY]: JSON.stringify(groups.map((group) => compact({ ...group }))),
    stopSelection: "",
    sameAllDays: true,
  }
}

/* --------------------------------- coverage -------------------------------- */

/** Which groups run on each of the scheme's service days, in canonical day order. */
export function collectionGroupCoverage(
  serviceDays: readonly ServiceDay[],
  groups: readonly CollectionGroup[],
): Array<{ day: ServiceDay; groupIds: string[] }> {
  return sortServiceDays(serviceDays).map((day) => ({
    day,
    groupIds: groups.filter((group) => group.days.includes(day)).map((group) => group.id),
  }))
}

/** Service days no group covers — the "every day has at least one group" invariant. */
export function uncoveredServiceDays(
  serviceDays: readonly ServiceDay[],
  groups: readonly CollectionGroup[],
): ServiceDay[] {
  return collectionGroupCoverage(serviceDays, groups)
    .filter((entry) => entry.groupIds.length === 0)
    .map((entry) => entry.day)
}

/* ------------------------- per-day stop resolution ------------------------- */

type ContainerRecordLike = Parameters<typeof resolveStopMatches>[0]["containers"][number]

export type CollectionGroupDayPlan = {
  groupId: string
  day: ServiceDay
  /** The stops this group actually serves that day, after tie-breaks. */
  containerIds: string[]
  /** Rule near-misses plus containers another group collects that day, each with its reason. */
  excluded: StopMatchExclusion[]
  /** Containers this group would have served but another group claims that day. */
  claimedByOthers: Array<{ containerId: string; groupId: string }>
}

export type CollectionGroupResolution = {
  /** One entry per (group, applicable day), day-major, then group order. */
  plans: CollectionGroupDayPlan[]
  /** A container hand-picked into two groups on one day — an explicit collision (blocking). */
  manualDuplicates: Array<{ containerId: string; day: ServiceDay; groupIds: [string, string] }>
  /** Two rule groups matching the same containers on one day — first group wins (warning). */
  ruleOverlaps: Array<{
    day: ServiceDay
    winnerGroupId: string
    loserGroupId: string
    containerIds: string[]
  }>
}

/**
 * Resolves every group's stops per service day with the agreed tie-breaks
 * (D35): on each day, manual groups claim their picked containers first in
 * group order — an explicit pick is an exception that carves out of the
 * defaults — then rule groups in group order take what their rule matches
 * minus what is already claimed. Nothing is silent: a container another
 * group collects that day appears in the loser's `excluded` list with a
 * reason, a hand-picked duplicate is reported for validation to block, and a
 * rule-vs-rule overlap is reported for validation to warn about.
 */
export function resolveCollectionGroupPlans(input: {
  groups: readonly CollectionGroup[]
  serviceDays: readonly ServiceDay[]
  areaId: string | undefined
  projectIds?: readonly string[]
  containers: readonly ContainerRecordLike[]
}): CollectionGroupResolution {
  const plans: CollectionGroupDayPlan[] = []
  const manualDuplicates: CollectionGroupResolution["manualDuplicates"] = []
  const ruleOverlaps: CollectionGroupResolution["ruleOverlaps"] = []
  const nameOf = new Map(input.groups.map((group) => [group.id, group.name]))
  const containerNames = new Map(
    input.containers.map((container) => [container.id, container.name]),
  )

  // Rule matches do not depend on the day; resolve each rule group once.
  const ruleMatches = new Map<string, ReturnType<typeof resolveStopMatches>>()
  for (const group of input.groups) {
    if (group.stopSource !== "rule") continue
    ruleMatches.set(
      group.id,
      resolveStopMatches({
        rule: {
          fractions: [...group.fractions],
          ...(group.ruleVehicleType ? { vehicleType: group.ruleVehicleType } : {}),
        },
        areaId: input.areaId,
        projectIds: input.projectIds,
        containers: input.containers,
      }),
    )
  }

  for (const day of sortServiceDays(input.serviceDays)) {
    const claimed = new Map<string, string>() // containerId → groupId
    const dayGroups = input.groups.filter((group) => group.days.includes(day))
    const dayPlans = new Map<string, CollectionGroupDayPlan>()

    for (const group of dayGroups.filter((candidate) => candidate.stopSource === "manual")) {
      const containerIds: string[] = []
      const excluded: StopMatchExclusion[] = []
      const claimedByOthers: CollectionGroupDayPlan["claimedByOthers"] = []
      for (const containerId of new Set(group.containerIds)) {
        const owner = claimed.get(containerId)
        if (owner) {
          manualDuplicates.push({ containerId, day, groupIds: [owner, group.id] })
          claimedByOthers.push({ containerId, groupId: owner })
          excluded.push({
            id: containerId,
            name: containerNames.get(containerId) ?? containerId,
            reason: `Picked in ${nameOf.get(owner) ?? owner} on this day`,
          })
          continue
        }
        claimed.set(containerId, group.id)
        containerIds.push(containerId)
      }
      dayPlans.set(group.id, { groupId: group.id, day, containerIds, excluded, claimedByOthers })
    }

    for (const group of dayGroups.filter((candidate) => candidate.stopSource === "rule")) {
      const result = ruleMatches.get(group.id)
      const containerIds: string[] = []
      const excluded: StopMatchExclusion[] = [...(result?.excluded ?? [])]
      const claimedByOthers: CollectionGroupDayPlan["claimedByOthers"] = []
      const lostTo = new Map<string, string[]>()
      for (const profile of result?.matched ?? []) {
        const owner = claimed.get(profile.id)
        if (owner) {
          claimedByOthers.push({ containerId: profile.id, groupId: owner })
          excluded.push({
            id: profile.id,
            name: profile.name,
            reason: `Collected by ${nameOf.get(owner) ?? owner} on this day`,
          })
          const ownerGroup = input.groups.find((candidate) => candidate.id === owner)
          if (ownerGroup?.stopSource === "rule") {
            lostTo.set(owner, [...(lostTo.get(owner) ?? []), profile.id])
          }
          continue
        }
        claimed.set(profile.id, group.id)
        containerIds.push(profile.id)
      }
      for (const [winnerGroupId, ids] of lostTo) {
        ruleOverlaps.push({ day, winnerGroupId, loserGroupId: group.id, containerIds: ids })
      }
      excluded.sort((a, b) => a.name.localeCompare(b.name))
      dayPlans.set(group.id, { groupId: group.id, day, containerIds, excluded, claimedByOthers })
    }

    // Emit in group order (not manual-first) so the preview reads like the wizard.
    for (const group of dayGroups) {
      const plan = dayPlans.get(group.id)
      if (plan) plans.push(plan)
    }
  }

  return { plans, manualDuplicates, ruleOverlaps }
}

/** Every container id any group serves on any day (frequency promises, relation refs). */
export function collectionGroupContainerIds(
  resolution: Pick<CollectionGroupResolution, "plans">,
): string[] {
  return Array.from(new Set(resolution.plans.flatMap((plan) => plan.containerIds)))
}

/* ---------------------------------- display -------------------------------- */

/** "Organic run · Wed, Sun · NR-08 · Lars Møller" — one line per group for facts and lists. */
export function collectionGroupSummary(group: CollectionGroup): string {
  const days = group.days.map((day) => SERVICE_DAY_SHORT_LABELS[day]).join(", ") || "No days"
  const parts = [group.name, days]
  if (group.fractions.length > 0) parts.push(group.fractions.join(", "))
  if (group.vehicleName) parts.push(group.vehicleName)
  if (group.driverName) parts.push(group.driverName)
  return parts.join(" · ")
}

/* ------------------------- record-level resolution ------------------------- */

type SchemeRecordLike = Pick<BusinessRecord, "submittedValues" | "projectIds"> & {
  facts?: Record<string, string>
}

/**
 * THE seam every consumer resolves a scheme's stops through — generation
 * (manual Generate routes AND Plan Ahead), live validation, the scheme
 * detail, and the wizard preview: the record's groups (implicit or explicit)
 * resolved per applicable day against the supplied container records, so the
 * result always reflects the containers that exist NOW.
 */
export function schemeGroupPlans(
  scheme: SchemeRecordLike,
  serviceDays: readonly ServiceDay[],
  containers: readonly ContainerRecordLike[],
): { groups: ResolvedCollectionGroup[]; resolution: CollectionGroupResolution } {
  const groups = collectionGroupsOf(scheme.submittedValues, {
    serviceDays,
    facts: scheme.facts,
  })
  const resolution = resolveCollectionGroupPlans({
    groups,
    serviceDays,
    areaId: stringValue(scheme.submittedValues ?? {}, "planningAreaId"),
    projectIds: scheme.projectIds,
    containers,
  })
  return { groups, resolution }
}

/**
 * The day-flattened view of a resolution: every stop any group serves on a
 * service day, in group order — for callers that only need "which containers
 * does this scheme touch on Wednesday" (frequency promises, relation refs,
 * the per-day counts line). Generation reads the per-group plans instead.
 */
export function flattenGroupPlans(
  resolution: Pick<CollectionGroupResolution, "plans">,
  serviceDays: readonly ServiceDay[],
): SchemeDayPlan[] {
  return sortServiceDays(serviceDays).map((day) => ({
    day,
    containerIds: resolution.plans
      .filter((plan) => plan.day === day)
      .flatMap((plan) => plan.containerIds),
  }))
}

/** Record-level day-flattened stops (see flattenGroupPlans). */
export function effectiveStopPlans(
  scheme: SchemeRecordLike,
  serviceDays: readonly ServiceDay[],
  containers: readonly ContainerRecordLike[],
): SchemeDayPlan[] {
  return flattenGroupPlans(schemeGroupPlans(scheme, serviceDays, containers).resolution, serviceDays)
}

/**
 * The service provider every group shares, if exactly one and all groups
 * name it — the record-level `serviceProviderId` / "Service provider" fact.
 */
export function sharedServiceProvider(
  groups: readonly CollectionGroup[],
): { id?: string; name?: string } {
  const ids = new Set(groups.map((group) => group.serviceProviderId ?? ""))
  if (ids.size !== 1 || ids.has("")) return {}
  const [id] = ids
  return { id, name: groups.find((group) => group.serviceProviderId === id)?.serviceProviderName }
}

/* ------------------------- issue → group attribution ------------------------ */

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Which validation issues name which group. Validation messages are strings,
 * so attribution matches a group's name on word boundaries and, when several
 * group names match one message ("Glass" and "Glass run"), credits only the
 * longest — the most specific — name. Empty names never match.
 */
export function issuesByGroup(
  groups: readonly CollectionGroup[],
  issues: readonly string[],
): Map<string, string[]> {
  const byGroup = new Map<string, string[]>(groups.map((group) => [group.id, []]))
  const matchers = groups
    .filter((group) => group.name.trim().length > 0)
    .map((group) => ({
      group,
      pattern: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(group.name)}(?=$|[^\\p{L}\\p{N}])`, "u"),
    }))
  for (const issue of issues) {
    const matched = matchers.filter(({ pattern }) => pattern.test(issue))
    if (matched.length === 0) continue
    const longest = Math.max(...matched.map(({ group }) => group.name.length))
    for (const { group } of matched) {
      if (group.name.length === longest) byGroup.get(group.id)?.push(issue)
    }
  }
  return byGroup
}

/** Issues no group's name claims — scheme-level (coverage, dates, single-group wording). */
export function unattributedIssues(
  groups: readonly CollectionGroup[],
  issues: readonly string[],
): string[] {
  const attributed = new Set([...issuesByGroup(groups, issues).values()].flat())
  return issues.filter((issue) => !attributed.has(issue))
}

/* ---------------------------- validation input ---------------------------- */

/**
 * The validation view of resolved groups: per group, its days and assignment
 * plus the per-day stop counts after tie-breaks — with the manual duplicates
 * and rule overlaps validation turns into a blocking issue and a warning.
 */
export function schemeValidationGroups(
  groups: readonly CollectionGroup[],
  resolution: CollectionGroupResolution,
  vehicleTypeOf: (vehicleId: string | undefined) => string | null = () => null,
  containerNameOf: (containerId: string) => string | undefined = () => undefined,
): Pick<SchemeValidationInput, "groups" | "manualDuplicates" | "ruleOverlaps"> {
  return {
    groups: groups.map(
      (group): SchemeGroupValidationInput => ({
        id: group.id,
        name: group.name,
        days: group.days,
        vehicleId: group.vehicleId,
        driverId: group.driverId,
        vehicleType: vehicleTypeOf(group.vehicleId),
        stopSource: group.stopSource,
        fractions: group.fractions,
        ruleVehicleType: group.ruleVehicleType,
        dayStops: resolution.plans
          .filter((plan) => plan.groupId === group.id)
          .map((plan) => ({
            day: plan.day,
            count: plan.containerIds.length,
            claimedByOthers: plan.claimedByOthers.length,
          })),
      }),
    ),
    manualDuplicates: resolution.manualDuplicates.map((duplicate) => ({
      ...duplicate,
      containerName: containerNameOf(duplicate.containerId),
    })),
    ruleOverlaps: resolution.ruleOverlaps,
  }
}

/* ------------------------ sources for sibling schemes ---------------------- */

/**
 * What FR-5(d) needs from an existing scheme: one planned-assignment source
 * per collection group — a legacy single-assignment scheme is one source, a
 * multi-group scheme one per explicit group (named). Groups without any
 * assignment, and schemes without structured service days, cannot conflict.
 */
export function schemeAssignmentSources(
  schemeName: string,
  values: StoredValues | undefined,
): SchemeDefaultsSource[] {
  if (!values) return []
  const serviceDays = serviceDaysFromValues(values)
  if (serviceDays.length === 0) return []
  const groups = collectionGroupsOf(values, { serviceDays })
  const effectiveFrom = stringValue(values, "effectiveFrom")
  const effectiveTo = stringValue(values, "effectiveTo")
  if (groups.every((group) => group.implicit)) {
    const [first] = groups
    if (!first || (!first.vehicleId && !first.driverId)) return []
    return [
      {
        schemeName,
        serviceDays,
        plannedVehicleId: first.vehicleId,
        plannedDriverId: first.driverId,
        effectiveFrom,
        effectiveTo,
      },
    ]
  }
  return groups
    .filter((group) => group.vehicleId || group.driverId)
    .map((group) => ({
      schemeName,
      groupName: group.name,
      serviceDays: sortServiceDays(group.days.filter((day) => serviceDays.includes(day))),
      plannedVehicleId: group.vehicleId,
      plannedDriverId: group.driverId,
      effectiveFrom,
      effectiveTo,
    }))
}

/**
 * What the rule-overlap warning needs from the existing schemes: per rule
 * group, its area, days, fractions, and effective period — a legacy rule
 * scheme is one source carrying its fraction union. Manual groups and
 * schemes without an area or service days cannot overlap by rule.
 */
export function schemeStopRuleSources(
  records: readonly Pick<BusinessRecord, "name" | "submittedValues">[],
): SchemeStopRuleSource[] {
  const sources: SchemeStopRuleSource[] = []
  for (const record of records) {
    const values = record.submittedValues
    if (!values) continue
    const areaId = stringValue(values, "planningAreaId")
    if (!areaId) continue
    const serviceDays = serviceDaysFromValues(values)
    if (serviceDays.length === 0) continue
    const groups = collectionGroupsOf(values, { serviceDays }).filter(
      (group) => group.stopSource === "rule",
    )
    if (groups.length === 0) continue
    const effectiveFrom = stringValue(values, "effectiveFrom")
    const effectiveTo = stringValue(values, "effectiveTo")
    if (groups.every((group) => group.implicit)) {
      const fractions = Array.from(new Set(groups.flatMap((group) => group.fractions)))
      if (fractions.length === 0) continue
      sources.push({ schemeName: record.name, areaId, serviceDays, fractions, effectiveFrom, effectiveTo })
      continue
    }
    for (const group of groups) {
      if (group.fractions.length === 0) continue
      sources.push({
        schemeName: record.name,
        groupName: group.name,
        areaId,
        serviceDays: sortServiceDays(group.days.filter((day) => serviceDays.includes(day))),
        fractions: [...new Set(group.fractions)],
        effectiveFrom,
        effectiveTo,
      })
    }
  }
  return sources
}
