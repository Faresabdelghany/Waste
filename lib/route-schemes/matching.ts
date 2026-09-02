// Declarative stop matching for Route Schemes (issue #19, convergence doc
// docs/specs/REAL_PRODUCT_CONVERGENCE.md option C step 3): a scheme in "rule"
// stop-selection mode stores the selection rule — waste fractions + optional
// vehicle type, scoped to the scheme's planning area and project — instead of
// a hand-picked container list. Generation, validation, the wizard preview,
// and the scheme detail all resolve the rule against live container records
// through this module, so a container added to the area later is picked up by
// the next generation without editing the scheme.
//
// Pure data logic — no UI, store, or fixture dependencies (type-only import
// of BusinessRecord), mirroring validation.ts, so the resolver is
// harness-testable (scripts/route-scheme-matching-harness.ts).

import type { BusinessRecord } from "../data/business-modules"
import {
  SERVICE_DAYS,
  serviceDaysFromValues,
  sortServiceDays,
  type ServiceDay,
} from "./recurrence"
import {
  dayPlansFromValues,
  effectiveDayPlans,
  stringValue,
  type SchemeDayPlan,
  type SchemeStopRuleSource,
} from "./validation"

/* ------------------------------ vocabulary -------------------------------- */

/**
 * The canonical vehicle types, taken from the fleet fixtures' "Type · depot"
 * context strings ("Rear loader 18 t · Nordhavn", "Glass crane 16 t · Amager",
 * "Organic sealed 12 t · Østerbro", "Paper compactor 14 t · Østerbro") plus
 * the vacuum tanker wastewater tanks require. There is no vehicle-type master
 * data entity in the prototype; this list is the working taxonomy.
 */
export const STOP_MATCH_VEHICLE_TYPES = [
  "Rear loader",
  "Organic sealed",
  "Paper compactor",
  "Glass crane",
  "Vacuum tanker",
] as const

/**
 * Which vehicle types can service each container type (the container side of
 * the real product's "fraction + vehicle type" stop matching). Lift-lifted
 * bins take any compactor-style body; igloo and underground containers are
 * crane-emptied; wastewater tanks need suction. A container type absent from
 * this map has no compatibility profile — it is excluded (with a visible
 * reason) whenever the rule constrains the vehicle type, never silently
 * included.
 */
export const CONTAINER_VEHICLE_COMPATIBILITY: Readonly<
  Record<string, readonly string[]>
> = {
  "Two-wheel bin · 140 L": ["Rear loader", "Organic sealed", "Paper compactor"],
  "Two-wheel bin · 240 L": ["Rear loader", "Organic sealed", "Paper compactor"],
  "Four-wheel bin · 660 L": ["Rear loader", "Organic sealed", "Paper compactor"],
  "Four-wheel bin · 1,100 L": ["Rear loader", "Organic sealed", "Paper compactor"],
  "Igloo · 2,500 L": ["Glass crane"],
  "Underground · 5,000 L": ["Glass crane"],
  "Wastewater tank · 3,000 L": ["Vacuum tanker"],
}

/**
 * Only containers in service can be planned into routes — the prototype
 * analog of the real product's Active-agreement gate (REAL_PRODUCT_CONVERGENCE
 * concept-mapping table). Future, On hold, Defect, In storage, In transit,
 * and Ended containers are excluded with a visible reason.
 */
export const ELIGIBLE_CONTAINER_STATUSES = new Set(["Available"])

/** The container form's enum ids mapped onto the fixture display vocabulary. */
const FORM_FRACTION_LABELS: Readonly<Record<string, string>> = {
  residual: "Residual",
  organic: "Organic",
  cardboard: "Cardboard",
  glass: "Glass",
  mixed: "Mixed",
  wastewater: "Wastewater",
}

const FORM_CONTAINER_TYPE_LABELS: Readonly<Record<string, string>> = {
  "two-wheel-240": "Two-wheel bin · 240 L",
  "four-wheel-660": "Four-wheel bin · 660 L",
  "four-wheel-1100": "Four-wheel bin · 1,100 L",
  "wastewater-3000": "Wastewater tank · 3,000 L",
}

/* ------------------------------ rule model -------------------------------- */

/** The selection rule one service day resolves stops with. */
export type StopMatchRule = {
  /** Waste fractions to match (display vocabulary, e.g. "Residual"). */
  fractions: string[]
  /** Restrict to containers this vehicle type can service; absent = any. */
  vehicleType?: string
}

export type StopSelectionMode = "manual" | "rule"

export const EMPTY_STOP_MATCH_RULE: StopMatchRule = { fractions: [] }

/** Rule-vs-manual stop selection; absent or unknown values stay manual (legacy). */
export function stopSelectionMode(
  values: Record<string, string | boolean | undefined> | undefined,
): StopSelectionMode {
  return values?.stopSelection === "rule" ? "rule" : "manual"
}

/** Rule plans carried by the wizard: one shared rule, or one per day (FR-14). */
export type SchemeMatchPlans = {
  sameAllDays: boolean
  sharedRule: StopMatchRule
  rulesByDay: Partial<Record<ServiceDay, StopMatchRule>>
}

export const EMPTY_MATCH_PLANS: SchemeMatchPlans = {
  sameAllDays: true,
  sharedRule: EMPTY_STOP_MATCH_RULE,
  rulesByDay: {},
}

/** Comma-separated stored list → trimmed non-empty items (e.g. containerIds). */
export const splitList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

/**
 * The submittedValues shape carrying a scheme's stop-matching rules: the
 * shared rule under `matchFractions` (comma-separated display names, matching
 * the multiselect convention) + `matchVehicleType`, and the per-day rules
 * under `matchRulesByDay` as JSON — mirroring dayPlansToValues so manual and
 * rule mode serialize side by side under the `stopSelection` mode flag.
 */
export function matchPlansToValues(plans: SchemeMatchPlans): {
  matchFractions: string
  matchVehicleType: string
  matchRulesByDay: string
} {
  return {
    matchFractions: plans.sharedRule.fractions.join(", "),
    matchVehicleType: plans.sharedRule.vehicleType ?? "",
    matchRulesByDay: JSON.stringify(plans.rulesByDay),
  }
}

const isServiceDay = (value: string): value is ServiceDay =>
  (SERVICE_DAYS as readonly string[]).includes(value)

const parseRule = (candidate: unknown): StopMatchRule | null => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null
  }
  const raw = candidate as { fractions?: unknown; vehicleType?: unknown }
  const fractions = Array.isArray(raw.fractions)
    ? raw.fractions.filter(
        (item): item is string => typeof item === "string" && Boolean(item.trim()),
      )
    : []
  const vehicleType =
    typeof raw.vehicleType === "string" && raw.vehicleType.trim()
      ? raw.vehicleType.trim()
      : undefined
  return { fractions, ...(vehicleType ? { vehicleType } : {}) }
}

export function matchPlansFromValues(
  values: Record<string, string | boolean | undefined> | undefined,
): SchemeMatchPlans {
  if (!values) return EMPTY_MATCH_PLANS
  const sharedRule: StopMatchRule = {
    fractions: splitList(stringValue(values, "matchFractions")),
    ...(stringValue(values, "matchVehicleType")
      ? { vehicleType: stringValue(values, "matchVehicleType") }
      : {}),
  }
  const rulesByDay: Partial<Record<ServiceDay, StopMatchRule>> = {}
  const rawByDay = stringValue(values, "matchRulesByDay")
  if (rawByDay) {
    try {
      const parsed: unknown = JSON.parse(rawByDay)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [day, candidate] of Object.entries(parsed)) {
          if (!isServiceDay(day)) continue
          const rule = parseRule(candidate)
          if (rule) rulesByDay[day] = rule
        }
      }
    } catch {
      // Hand-edited or corrupted storage: fall back to no per-day rules.
    }
  }
  return {
    sameAllDays: values.sameAllDays !== false,
    sharedRule,
    rulesByDay,
  }
}

/** The rule one service day resolves with (per-day mode falls back to empty). */
export function effectiveDayRules(
  serviceDays: readonly ServiceDay[],
  plans: SchemeMatchPlans,
): Array<{ day: ServiceDay; rule: StopMatchRule }> {
  return sortServiceDays(serviceDays).map((day) => ({
    day,
    rule: plans.sameAllDays
      ? plans.sharedRule
      : (plans.rulesByDay[day] ?? EMPTY_STOP_MATCH_RULE),
  }))
}

/** "Residual, Glass · Rear loader" — the facts/review one-liner for a rule. */
export function stopRuleSummary(rule: StopMatchRule): string {
  const fractions = rule.fractions.length > 0 ? rule.fractions.join(", ") : "No fractions"
  return rule.vehicleType ? `${fractions} · ${rule.vehicleType}` : fractions
}

/* --------------------------- container profiles --------------------------- */

/**
 * The minimal container shape the matcher reads — the fields both record
 * populations carry: fixture containers hold display facts ("Waste
 * fractions", "Container type") plus the seeded submittedValues.planningAreaId,
 * while form-created containers hold typed submittedValues (wasteFraction /
 * secondaryWasteFraction / containerType enum ids, planningAreaId). Both
 * sources are read here, typed values first, so matching has exactly one
 * documented reading of a container.
 */
export type ContainerMatchProfile = {
  id: string
  name: string
  status: string
  /** plan.areas record id; absent = never matches an area-scoped rule. */
  areaId?: string
  /** Display-vocabulary fractions ("Residual · Mixed" splits into both). */
  fractions: string[]
  /** Display-vocabulary container type; absent = no compatibility profile. */
  containerType?: string
  projectIds?: readonly string[]
}

type ContainerRecordLike = Pick<
  BusinessRecord,
  "id" | "name" | "status" | "facts" | "submittedValues" | "projectIds"
>

export function containerMatchProfile(
  record: ContainerRecordLike,
): ContainerMatchProfile {
  const values = record.submittedValues ?? {}
  const facts = record.facts ?? {}

  const fractions: string[] = []
  const pushFraction = (value: string | undefined) => {
    if (!value) return
    for (const part of value.split("·")) {
      const trimmed = part.trim()
      if (trimmed && !fractions.some((f) => f.toLowerCase() === trimmed.toLowerCase())) {
        fractions.push(trimmed)
      }
    }
  }
  const primary = stringValue(values, "wasteFraction")
  const secondary = stringValue(values, "secondaryWasteFraction")
  if (primary || secondary) {
    pushFraction(primary ? (FORM_FRACTION_LABELS[primary] ?? primary) : undefined)
    pushFraction(secondary ? (FORM_FRACTION_LABELS[secondary] ?? secondary) : undefined)
  } else {
    pushFraction(facts["Waste fractions"])
  }

  const typedType = stringValue(values, "containerType")
  const containerType = typedType
    ? (FORM_CONTAINER_TYPE_LABELS[typedType] ?? typedType)
    : facts["Container type"]?.trim() || undefined

  return {
    id: record.id,
    name: record.name,
    status: record.status,
    areaId: stringValue(values, "planningAreaId"),
    fractions,
    ...(containerType ? { containerType } : {}),
    projectIds: record.projectIds,
  }
}

/* -------------------------------- matching -------------------------------- */

export type StopMatchExclusion = {
  id: string
  name: string
  /** Human-readable, preview-visible reason — exclusions are never silent. */
  reason: string
}

export type StopMatchResult = {
  /** Matched containers sorted by name, so generated stop order is stable. */
  matched: ContainerMatchProfile[]
  /**
   * Fraction-matching near-misses inside the rule's area/project scope that
   * failed eligibility, classification, or vehicle compatibility — the
   * containers a planner would expect and must see excluded.
   */
  excluded: StopMatchExclusion[]
  /** Containers considered (inside the area and project scope). */
  scopeTotal: number
}

const projectsOverlap = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  // A side without recorded projects is scope-unknown and treated as wide.
  if (!a?.length || !b?.length) return true
  return a.some((id) => b.includes(id))
}

const fractionsIntersect = (
  ruleFractions: readonly string[],
  containerFractions: readonly string[],
): boolean =>
  ruleFractions.some((wanted) =>
    containerFractions.some(
      (candidate) => candidate.toLowerCase() === wanted.toLowerCase(),
    ),
  )

/**
 * Resolves one rule against the container records. Area and project bound the
 * scope; inside it, a container matches when its status is in service, a
 * fraction intersects the rule, and — when the rule names a vehicle type —
 * its container type is compatible. An empty-fraction rule matches nothing
 * (the rule IS the fraction selection; validation blocks saving one).
 */
export function resolveStopMatches(input: {
  rule: StopMatchRule
  /** The scheme's planning area (plan.areas record id); required to match. */
  areaId: string | undefined
  /** The scheme's project scope; absent = company-wide. */
  projectIds?: readonly string[]
  containers: readonly ContainerRecordLike[]
}): StopMatchResult {
  const matched: ContainerMatchProfile[] = []
  const excluded: StopMatchExclusion[] = []
  let scopeTotal = 0

  if (!input.areaId) return { matched, excluded, scopeTotal }

  for (const record of input.containers) {
    const profile = containerMatchProfile(record)
    if (profile.areaId !== input.areaId) continue
    if (!projectsOverlap(profile.projectIds, input.projectIds)) continue
    scopeTotal += 1

    if (!fractionsIntersect(input.rule.fractions, profile.fractions)) continue

    if (!ELIGIBLE_CONTAINER_STATUSES.has(profile.status)) {
      excluded.push({
        id: profile.id,
        name: profile.name,
        reason: `${profile.status} — not in service`,
      })
      continue
    }
    if (input.rule.vehicleType) {
      if (!profile.containerType) {
        excluded.push({
          id: profile.id,
          name: profile.name,
          reason: "No container type recorded — vehicle compatibility unknown",
        })
        continue
      }
      const compatible = CONTAINER_VEHICLE_COMPATIBILITY[profile.containerType]
      if (!compatible) {
        excluded.push({
          id: profile.id,
          name: profile.name,
          reason: `No vehicle compatibility profile for ${profile.containerType}`,
        })
        continue
      }
      if (!compatible.includes(input.rule.vehicleType)) {
        excluded.push({
          id: profile.id,
          name: profile.name,
          reason: `${profile.containerType} is not serviceable by a ${input.rule.vehicleType.toLowerCase()}`,
        })
        continue
      }
    }
    matched.push(profile)
  }

  matched.sort((a, b) => a.name.localeCompare(b.name))
  excluded.sort((a, b) => a.name.localeCompare(b.name))
  return { matched, excluded, scopeTotal }
}

/* ------------------------- the shared stop-plan seam ----------------------- */

type SchemeRecordLike = Pick<BusinessRecord, "submittedValues" | "projectIds">

/**
 * THE seam every consumer resolves a scheme's per-day stops through —
 * generation (manual Generate routes AND Plan Ahead), the scheme detail's
 * map and matched-stops sections, and validation callers. Manual schemes
 * keep their picked lists (unchanged behavior); rule schemes resolve their
 * rules against the supplied container records at call time, so the result
 * always reflects the containers that exist NOW.
 */
export function effectiveStopPlans(
  scheme: SchemeRecordLike,
  serviceDays: readonly ServiceDay[],
  containers: readonly ContainerRecordLike[],
): SchemeDayPlan[] {
  const values = scheme.submittedValues
  if (stopSelectionMode(values) === "manual") {
    return effectiveDayPlans(serviceDays, dayPlansFromValues(values))
  }
  const areaId = stringValue(values ?? {}, "planningAreaId")
  return effectiveDayRules(serviceDays, matchPlansFromValues(values)).map(
    ({ day, rule }) => ({
      day,
      containerIds: resolveStopMatches({
        rule,
        areaId,
        projectIds: scheme.projectIds,
        containers,
      }).matched.map((profile) => profile.id),
    }),
  )
}

/**
 * What the rule-overlap warning (validateScheme) needs from the existing
 * rule-mode schemes: area, service days, fraction union, effective period.
 * Manual schemes and schemes without an area or service days cannot overlap
 * by rule and are skipped.
 */
export function schemeStopRuleSources(
  records: readonly Pick<BusinessRecord, "name" | "submittedValues">[],
): SchemeStopRuleSource[] {
  const sources: SchemeStopRuleSource[] = []
  for (const record of records) {
    const values = record.submittedValues
    if (stopSelectionMode(values) !== "rule" || !values) continue
    const areaId = stringValue(values, "planningAreaId")
    if (!areaId) continue
    const serviceDays = serviceDaysFromValues(values)
    if (serviceDays.length === 0) continue
    const plans = matchPlansFromValues(values)
    const fractions = Array.from(
      new Set(
        effectiveDayRules(serviceDays, plans).flatMap(({ rule }) => rule.fractions),
      ),
    )
    if (fractions.length === 0) continue
    sources.push({
      schemeName: record.name,
      areaId,
      serviceDays,
      fractions,
      effectiveFrom: stringValue(values, "effectiveFrom"),
      effectiveTo: stringValue(values, "effectiveTo"),
    })
  }
  return sources
}

/* --------------------------- vehicle-type reading -------------------------- */

/**
 * A vehicle record's type, read as a canonical-type prefix of its
 * "Type · depot" context string ("Rear loader 18 t · Nordhavn" → "Rear
 * loader"). Null when no canonical type prefixes it — the validation warning
 * simply doesn't apply then.
 */
export function vehicleTypeOfRecord(
  vehicle: Pick<BusinessRecord, "context"> | undefined,
): string | null {
  if (!vehicle) return null
  const context = vehicle.context.toLowerCase()
  return (
    STOP_MATCH_VEHICLE_TYPES.find((type) =>
      context.startsWith(type.toLowerCase()),
    ) ?? null
  )
}
