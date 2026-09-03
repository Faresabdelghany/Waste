// Route Scheme guided-setup validation and per-day service plans. Pure data
// logic — no UI, store,
// or fixture dependencies — so the wizard's review step and the record
// creation path share one definition of "is this scheme Validated or Draft",
// and the generation engine can read a scheme's per-day plans back from its
// submittedValues.

import type { CollectionCalendar } from "./calendar"
import {
  RECURRENCE_FREQUENCY_LABELS,
  RECURRENCE_WEEKLY_RATES,
  SERVICE_DAYS,
  SERVICE_DAY_SHORT_LABELS,
  addDays,
  isIsoDate,
  serviceDayOf,
  serviceDaysFromValues,
  sortServiceDays,
  type RecurrenceFrequency,
  type ServiceDay,
} from "./recurrence"

/** Container selection carried by the wizard: one shared list, or one per day. */
export type SchemeDayPlans = {
  sameAllDays: boolean
  sharedContainerIds: string[]
  containersByDay: Partial<Record<ServiceDay, string[]>>
}

export type SchemeDayPlan = { day: ServiceDay; containerIds: string[] }

export const EMPTY_DAY_PLANS: SchemeDayPlans = {
  sameAllDays: true,
  sharedContainerIds: [],
  containersByDay: {},
}

const shortDays = (days: readonly ServiceDay[]): string =>
  sortServiceDays(days)
    .map((day) => SERVICE_DAY_SHORT_LABELS[day])
    .join(", ")

/** One generated route per service day: that day and its stop list (FR-14). */
export function effectiveDayPlans(
  serviceDays: readonly ServiceDay[],
  plans: SchemeDayPlans,
): SchemeDayPlan[] {
  return sortServiceDays(serviceDays).map((day) => ({
    day,
    containerIds: plans.sameAllDays
      ? plans.sharedContainerIds
      : (plans.containersByDay[day] ?? []),
  }))
}

/** "Wed 11 · Sun 11" — the review-step and record-fact counts line. */
export function dayPlanCountSummary(plans: readonly SchemeDayPlan[]): string {
  if (plans.length === 0) return "No service days"
  return plans
    .map((plan) => `${SERVICE_DAY_SHORT_LABELS[plan.day]} ${plan.containerIds.length}`)
    .join(" · ")
}

/**
 * One collection group as validation sees it (D33–D35): the group's days,
 * assignment, stop source, and — pre-resolved by the caller through
 * lib/route-schemes/groups resolveCollectionGroupPlans, so validation stays
 * pure data logic — the stops it actually serves per applicable day after the
 * manual-beats-rule / first-rule-group-wins tie-breaks.
 */
export type SchemeGroupValidationInput = {
  id: string
  name: string
  days: readonly ServiceDay[]
  vehicleId?: string
  driverId?: string
  /**
   * The group's vehicle's canonical type when resolvable
   * (matching vehicleTypeOfRecord); a rule requiring a different type warns.
   */
  vehicleType?: string | null
  stopSource: "rule" | "manual"
  fractions: readonly string[]
  ruleVehicleType?: string
  /** Per applicable day: stops after tie-breaks, and matches other groups claimed. */
  dayStops: ReadonlyArray<{ day: ServiceDay; count: number; claimedByOthers: number }>
}

/** A container hand-picked into two groups on one day — an explicit collision. */
export type SchemeManualDuplicate = {
  containerId: string
  containerName?: string
  day: ServiceDay
  groupIds: readonly [string, string]
}

/** Two rule groups matching the same containers on one day — the first wins. */
export type SchemeRuleOverlap = {
  day: ServiceDay
  winnerGroupId: string
  loserGroupId: string
  containerIds: readonly string[]
}

export type SchemeValidationInput = {
  serviceDays: ServiceDay[]
  effectiveFrom: string
  effectiveTo: string
  /** The scheme's planning area (configure.areas record id); rule groups match inside it. */
  areaId?: string
  /** The scheme's collection groups — implicit (legacy shape) or explicit. */
  groups: readonly SchemeGroupValidationInput[]
  /** From resolveCollectionGroupPlans: explicit same-day collisions (blocking). */
  manualDuplicates?: readonly SchemeManualDuplicate[]
  /** From resolveCollectionGroupPlans: rule-vs-rule overlaps (warning). */
  ruleOverlaps?: readonly SchemeRuleOverlap[]
  /** The scheme's Collection Calendar, when it carries structured data. */
  calendar?: CollectionCalendar | null
  /**
   * The scheme's own record id, when revalidating an existing scheme —
   * Vehicle Planning allocations targeting this scheme are then not conflicts.
   */
  schemeId?: string
  /**
   * Present when the caller can resolve the linked containers' promised
   * service frequencies (issue #21): the scheme's recurrence cadence plus one
   * pre-resolved promise per linked container that carries one — resolved by
   * the caller (lib/data/service-frequencies schemeFrequencyPromiseOfRecord;
   * validation stays pure data logic). Containers whose promise the scheme's
   * cadence under- or over-serves come back as non-blocking warnings — the
   * deferred "week-parity vs pickup settings" reconciliation class, which
   * like calendar warnings never demotes status.
   */
  frequencyReconciliation?: SchemeFrequencyReconciliationInput
}

/** One linked container's promised cadence, on the collections-per-week scale. */
export type SchemeFrequencyPromise = {
  containerName: string
  /** Catalog display name of the promised cadence ("Every week"). */
  promisedName: string
  /** Promised collections per week — the interval-model comparison value. */
  promisedRate: number
}

export type SchemeFrequencyReconciliationInput = {
  /** The scheme's recurrence cadence. */
  frequency: RecurrenceFrequency
  promises: SchemeFrequencyPromise[]
}

/**
 * What the rule-overlap warning needs to know about another rule-mode scheme:
 * same planning area + shared service day + intersecting fractions +
 * non-disjoint effective periods likely double-plan the same containers.
 * Extracted from records by matching.ts schemeStopRuleSources.
 */
export type SchemeStopRuleSource = {
  schemeName: string
  /** Set when the source is one explicit group of a multi-group scheme. */
  groupName?: string
  areaId: string
  serviceDays: readonly ServiceDay[]
  /** Union of the scheme's day-rule fractions. */
  fractions: readonly string[]
  effectiveFrom?: string
  effectiveTo?: string
}

/**
 * What FR-5(d) needs to know about an already-existing scheme's planned
 * assignment: one source per collection group (lib/route-schemes/groups
 * schemeAssignmentSources) — a legacy single-assignment scheme is one source.
 */
export type SchemeDefaultsSource = {
  schemeName: string
  /** Set when the source is one explicit group of a multi-group scheme. */
  groupName?: string
  serviceDays: readonly ServiceDay[]
  plannedVehicleId?: string
  plannedDriverId?: string
  /** Effective period; a missing side means it cannot rule out overlap. */
  effectiveFrom?: string
  effectiveTo?: string
}

/**
 * What the Vehicle Planning cross-check (issue #11) needs from a
 * `fleet.vehicle-planning` Allocation: the planned resources, the planned
 * window, and the lifecycle status that decides blocking vs warning.
 */
export type AllocationConflictSource = {
  allocationName: string
  status: string
  vehicleId?: string
  driverId?: string
  /** ISO datetimes (or dates) bounding the planned window. */
  plannedStart?: string
  plannedEnd?: string
  /** Set when the allocation targets a Route Scheme rather than a Route. */
  schemeId?: string
}

export type SchemeValidationResult = {
  status: "Validated" | "Draft"
  issues: string[]
  /**
   * Non-blocking caveats: calendar (Q6/Q7) and unconfirmed Vehicle Planning
   * allocations. Shown, but never demote status.
   */
  warnings: string[]
}

/**
 * The calendar caveats, save-time side: service
 * days the calendar treats as non-working (those dates are skipped at
 * generation), a calendar that is not Active, and a scheme effective period
 * that extends outside the calendar's validity. All non-blocking.
 */
export function schemeCalendarWarnings(input: {
  serviceDays: readonly ServiceDay[]
  effectiveFrom: string
  effectiveTo: string
  calendar?: CollectionCalendar | null
}): string[] {
  const { calendar } = input
  if (!calendar) return []
  const warnings: string[] = []

  if (calendar.workingDays.length > 0) {
    const nonWorking = input.serviceDays.filter(
      (day) => !calendar.workingDays.includes(day),
    )
    if (nonWorking.length > 0) {
      warnings.push(
        `${shortDays(nonWorking)} ${nonWorking.length === 1 ? "is not a working day" : "are not working days"} on ${calendar.name} — those dates are skipped at generation`,
      )
    }
  }

  if (calendar.status !== "Active") {
    warnings.push(
      `Calendar ${calendar.name} is ${calendar.status} — its working days and holidays may not be final`,
    )
  }

  const fromOutside =
    input.effectiveFrom && calendar.validFrom && input.effectiveFrom < calendar.validFrom
  const toOutside =
    calendar.validTo &&
    (input.effectiveTo
      ? input.effectiveTo > calendar.validTo
      : true)
  if (fromOutside || toOutside) {
    warnings.push(
      `Scheme effective period extends outside ${calendar.name} validity — uncovered dates generate without calendar rules`,
    )
  }

  return warnings
}

// Rates are quotients of small integers from one shared constant table, so
// genuine equality is exact; the epsilon only absorbs float noise.
const RATE_EPSILON = 1e-9

const namedContainers = (names: readonly string[]): string => {
  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const shown = sorted.slice(0, 3)
  const more = sorted.length - shown.length
  return more > 0 ? `${shown.join(", ")}, +${more} more` : shown.join(", ")
}

/**
 * The reconciliation caveats of issue #21, compared on the collections-per-week scale so every-N-weeks
 * promises order without a scheme-cadence counterpart. Under-service — the
 * scheme's cadence falls short of a linked container's promise — is the
 * promise-breaking direction and leads; over-service also warns (decided
 * here: it is visible scheme-vs-agreement drift and usually a configuration
 * or cost error, not a promise kept extra well), phrased as such. One warning
 * per promised cadence, containers named up to three. All non-blocking.
 */
export function schemeFrequencyReconciliationWarnings(
  reconciliation: SchemeFrequencyReconciliationInput,
): string[] {
  const schemeRate = RECURRENCE_WEEKLY_RATES[reconciliation.frequency]
  const schemeLabel = RECURRENCE_FREQUENCY_LABELS[reconciliation.frequency]
  const groups = new Map<string, { promisedRate: number; names: string[] }>()
  for (const promise of reconciliation.promises) {
    const group = groups.get(promise.promisedName)
    if (group) group.names.push(promise.containerName)
    else {
      groups.set(promise.promisedName, {
        promisedRate: promise.promisedRate,
        names: [promise.containerName],
      })
    }
  }
  // Under-served promises first (most frequent promise first), then
  // over-served — deterministic regardless of caller record order.
  const ordered = Array.from(groups.entries()).sort(
    (a, b) => b[1].promisedRate - a[1].promisedRate || a[0].localeCompare(b[0]),
  )
  const underServed: string[] = []
  const overServed: string[] = []
  for (const [promisedName, group] of ordered) {
    const count = group.names.length
    const containers = `${count} container${count === 1 ? "" : "s"} promised ${promisedName} (${namedContainers(group.names)})`
    if (schemeRate < group.promisedRate - RATE_EPSILON) {
      underServed.push(
        `Recurrence ${schemeLabel} under-serves ${containers} — raise the frequency or adjust the promised service frequency`,
      )
    } else if (schemeRate > group.promisedRate + RATE_EPSILON) {
      overServed.push(
        `Recurrence ${schemeLabel} over-serves ${containers} — collections run more often than the promised service frequency`,
      )
    }
  }
  return [...underServed, ...overServed]
}

const isoDatePart = (value: string | undefined): string | undefined => {
  if (!value) return undefined
  const date = value.slice(0, 10)
  return isIsoDate(date) ? date : undefined
}

/**
 * Provably disjoint effective periods cannot double-book a default (FR-5d).
 * Only parseable ISO dates prove disjointness — a malformed period falls back
 * to the conservative overlap the pre-refinement check assumed.
 */
const effectivePeriodsDisjoint = (
  input: Pick<SchemeValidationInput, "effectiveFrom" | "effectiveTo">,
  other: Pick<SchemeDefaultsSource, "effectiveFrom" | "effectiveTo">,
): boolean => {
  const inputFrom = isoDatePart(input.effectiveFrom)
  const inputTo = isoDatePart(input.effectiveTo)
  const otherFrom = isoDatePart(other.effectiveFrom)
  const otherTo = isoDatePart(other.effectiveTo)
  return Boolean(
    (otherFrom && inputTo && inputTo < otherFrom) ||
      (otherTo && inputFrom && inputFrom > otherTo),
  )
}

/**
 * Whether an allocation's planned window can touch the scheme: it overlaps
 * the effective period AND at least one overlapping date falls on a service
 * day. A window without parseable dates is treated as touching — a conflict
 * is only dismissed when it is provably impossible.
 */
function allocationWindowTouchesScheme(
  input: Pick<SchemeValidationInput, "serviceDays" | "effectiveFrom" | "effectiveTo">,
  allocation: AllocationConflictSource,
): boolean {
  const start = isoDatePart(allocation.plannedStart)
  const parsedEnd = isoDatePart(allocation.plannedEnd)
  if (!start || (parsedEnd && parsedEnd < start)) return true
  // A missing or unparseable end leaves the window open-ended: it runs at
  // least to the effective period's end, or forever when both are open.
  const end = parsedEnd ?? (isIsoDate(input.effectiveTo) ? input.effectiveTo : undefined)
  if (!end) return true
  const from =
    isIsoDate(input.effectiveFrom) && input.effectiveFrom > start
      ? input.effectiveFrom
      : start
  const to =
    isIsoDate(input.effectiveTo) && input.effectiveTo < end ? input.effectiveTo : end
  if (from > to) return false
  // Seven consecutive dates cover every weekday, so a bounded scan suffices.
  for (let date = from, i = 0; date <= to && i < 7; date = addDays(date, 1), i += 1) {
    if (input.serviceDays.includes(serviceDayOf(date))) return true
  }
  return false
}

const namesOf = (groups: ReadonlyArray<{ name: string }>): string =>
  groups.map((group) => group.name).join(", ")

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1)

/**
 * Groups sharing one planned assignment (vehicle + driver). A legacy scheme's
 * implicit per-day groups all share the scheme's single assignment, so the
 * resource checks speak of "the default vehicle" exactly as before; explicit
 * groups with their own assignments are named.
 */
type AssignmentCluster = {
  vehicleId?: string
  driverId?: string
  groups: SchemeGroupValidationInput[]
  days: ServiceDay[]
}

const assignmentClusters = (
  groups: readonly SchemeGroupValidationInput[],
): AssignmentCluster[] => {
  const clusters = new Map<string, AssignmentCluster>()
  for (const group of groups) {
    const key = `${group.vehicleId ?? ""}|${group.driverId ?? ""}`
    const cluster = clusters.get(key)
    if (cluster) {
      cluster.groups.push(group)
      cluster.days = sortServiceDays([...new Set([...cluster.days, ...group.days])])
    } else {
      clusters.set(key, {
        vehicleId: group.vehicleId,
        driverId: group.driverId,
        groups: [group],
        days: sortServiceDays([...group.days]),
      })
    }
  }
  return [...clusters.values()]
}

const ruleKey = (group: SchemeGroupValidationInput): string =>
  `${[...group.fractions].map((f) => f.toLowerCase()).sort().join(",")}|${group.ruleVehicleType ?? ""}`

/**
 * The blocking checks of FR-5, in spec order and extended for collection
 * groups (D33–D35): (a) ≥1 service day, (b) effective from set — effective to
 * is optional (issue #28, D23) but must be ≥ from when present, (c) every
 * service day is covered by ≥1 group and no group runs outside the service
 * days; every group has a vehicle and a default driver; every manual group
 * has ≥1 container on each of its days and every rule group (planning area
 * set, ≥1 fraction) currently serves ≥1 container on each of its days after
 * tie-breaks; no vehicle, driver, or hand-picked container is on two groups
 * the same day, (d) no group's vehicle or driver is already planned on another
 * scheme sharing a service day within an overlapping effective period, (e) no
 * group's vehicle or driver has a Confirmed Vehicle Planning allocation whose
 * planned window touches the group's days (issue #11). All pass → Validated;
 * any fail → Draft with the issues named. Calendar caveats, unconfirmed
 * allocation overlaps, a rule vehicle type the group's vehicle cannot serve,
 * rule overlaps inside the scheme (first group wins) and with other schemes,
 * and promised-service-frequency mismatches (issue #21) come back as
 * non-blocking warnings. A scheme with one planned assignment keeps the
 * single-assignment wording ("Default vehicle …"); several name the group.
 */
export function validateScheme(
  input: SchemeValidationInput,
  otherSchemes: readonly SchemeDefaultsSource[] = [],
  allocations: readonly AllocationConflictSource[] = [],
  otherRuleSchemes: readonly SchemeStopRuleSource[] = [],
): SchemeValidationResult {
  const issues: string[] = []
  const matchingWarnings: string[] = []
  const groups = input.groups
  const single = groups.length === 1
  const nameById = new Map(groups.map((group) => [group.id, group.name]))
  const labelOf = (id: string) => nameById.get(id) ?? id

  if (input.serviceDays.length === 0) issues.push("Pick at least one service day")

  // effectiveTo is optional (issue #28, D23): an omitted To means the scheme
  // runs open-ended until explicitly ended or expired by later configuration.
  if (!input.effectiveFrom) {
    issues.push("Set the effective from date")
  } else if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    issues.push("Effective to must be on or after effective from")
  }

  /* ---- coverage (D33): every service day has ≥1 group, none run elsewhere ---- */

  if (groups.length === 0) {
    issues.push("Add a collection group")
  } else if (input.serviceDays.length > 0) {
    const uncovered = sortServiceDays(input.serviceDays).filter(
      (day) => !groups.some((group) => group.days.includes(day)),
    )
    if (uncovered.length > 0) {
      issues.push(`No collection group covers ${shortDays(uncovered)}`)
    }
    for (const group of groups) {
      const stray = group.days.filter((day) => !input.serviceDays.includes(day))
      if (stray.length > 0) {
        issues.push(
          `${group.name} runs on ${shortDays(stray)}, which ${stray.length === 1 ? "is not a service day" : "are not service days"}`,
        )
      }
    }
  }

  /* ---- assignment (D34): vehicle required, default driver required for Validated ---- */

  const withoutVehicle = groups.filter((group) => !group.vehicleId)
  if (withoutVehicle.length > 0) {
    issues.push(
      withoutVehicle.length === groups.length
        ? "Pick a vehicle"
        : `Pick a vehicle for ${namesOf(withoutVehicle)}`,
    )
  }
  const withoutDriver = groups.filter((group) => !group.driverId)
  if (withoutDriver.length > 0) {
    issues.push(
      withoutDriver.length === groups.length
        ? "Pick a driver"
        : `Pick a driver for ${namesOf(withoutDriver)}`,
    )
  }

  /* ---- stops (FR-5c, FR-16–18 at group level) ---- */

  const manualGroups = groups.filter((group) => group.stopSource === "manual")
  const ruleGroups = groups.filter((group) => group.stopSource === "rule")

  const emptyManual = manualGroups.filter((group) =>
    group.dayStops.some((stop) => stop.count === 0),
  )
  if (emptyManual.length > 0) {
    issues.push(
      single ? "Pick at least one container" : `Pick containers for ${namesOf(emptyManual)}`,
    )
  }

  if (ruleGroups.length > 0) {
    if (!input.areaId) {
      issues.push("Pick a planning area — the stop rule matches containers inside it")
    }
    const ruleless = ruleGroups.filter((group) => group.fractions.length === 0)
    if (ruleless.length > 0) {
      issues.push(
        single
          ? "Pick at least one waste fraction for the stop rule"
          : `Pick waste fractions for ${namesOf(ruleless)}`,
      )
    }
    // Zero matches only block once the rule is actually evaluable — the
    // missing-area and missing-fraction issues already name the real gap.
    if (input.areaId) {
      const evaluable = ruleGroups.filter((group) => group.fractions.length > 0)
      const unmatched = evaluable.filter((group) =>
        group.dayStops.some((stop) => stop.count === 0 && stop.claimedByOthers === 0),
      )
      if (unmatched.length > 0) {
        issues.push(
          single
            ? "No containers currently match the stop rule"
            : `No containers match the stop rule for ${namesOf(unmatched)}`,
        )
      }
      // A rule group whose every match another group already collects is a
      // rule-vs-rule overlap taken to its end — a warning like any overlap
      // (D35), never a hard error.
      const starved = evaluable.filter(
        (group) =>
          !unmatched.includes(group) &&
          group.dayStops.some((stop) => stop.count === 0 && stop.claimedByOthers > 0),
      )
      if (starved.length > 0) {
        matchingWarnings.push(
          `Nothing left for ${namesOf(starved)} to collect — every container it matches is collected by another group on the same day`,
        )
      }
    }
  }

  /* ---- same-day collisions inside the scheme (D33) ---- */

  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      const a = groups[i]
      const b = groups[j]
      const shared = sortServiceDays(a.days.filter((day) => b.days.includes(day)))
      if (shared.length === 0) continue
      if (a.vehicleId && a.vehicleId === b.vehicleId) {
        issues.push(`Vehicle is planned on both ${a.name} and ${b.name} on ${shortDays(shared)}`)
      }
      if (a.driverId && a.driverId === b.driverId) {
        issues.push(`Driver is planned on both ${a.name} and ${b.name} on ${shortDays(shared)}`)
      }
    }
  }

  const duplicateDays = new Map<string, { label: string; a: string; b: string; days: ServiceDay[] }>()
  for (const duplicate of input.manualDuplicates ?? []) {
    const key = `${duplicate.containerId}|${duplicate.groupIds[0]}|${duplicate.groupIds[1]}`
    const entry = duplicateDays.get(key)
    if (entry) {
      entry.days = sortServiceDays([...new Set([...entry.days, duplicate.day])])
    } else {
      duplicateDays.set(key, {
        label: duplicate.containerName ?? duplicate.containerId,
        a: labelOf(duplicate.groupIds[0]),
        b: labelOf(duplicate.groupIds[1]),
        days: [duplicate.day],
      })
    }
  }
  for (const entry of duplicateDays.values()) {
    issues.push(
      `${entry.label} is picked in both ${entry.a} and ${entry.b} on ${shortDays(entry.days)}`,
    )
  }

  /* ---- vehicle-type fit (FR-18 warning) ---- */

  const clusters = assignmentClusters(groups)
  const oneAssignment = clusters.length <= 1
  const mismatched = ruleGroups.filter(
    (group) =>
      group.vehicleType &&
      group.ruleVehicleType &&
      group.ruleVehicleType !== group.vehicleType,
  )
  if (oneAssignment) {
    const seen = new Set<string>()
    for (const group of mismatched) {
      const key = `${group.vehicleType}|${group.ruleVehicleType}`
      if (seen.has(key)) continue
      seen.add(key)
      matchingWarnings.push(
        `Default vehicle is a ${group.vehicleType!.toLowerCase()} but the stop rule requires a ${group.ruleVehicleType!.toLowerCase()}`,
      )
    }
  } else {
    for (const group of mismatched) {
      matchingWarnings.push(
        `Vehicle of ${group.name} is a ${group.vehicleType!.toLowerCase()} but its stop rule requires a ${group.ruleVehicleType!.toLowerCase()}`,
      )
    }
  }

  /* ---- rule overlaps inside the scheme (D35 warning: first group wins) ---- */

  const overlapPairs = new Map<string, { winner: string; loser: string; days: ServiceDay[]; containers: Set<string> }>()
  for (const overlap of input.ruleOverlaps ?? []) {
    const key = `${overlap.winnerGroupId}|${overlap.loserGroupId}`
    const entry = overlapPairs.get(key)
    if (entry) {
      entry.days = sortServiceDays([...new Set([...entry.days, overlap.day])])
      for (const id of overlap.containerIds) entry.containers.add(id)
    } else {
      overlapPairs.set(key, {
        winner: labelOf(overlap.winnerGroupId),
        loser: labelOf(overlap.loserGroupId),
        days: [overlap.day],
        containers: new Set(overlap.containerIds),
      })
    }
  }
  for (const entry of overlapPairs.values()) {
    const count = entry.containers.size
    matchingWarnings.push(
      `${entry.loser} and ${entry.winner} both match ${count} container${count === 1 ? "" : "s"} on ${shortDays(entry.days)} — ${entry.winner} collects them (first group wins)`,
    )
  }

  /* ---- rule overlaps with other schemes (FR-18 warning) ---- */

  if (input.areaId && ruleGroups.length > 0) {
    // Groups sharing one rule speak with one voice (a legacy per-day scheme
    // with the same rule every day is one rule); differing rules are named.
    const ruleClusters = new Map<string, { groups: SchemeGroupValidationInput[]; days: ServiceDay[]; fractions: string[] }>()
    for (const group of ruleGroups) {
      if (group.fractions.length === 0) continue
      const key = ruleKey(group)
      const cluster = ruleClusters.get(key)
      if (cluster) {
        cluster.groups.push(group)
        cluster.days = sortServiceDays([...new Set([...cluster.days, ...group.days])])
      } else {
        ruleClusters.set(key, {
          groups: [group],
          days: sortServiceDays([...group.days]),
          fractions: [...new Set(group.fractions)],
        })
      }
    }
    const oneRule = ruleClusters.size <= 1
    for (const cluster of ruleClusters.values()) {
      for (const other of otherRuleSchemes) {
        if (other.areaId !== input.areaId) continue
        if (effectivePeriodsDisjoint(input, other)) continue
        const sharedDays = cluster.days.filter((day) => other.serviceDays.includes(day))
        if (sharedDays.length === 0) continue
        const sharedFractions = cluster.fractions.filter((fraction) =>
          other.fractions.some(
            (candidate) => candidate.toLowerCase() === fraction.toLowerCase(),
          ),
        )
        if (sharedFractions.length === 0) continue
        const otherLabel = other.groupName
          ? `${other.schemeName} · ${other.groupName}`
          : other.schemeName
        matchingWarnings.push(
          `${oneRule ? "Stop rule" : `Stop rule of ${namesOf(cluster.groups)}`} overlaps "${otherLabel}" — ${sharedFractions.join(", ")} containers in the same planning area are already matched on ${shortDays(sharedDays)}`,
        )
      }
    }
  }

  /* ---- FR-5(d): planned on another scheme ---- */

  for (const cluster of clusters) {
    const subject = (resource: "vehicle" | "driver") =>
      oneAssignment
        ? `Default ${resource} is already the default on`
        : `${capitalize(resource)} of ${namesOf(cluster.groups)} is already planned on`
    for (const other of otherSchemes) {
      if (effectivePeriodsDisjoint(input, other)) continue
      const sharedDays = cluster.days.filter((day) => other.serviceDays.includes(day))
      if (sharedDays.length === 0) continue
      const otherLabel = other.groupName
        ? `${other.schemeName} · ${other.groupName}`
        : other.schemeName
      const sharing = `(shares ${shortDays(sharedDays)})`
      if (cluster.vehicleId && cluster.vehicleId === other.plannedVehicleId) {
        issues.push(`${subject("vehicle")} "${otherLabel}" ${sharing}`)
      }
      if (cluster.driverId && cluster.driverId === other.plannedDriverId) {
        issues.push(`${subject("driver")} "${otherLabel}" ${sharing}`)
      }
    }
  }

  /* ---- FR-5(e): Vehicle Planning allocations ---- */

  const allocationWarnings: string[] = []
  for (const cluster of clusters) {
    const window = {
      serviceDays: cluster.days,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    }
    const subject = (resource: "vehicle" | "driver") =>
      oneAssignment
        ? `Default ${resource}`
        : `${capitalize(resource)} of ${namesOf(cluster.groups)}`
    for (const allocation of allocations) {
      // Released allocations returned their capacity; a scheme-scoped
      // allocation is this scheme's own planned capacity, not a competitor.
      if (allocation.status === "Released") continue
      if (input.schemeId && allocation.schemeId === input.schemeId) continue
      const resources: Array<"vehicle" | "driver"> = []
      if (cluster.vehicleId && cluster.vehicleId === allocation.vehicleId) {
        resources.push("vehicle")
      }
      if (cluster.driverId && cluster.driverId === allocation.driverId) {
        resources.push("driver")
      }
      if (resources.length === 0) continue
      if (!allocationWindowTouchesScheme(window, allocation)) continue
      // Form-created allocations share one machine name, so the planned window
      // is what identifies which allocation the message means.
      const start = isoDatePart(allocation.plannedStart)
      const end = isoDatePart(allocation.plannedEnd)
      const span = start ? (end && end !== start ? `${start} → ${end}` : start) : ""
      for (const resource of resources) {
        if (allocation.status === "Confirmed") {
          issues.push(
            `${subject(resource)} conflicts with confirmed Vehicle Planning allocation "${allocation.allocationName}"${span ? ` (${span})` : ""}`,
          )
        } else {
          allocationWarnings.push(
            `${subject(resource)} is planned on Vehicle Planning allocation "${allocation.allocationName}" (${allocation.status}${span ? ` · ${span}` : ""}) — confirm or release it in Fleet`,
          )
        }
      }
    }
  }

  return {
    status: issues.length === 0 ? "Validated" : "Draft",
    issues,
    warnings: [
      ...schemeCalendarWarnings(input),
      ...allocationWarnings,
      ...matchingWarnings,
      ...(input.frequencyReconciliation
        ? schemeFrequencyReconciliationWarnings(input.frequencyReconciliation)
        : []),
    ],
  }
}

type StoredValues = Record<string, string | boolean | undefined>

export const stringValue = (values: StoredValues, key: string): string | undefined => {
  const value = values[key]
  return typeof value === "string" && value ? value : undefined
}

/**
 * Reads what the Vehicle Planning cross-check needs from an Allocation
 * record's submittedValues (the `fleet.vehicle-planning` field ids). Returns
 * null for allocations that cannot conflict: no typed vehicle or driver
 * reference (legacy display-text-only records).
 */
export function allocationConflictSourceFromValues(
  allocationName: string,
  status: string,
  values: StoredValues | undefined,
): AllocationConflictSource | null {
  if (!values) return null
  const vehicleId = stringValue(values, "vehicleId")
  const driverId = stringValue(values, "driverId")
  if (!vehicleId && !driverId) return null
  return {
    allocationName,
    status,
    vehicleId,
    driverId,
    plannedStart: stringValue(values, "plannedStart"),
    plannedEnd: stringValue(values, "plannedEnd"),
    schemeId: stringValue(values, "schemeId"),
  }
}

/** The minimal record shape the allocation supersession pass reads. */
export type AllocationRecordLike = {
  id: string
  name: string
  status: string
  submittedValues?: StoredValues
}

/**
 * Resolves the conflict sources from a `fleet.vehicle-planning` record set.
 * The module's "Plan allocation" form is append-event: a confirm, release, or
 * change submission creates a NEW record pointing at the original via
 * `existingAllocationId` instead of mutating it. This pass folds those events
 * back onto their targets — release and change retire the original (a change
 * event carries its own typed refs and stands as the active allocation),
 * confirm promotes it to Confirmed — with later events overriding earlier
 * ones (store order is creation order). Records without typed vehicle/driver
 * refs (including release/confirm event records) never conflict themselves.
 */
export function allocationConflictSources(
  records: readonly AllocationRecordLike[],
): AllocationConflictSource[] {
  const statusOverrides = new Map<string, string>()
  for (const record of records) {
    const values = record.submittedValues
    if (!values) continue
    const action = stringValue(values, "allocationAction")
    const targetId = stringValue(values, "existingAllocationId")
    if (!action || !targetId) continue
    if (action === "release" || action === "change") {
      statusOverrides.set(targetId, "Released")
    } else if (action === "confirm") {
      statusOverrides.set(targetId, "Confirmed")
    }
  }
  return records
    .map((record) =>
      allocationConflictSourceFromValues(
        record.name,
        statusOverrides.get(record.id) ?? record.status,
        record.submittedValues,
      ),
    )
    .filter((source): source is AllocationConflictSource => source !== null)
}

/**
 * The submittedValues shape carrying a scheme's container plans: the shared
 * list under `containerIds` (comma-separated, matching the guided-route
 * convention) and the per-day lists under `containersByDay` as JSON.
 */
export function dayPlansToValues(plans: SchemeDayPlans): {
  sameAllDays: boolean
  containerIds: string
  containersByDay: string
} {
  return {
    sameAllDays: plans.sameAllDays,
    containerIds: plans.sharedContainerIds.join(","),
    containersByDay: JSON.stringify(plans.containersByDay),
  }
}

const isServiceDay = (value: string): value is ServiceDay =>
  (SERVICE_DAYS as readonly string[]).includes(value)

export function dayPlansFromValues(values: StoredValues | undefined): SchemeDayPlans {
  if (!values) return EMPTY_DAY_PLANS
  const sharedContainerIds =
    typeof values.containerIds === "string" && values.containerIds
      ? values.containerIds.split(",").filter(Boolean)
      : []
  const containersByDay: Partial<Record<ServiceDay, string[]>> = {}
  if (typeof values.containersByDay === "string" && values.containersByDay) {
    try {
      const parsed: unknown = JSON.parse(values.containersByDay)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [day, ids] of Object.entries(parsed)) {
          if (!isServiceDay(day) || !Array.isArray(ids)) continue
          containersByDay[day] = ids.filter(
            (id): id is string => typeof id === "string" && Boolean(id),
          )
        }
      }
    } catch {
      // Hand-edited or corrupted storage: fall back to no per-day plans.
    }
  }
  return {
    sameAllDays: values.sameAllDays !== false,
    sharedContainerIds,
    containersByDay,
  }
}
