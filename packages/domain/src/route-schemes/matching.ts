// Declarative stop matching for Route Schemes (issue #19): a scheme in "rule"
// stop-selection mode stores the selection rule — waste fractions + optional
// vehicle type, scoped to the scheme's planning area and project — instead of
// a hand-picked container list. Generation, validation, the wizard preview,
// and the scheme detail all resolve the rule against live container records
// through this module, so a container added to the area later is picked up by
// the next generation without editing the scheme.
//
// Pure data logic — no UI, store, or fixture dependencies (type-only import
// of BusinessRecord), mirroring validation.ts, so the resolver can be
// exercised without a browser.

import type { BusinessRecord } from "../prototype-record"
import { splitList } from "../record-values"
import { schemeLicenceDay } from "../planning/checks"
import { addDays, isIsoDate, SERVICE_DAYS, sortServiceDays, type ServiceDay } from "./recurrence"
import { stringValue } from "./validation"

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
 * analog of the real product's Active-agreement gate. Future, On hold, Defect, In storage, In transit,
 * and Ended containers are excluded with a visible reason.
 */
export const ELIGIBLE_CONTAINER_STATUSES = new Set(["Available"])

/**
 * Where a container the API holds says when and where it is in service (#207,
 * #232): JSON `ServingReading` — for each of its placements not ended by the
 * project's day it was read on, the period that placement serves it in under
 * its subscription and that subscription's agreement (the three intersected,
 * the worker's eligibility in apps/worker's stop-matching) and the planning
 * areas its place lies in. Areas overlap and the worker holds a point to each
 * scheme's own area, so a container counts in each that contains it. A record
 * that carries it is held to it and not to its status, which is its asset
 * state there (every seeded container has no movement yet), and named by its
 * facts, since its typed fraction and type are master-data web ids. The
 * fixtures' containers say nothing here and keep their status as the gate,
 * their one `planningAreaId` and their typed tokens.
 */
export const SERVING_KEY = "serving"

/** One placement's serving: `from` its first day, `until` its first day out or null while open (half-open, as the wire spells periods), and the areas its place lies in. */
export type ServingPeriod = { from: string; until: string | null; areaIds: readonly string[] }

/** A container's serving as read on `asOf`, the project's day. */
export type ServingReading = { asOf: string; periods: readonly ServingPeriod[] }

const readings = new WeakMap<object, ServingReading | null>()

/** The serving a container the API holds carries, read once per record's values; undefined for a fixture's. One it cannot read serves nowhere. */
export function servingReadingOf(record: Pick<BusinessRecord, "submittedValues">): ServingReading | undefined {
  const values = record.submittedValues
  if (values === undefined) return undefined
  const cached = readings.get(values)
  if (cached !== undefined) return cached ?? undefined
  const raw = stringValue(values, SERVING_KEY)
  const reading = raw === undefined ? null : parseReading(raw)
  readings.set(values, reading)
  return reading ?? undefined
}

function parseReading(raw: string): ServingReading {
  const day = (value: unknown) => (typeof value === "string" && isIsoDate(value) ? value : null)
  try {
    const parsed = JSON.parse(raw) as { asOf?: unknown; periods?: unknown }
    const asOf = day(parsed.asOf)
    if (asOf !== null && Array.isArray(parsed.periods)) {
      const periods = parsed.periods.flatMap((entry: { from?: unknown; until?: unknown; areaIds?: unknown }) => {
        const from = day(entry?.from)
        if (from === null) return []
        const areaIds = Array.isArray(entry.areaIds) ? entry.areaIds.filter((id): id is string => typeof id === "string") : []
        return [{ from, until: day(entry.until), areaIds }]
      })
      return { asOf, periods }
    }
  } catch {
    // Unreadable: below.
  }
  return { asOf: "", periods: [] }
}

/**
 * The day a container is judged on (#232): the scheme's first day where it
 * is not behind the day the reading was made — a new scheme's first
 * collection — else that day, a running scheme's collections being from now
 * on (`schemeLicenceDay`, the day a group's driver is judged on).
 */
function judgedOn(reading: ServingReading, schemeFrom: string | undefined): string {
  return schemeLicenceDay(schemeFrom !== undefined && isIsoDate(schemeFrom) ? schemeFrom : reading.asOf, reading.asOf).day
}

const covers = (period: ServingPeriod, day: string) => period.from <= day && (period.until === null || day < period.until)

/** Why a container is out of service on `day` in `areaId` — anywhere, without one — or undefined while a period there holds it. */
function outOfService(reading: ServingReading, day: string, areaId?: string): string | undefined {
  const here = areaId === undefined ? reading.periods : reading.periods.filter((period) => period.areaIds.includes(areaId))
  if (here.some((period) => covers(period, day))) return undefined
  const next = here.filter((period) => period.from > day).map((period) => period.from).sort()[0]
  if (next !== undefined) return `Serves from ${next}`
  const last = here.flatMap((period) => (period.until === null ? [] : [period.until])).sort().at(-1)
  return last === undefined ? "No placement serves it" : `Served until ${addDays(last, -1)}`
}

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
  /**
   * Restrict to these container types (display vocabulary, e.g. "Two-wheel
   * bin · 240 L"); absent or empty = any type. Added for the guided setup's
   * fraction + container-type groups (2026-09-16).
   */
  containerTypes?: string[]
}

/** Container types with a compatibility profile — the vocabulary rules pick from. */
export const CONTAINER_TYPE_VOCABULARY: readonly string[] = Object.keys(
  CONTAINER_VEHICLE_COMPATIBILITY,
)

const BIN_TYPE_PREFIXES = ["Two-wheel bin", "Four-wheel bin"]

/**
 * "Two-wheel bin · 240 L" → "240 L"; "Underground · 5,000 L" → "Underground".
 * Bins are told apart by size, everything else by kind — the chip label the
 * guided setup and the group summaries use.
 */
export function containerTypeShortLabel(containerType: string): string {
  const [kind, size] = containerType.split(" · ").map((part) => part.trim())
  if (!size) return kind
  return BIN_TYPE_PREFIXES.includes(kind) ? size : kind
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
// The one list reader (record-values.ts): a comma inside a number is not a separator.
export { splitList }

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
  matchContainerTypes: string
  matchRulesByDay: string
} {
  return {
    matchFractions: plans.sharedRule.fractions.join(", "),
    matchVehicleType: plans.sharedRule.vehicleType ?? "",
    matchContainerTypes: (plans.sharedRule.containerTypes ?? []).join(", "),
    matchRulesByDay: JSON.stringify(plans.rulesByDay),
  }
}

const isServiceDay = (value: string): value is ServiceDay =>
  (SERVICE_DAYS as readonly string[]).includes(value)

const parseRule = (candidate: unknown): StopMatchRule | null => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null
  }
  const raw = candidate as { fractions?: unknown; vehicleType?: unknown; containerTypes?: unknown }
  const stringItems = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : []
  const fractions = stringItems(raw.fractions)
  const containerTypes = stringItems(raw.containerTypes)
  const vehicleType =
    typeof raw.vehicleType === "string" && raw.vehicleType.trim()
      ? raw.vehicleType.trim()
      : undefined
  return {
    fractions,
    ...(vehicleType ? { vehicleType } : {}),
    ...(containerTypes.length > 0 ? { containerTypes } : {}),
  }
}

export function matchPlansFromValues(
  values: Record<string, string | boolean | undefined> | undefined,
): SchemeMatchPlans {
  if (!values) return EMPTY_MATCH_PLANS
  const containerTypes = splitList(stringValue(values, "matchContainerTypes"))
  const sharedRule: StopMatchRule = {
    fractions: splitList(stringValue(values, "matchFractions")),
    ...(stringValue(values, "matchVehicleType")
      ? { vehicleType: stringValue(values, "matchVehicleType") }
      : {}),
    ...(containerTypes.length > 0 ? { containerTypes } : {}),
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

/** "Residual, Glass · 240 L, 660 L · Rear loader" — the facts/review one-liner for a rule. */
export function stopRuleSummary(rule: StopMatchRule): string {
  const fractions = rule.fractions.length > 0 ? rule.fractions.join(", ") : "No fractions"
  const parts = [fractions]
  if (rule.containerTypes && rule.containerTypes.length > 0) {
    parts.push(rule.containerTypes.map(containerTypeShortLabel).join(", "))
  }
  if (rule.vehicleType) parts.push(rule.vehicleType)
  return parts.join(" · ")
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
  /** Whether it can be planned on the day judged, in any area: its serving where the record carries one (`SERVING_KEY`), its status otherwise. */
  inService: boolean
  /** The configure.areas record ids it lies in; none = never matches an area-scoped rule. */
  areaIds: string[]
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

/**
 * A container as a rule matches it. `schemeFrom`, the scheme's first day,
 * is the day a container the API holds is judged in service on where it is
 * later than the day its reading was made (`judgedOn`).
 */
export function containerMatchProfile(
  record: ContainerRecordLike,
  schemeFrom?: string,
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
  // A container the API holds types its master data by web id (#207), which
  // is no name a rule matches: its display facts say the names instead.
  const reading = servingReadingOf(record)
  const fromApi = reading !== undefined
  const typedName = (key: string, labels: Readonly<Record<string, string>>) => {
    const value = fromApi ? undefined : stringValue(values, key)
    return value === undefined ? undefined : (labels[value] ?? value)
  }
  const primary = typedName("wasteFraction", FORM_FRACTION_LABELS)
  const secondary = typedName("secondaryWasteFraction", FORM_FRACTION_LABELS)
  if (primary || secondary) {
    pushFraction(primary)
    pushFraction(secondary)
  } else {
    pushFraction(facts["Waste fractions"])
  }

  const containerType = typedName("containerType", FORM_CONTAINER_TYPE_LABELS) ?? (facts["Container type"]?.trim() || undefined)

  const areaId = stringValue(values, "planningAreaId")

  return {
    id: record.id,
    name: record.name,
    status: record.status,
    inService: reading !== undefined ? outOfService(reading, judgedOn(reading, schemeFrom)) === undefined : ELIGIBLE_CONTAINER_STATUSES.has(record.status),
    areaIds: reading !== undefined ? [...new Set(reading.periods.flatMap((period) => period.areaIds))] : areaId !== undefined ? [areaId] : [],
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

/** Why a container is out of service for a scheme in `areaId` from `schemeFrom`: its serving there where the API holds it, its status for a fixture's; undefined while in. */
function outOfServiceFor(record: ContainerRecordLike, profile: ContainerMatchProfile, areaId: string, schemeFrom: string | undefined): string | undefined {
  const reading = servingReadingOf(record)
  if (reading === undefined) return profile.inService ? undefined : profile.status
  return outOfService(reading, judgedOn(reading, schemeFrom), areaId)
}

/**
 * Resolves one rule against the container records. Area and project bound the
 * scope; inside it, a container matches when it is in service there, a
 * fraction intersects the rule, and — when the rule names a vehicle type —
 * its container type is compatible. An empty-fraction rule matches nothing
 * (the rule IS the fraction selection; validation blocks saving one).
 */
export function resolveStopMatches(input: {
  rule: StopMatchRule
  /** The scheme's planning area (configure.areas record id); required to match. */
  areaId: string | undefined
  /** The scheme's project scope; absent = company-wide. */
  projectIds?: readonly string[]
  /** The scheme's first day, which a container the API holds is judged in service on where it is still ahead (#232). */
  from?: string | undefined
  containers: readonly ContainerRecordLike[]
}): StopMatchResult {
  const matched: ContainerMatchProfile[] = []
  const excluded: StopMatchExclusion[] = []
  let scopeTotal = 0

  if (!input.areaId) return { matched, excluded, scopeTotal }

  for (const record of input.containers) {
    const profile = containerMatchProfile(record, input.from)
    if (!profile.areaIds.includes(input.areaId)) continue
    if (!projectsOverlap(profile.projectIds, input.projectIds)) continue
    scopeTotal += 1

    if (!fractionsIntersect(input.rule.fractions, profile.fractions)) continue
    // A container type outside the rule is a deliberate exclusion (the rule
    // IS the type selection), not a near-miss the planner must be shown.
    if (
      input.rule.containerTypes &&
      input.rule.containerTypes.length > 0 &&
      !input.rule.containerTypes.some(
        (type) => type.toLowerCase() === (profile.containerType ?? "").toLowerCase(),
      )
    ) {
      continue
    }

    const outOfServiceHere = outOfServiceFor(record, profile, input.areaId, input.from)
    if (outOfServiceHere !== undefined) {
      excluded.push({
        id: profile.id,
        name: profile.name,
        reason: `${outOfServiceHere} — not in service`,
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
