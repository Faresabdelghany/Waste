// Route Scheme guided-setup validation and per-day service plans (spec
// docs/specs/ROUTE_SCHEMES.md, FR-5/FR-14). Pure data logic — no UI, store,
// or fixture dependencies — so the wizard's review step and the record
// creation path share one definition of "is this scheme Validated or Draft",
// and the generation engine can read a scheme's per-day plans back from its
// submittedValues.

import type { CollectionCalendar } from "./calendar"
import {
  SERVICE_DAYS,
  SERVICE_DAY_SHORT_LABELS,
  addDays,
  isIsoDate,
  serviceDayOf,
  serviceDaysFromValues,
  sortServiceDays,
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

export type SchemeValidationInput = {
  serviceDays: ServiceDay[]
  effectiveFrom: string
  effectiveTo: string
  plans: SchemeDayPlans
  plannedVehicleId?: string
  plannedDriverId?: string
  /** The scheme's Collection Calendar, when it carries structured data. */
  calendar?: CollectionCalendar | null
  /**
   * The scheme's own record id, when revalidating an existing scheme —
   * Vehicle Planning allocations targeting this scheme are then not conflicts.
   */
  schemeId?: string
  /**
   * Present when the scheme selects stops declaratively (issue #19): the
   * per-day rules with their currently matched container counts, pre-resolved
   * by the caller (lib/route-schemes/matching resolveStopMatches — validation
   * stays pure data logic). When set, the FR-5(c) picked-container check is
   * replaced by the rule checks: a planning area must be set, every day's
   * rule needs at least one fraction, and a rule matching zero containers
   * blocks — a zero-match configuration must never save as quiet success.
   */
  stopMatching?: SchemeStopMatchingInput
}

export type SchemeStopMatchingInput = {
  /** The scheme's planning area (plan.areas record id); rules match inside it. */
  areaId?: string
  sameAllDays: boolean
  dayRules: Array<{
    day: ServiceDay
    fractions: readonly string[]
    vehicleType?: string
    /** Containers the day's rule currently matches (resolved by the caller). */
    matchedCount: number
  }>
  /**
   * The default vehicle's canonical type when resolvable
   * (matching vehicleTypeOfRecord); a rule requiring a different type warns.
   */
  plannedVehicleType?: string | null
}

/**
 * What the rule-overlap warning needs to know about another rule-mode scheme:
 * same planning area + shared service day + intersecting fractions +
 * non-disjoint effective periods likely double-plan the same containers.
 * Extracted from records by matching.ts schemeStopRuleSources.
 */
export type SchemeStopRuleSource = {
  schemeName: string
  areaId: string
  serviceDays: readonly ServiceDay[]
  /** Union of the scheme's day-rule fractions. */
  fractions: readonly string[]
  effectiveFrom?: string
  effectiveTo?: string
}

/** What FR-5(d) needs to know about an already-existing scheme. */
export type SchemeDefaultsSource = {
  schemeName: string
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
 * The calendar caveats of PLAN_SIMPLIFICATION Q6/Q7, save-time side: service
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
  input: SchemeValidationInput,
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

/**
 * The blocking checks of FR-5, in spec order: (a) ≥1 service day,
 * (b) effective from/to set with to ≥ from, (c) every service day has ≥1
 * container (per-day mode names the empty days) — replaced for rule-mode
 * schemes (issue #19, input.stopMatching) by: planning area set, every day's
 * rule carries ≥1 fraction, and every day's rule currently matches ≥1
 * container, (d) the default vehicle or driver is not already the default on
 * another scheme sharing a service day within an overlapping effective
 * period, (e) the default vehicle or driver has no Confirmed Vehicle
 * Planning allocation whose planned window touches the scheme (issue #11).
 * All pass → Validated; any fail → Draft with the issues named. Calendar
 * caveats, unconfirmed (Draft/Allocated) allocation overlaps, a rule vehicle
 * type the default vehicle cannot serve, and rule overlaps with other
 * rule-mode schemes come back as non-blocking warnings.
 */
export function validateScheme(
  input: SchemeValidationInput,
  otherSchemes: readonly SchemeDefaultsSource[] = [],
  allocations: readonly AllocationConflictSource[] = [],
  otherRuleSchemes: readonly SchemeStopRuleSource[] = [],
): SchemeValidationResult {
  const issues: string[] = []
  const matchingWarnings: string[] = []
  const matching = input.stopMatching

  if (input.serviceDays.length === 0) issues.push("Pick at least one service day")

  if (!input.effectiveFrom || !input.effectiveTo) {
    issues.push("Set the effective from and to dates")
  } else if (input.effectiveTo < input.effectiveFrom) {
    issues.push("Effective to must be on or after effective from")
  }

  if (input.serviceDays.length > 0 && !matching) {
    const emptyDays = effectiveDayPlans(input.serviceDays, input.plans)
      .filter((plan) => plan.containerIds.length === 0)
      .map((plan) => plan.day)
    if (emptyDays.length > 0) {
      issues.push(
        input.plans.sameAllDays
          ? "Pick at least one container"
          : `Pick containers for ${shortDays(emptyDays)}`,
      )
    }
  }

  if (matching) {
    if (!matching.areaId) {
      issues.push("Pick a planning area — the stop rule matches containers inside it")
    }
    const ruleless = matching.dayRules
      .filter((dayRule) => dayRule.fractions.length === 0)
      .map((dayRule) => dayRule.day)
    if (ruleless.length > 0) {
      issues.push(
        matching.sameAllDays
          ? "Pick at least one waste fraction for the stop rule"
          : `Pick waste fractions for ${shortDays(ruleless)}`,
      )
    }
    // Zero matches only blocks once the rule is actually evaluable — the
    // missing-area and missing-fraction issues already name the real gap.
    if (matching.areaId) {
      const unmatched = matching.dayRules
        .filter(
          (dayRule) => dayRule.fractions.length > 0 && dayRule.matchedCount === 0,
        )
        .map((dayRule) => dayRule.day)
      if (unmatched.length > 0) {
        issues.push(
          matching.sameAllDays
            ? "No containers currently match the stop rule"
            : `No containers match the stop rule for ${shortDays(unmatched)}`,
        )
      }
    }
    if (matching.plannedVehicleType) {
      const mismatched = Array.from(
        new Set(
          matching.dayRules
            .map((dayRule) => dayRule.vehicleType)
            .filter(
              (type): type is string =>
                Boolean(type) && type !== matching.plannedVehicleType,
            ),
        ),
      )
      for (const type of mismatched) {
        matchingWarnings.push(
          `Default vehicle is a ${matching.plannedVehicleType.toLowerCase()} but the stop rule requires a ${type.toLowerCase()}`,
        )
      }
    }
    if (matching.areaId) {
      const ownFractions = Array.from(
        new Set(matching.dayRules.flatMap((dayRule) => dayRule.fractions)),
      )
      for (const other of otherRuleSchemes) {
        if (other.areaId !== matching.areaId) continue
        if (effectivePeriodsDisjoint(input, other)) continue
        const sharedDays = input.serviceDays.filter((day) =>
          other.serviceDays.includes(day),
        )
        if (sharedDays.length === 0) continue
        const sharedFractions = ownFractions.filter((fraction) =>
          other.fractions.some(
            (candidate) => candidate.toLowerCase() === fraction.toLowerCase(),
          ),
        )
        if (sharedFractions.length === 0) continue
        matchingWarnings.push(
          `Stop rule overlaps "${other.schemeName}" — ${sharedFractions.join(", ")} containers in the same planning area are already matched on ${shortDays(sharedDays)}`,
        )
      }
    }
  }

  for (const other of otherSchemes) {
    if (effectivePeriodsDisjoint(input, other)) continue
    const sharedDays = input.serviceDays.filter((day) => other.serviceDays.includes(day))
    if (sharedDays.length === 0) continue
    const sharing = `(shares ${shortDays(sharedDays)})`
    if (input.plannedVehicleId && input.plannedVehicleId === other.plannedVehicleId) {
      issues.push(
        `Default vehicle is already the default on "${other.schemeName}" ${sharing}`,
      )
    }
    if (input.plannedDriverId && input.plannedDriverId === other.plannedDriverId) {
      issues.push(
        `Default driver is already the default on "${other.schemeName}" ${sharing}`,
      )
    }
  }

  const allocationWarnings: string[] = []
  for (const allocation of allocations) {
    // Released allocations returned their capacity; a scheme-scoped
    // allocation is this scheme's own planned capacity, not a competitor.
    if (allocation.status === "Released") continue
    if (input.schemeId && allocation.schemeId === input.schemeId) continue
    const resources: string[] = []
    if (input.plannedVehicleId && input.plannedVehicleId === allocation.vehicleId) {
      resources.push("vehicle")
    }
    if (input.plannedDriverId && input.plannedDriverId === allocation.driverId) {
      resources.push("driver")
    }
    if (resources.length === 0) continue
    if (!allocationWindowTouchesScheme(input, allocation)) continue
    // Form-created allocations share one machine name, so the planned window
    // is what identifies which allocation the message means.
    const start = isoDatePart(allocation.plannedStart)
    const end = isoDatePart(allocation.plannedEnd)
    const window = start ? (end && end !== start ? `${start} → ${end}` : start) : ""
    for (const resource of resources) {
      if (allocation.status === "Confirmed") {
        issues.push(
          `Default ${resource} conflicts with confirmed Vehicle Planning allocation "${allocation.allocationName}"${window ? ` (${window})` : ""}`,
        )
      } else {
        allocationWarnings.push(
          `Default ${resource} is planned on Vehicle Planning allocation "${allocation.allocationName}" (${allocation.status}${window ? ` · ${window}` : ""}) — confirm or release it in Fleet`,
        )
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
    ],
  }
}

type StoredValues = Record<string, string | boolean | undefined>

export const stringValue = (values: StoredValues, key: string): string | undefined => {
  const value = values[key]
  return typeof value === "string" && value ? value : undefined
}

/**
 * Reads what FR-5(d) needs from an existing scheme record's submittedValues
 * (the `route-studio.schemes` field ids, shared by quick create and the
 * wizard). Returns null for schemes that cannot conflict: no structured
 * service days (legacy free-text records) or no default assignment at all.
 */
export function schemeDefaultsFromValues(
  schemeName: string,
  values: StoredValues | undefined,
): SchemeDefaultsSource | null {
  if (!values) return null
  const serviceDays = serviceDaysFromValues(values)
  if (serviceDays.length === 0) return null
  const plannedVehicleId = stringValue(values, "plannedVehicleId")
  const plannedDriverId = stringValue(values, "plannedDriverId")
  if (!plannedVehicleId && !plannedDriverId) return null
  return {
    schemeName,
    serviceDays,
    plannedVehicleId,
    plannedDriverId,
    effectiveFrom: stringValue(values, "effectiveFrom"),
    effectiveTo: stringValue(values, "effectiveTo"),
  }
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
