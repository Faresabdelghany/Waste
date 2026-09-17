// Service frequency — the typed home for the customer's collection-cadence
// promise (issue #20).
//
// In the real product the frequency promise is a reusable, project-scoped
// Pickup Setting record referenced by product and container — NOT a field on
// the agreement (AgreementOutputSerializerV3 has no frequency field; agreement
// views display what the container inherits). This catalog mirrors that shape
// under the canonical "Service frequency" name: containers and products
// reference a definition by id (submittedValues.serviceFrequencyId), the
// container's "Service frequency" fact is derived from it, and agreements
// display the frequency inherited from their assigned container.
//
// Vocabulary follows the real interval model (collections/week plus
// weeks-between or days-between — every-N-weeks is natively expressible by
// shape even where no definition is seeded). The interval fields are what the
// reconciliation validation (issue #21) actually compares against scheme
// recurrence, via promisedCollectionsPerWeek. Each definition also names the
// scheme RecurrenceFrequency its display label corresponds to; that mapping
// is a vocabulary link, and the rate fallback for `monthly` only — the
// prototype's `monthly` has no real-vocabulary counterpart (no weeks-between
// value is faithful), so that definition carries only the scheme mapping.
//
// This module must stay dependency-light: business-modules.ts derives fixture
// facts from it, so it must not import fixture data back (type-only imports
// are fine).

import {
  RECURRENCE_WEEKLY_RATES,
  type RecurrenceFrequency,
} from "../route-schemes/recurrence"

export type ServiceFrequencyDefinition = {
  id: string
  /** Display name — the derived "Service frequency" fact value. */
  name: string
  description: string
  /** Real-product interval vocabulary. null = on demand (no promised cadence). */
  collectionsPerWeek: number | null
  /** Weeks between collections when collectionsPerWeek is 1. */
  weeksBetween: number | null
  /** Days between collections when collectionsPerWeek is above 1. */
  daysBetween: number | null
  /**
   * The scheme cadence this promise's label corresponds to — a vocabulary
   * link, and the reconciliation rate fallback for the interval-less monthly
   * definition only (the issue #21 comparison itself runs on the interval
   * fields, promisedCollectionsPerWeek). null = no scheme equivalent.
   */
  schemeFrequency: RecurrenceFrequency | null
  /** Project-scoped like the real record. Ids match FIXTURE_PROJECT_IDS. */
  projectIds: string[]
}

const ALL_PROJECTS = ["project-copenhagen", "project-harbor"]

export const SERVICE_FREQUENCIES: readonly ServiceFrequencyDefinition[] = [
  {
    id: "freq-weekly",
    name: "Every week",
    description: "One collection per week on the serviced weekday.",
    collectionsPerWeek: 1,
    weeksBetween: 1,
    daysBetween: null,
    schemeFrequency: "weekly",
    projectIds: [...ALL_PROJECTS],
  },
  {
    id: "freq-every-2-weeks",
    name: "Every 2 weeks",
    description: "One collection every second week (14-day service).",
    collectionsPerWeek: 1,
    weeksBetween: 2,
    daysBetween: null,
    schemeFrequency: "every-2-weeks",
    projectIds: [...ALL_PROJECTS],
  },
  {
    id: "freq-monthly",
    name: "Once a month",
    description:
      "The first serviced weekday of each month. No faithful weeks-between value exists — the real model is strictly week-based.",
    collectionsPerWeek: 1,
    weeksBetween: null,
    daysBetween: null,
    schemeFrequency: "monthly",
    projectIds: [...ALL_PROJECTS],
  },
  {
    id: "freq-on-demand",
    name: "On demand",
    description: "No standing cadence — collections are ordered per occasion.",
    collectionsPerWeek: null,
    weeksBetween: null,
    daysBetween: null,
    schemeFrequency: null,
    projectIds: [...ALL_PROJECTS],
  },
]

export const serviceFrequencyById: ReadonlyMap<string, ServiceFrequencyDefinition> =
  new Map(SERVICE_FREQUENCIES.map((definition) => [definition.id, definition]))

// The pre-#20 container form stored fraction-fused option ids under the
// retained `pickupSetting` field id (issue #13). Read sides fold them onto
// catalog definitions so pre-existing localStorage records keep resolving.
export const LEGACY_FREQUENCY_OPTION_IDS: Record<string, string> = {
  "organic-14": "freq-every-2-weeks",
  "mixed-weekly": "freq-weekly",
  "glass-monthly": "freq-monthly",
  "cardboard-weekly": "freq-weekly",
}

// Cadence tokens that appear in pre-#20 display strings — either alone or as
// a segment of a fused value ("Organic · 14-day service", "Weekly · Mon/Thu").
// A Map, not an object literal: segment names must never hit inherited
// Object.prototype keys ("constructor", "toString", …).
const LEGACY_CADENCE_TOKENS = new Map<string, string>([
  ["weekly", "freq-weekly"],
  ["every week", "freq-weekly"],
  ["14-day service", "freq-every-2-weeks"],
  ["every 2 weeks", "freq-every-2-weeks"],
  ["monthly", "freq-monthly"],
  ["once a month", "freq-monthly"],
  ["on demand", "freq-on-demand"],
])

const definitionByName = new Map(
  SERVICE_FREQUENCIES.map((definition) => [definition.name.toLowerCase(), definition]),
)

/**
 * Resolve any stored frequency shape — a catalog id, a legacy option id, a
 * definition name, or a legacy display string (fused or not) — to its
 * definition. Returns null for "—", empty, and unresolvable free text.
 */
export function resolveServiceFrequencyValue(
  value: string | undefined,
): ServiceFrequencyDefinition | null {
  if (!value || value === "—") return null
  const direct =
    serviceFrequencyById.get(value) ??
    (Object.prototype.hasOwnProperty.call(LEGACY_FREQUENCY_OPTION_IDS, value)
      ? serviceFrequencyById.get(LEGACY_FREQUENCY_OPTION_IDS[value])
      : undefined)
  if (direct) return direct
  const byName = definitionByName.get(value.trim().toLowerCase())
  if (byName) return byName
  for (const segment of value.split("·")) {
    const token = LEGACY_CADENCE_TOKENS.get(segment.trim().toLowerCase())
    if (token) return serviceFrequencyById.get(token) ?? null
  }
  return null
}

/** The record fields the resolver reads — structurally satisfied by BusinessRecord. */
export type ServiceFrequencySource = {
  facts: Record<string, string>
  submittedValues?: Record<string, string | boolean>
}

const stringValue = (value: string | boolean | undefined) =>
  typeof value === "string" ? value : undefined

/**
 * A record's promised frequency, typed reference first: the canonical
 * serviceFrequencyId, then the retained legacy `pickupSetting` form value,
 * then the display facts (current key, then the retired issue #13 key).
 */
export function serviceFrequencyOfRecord(
  record: ServiceFrequencySource,
): ServiceFrequencyDefinition | null {
  return (
    resolveServiceFrequencyValue(stringValue(record.submittedValues?.serviceFrequencyId)) ??
    resolveServiceFrequencyValue(stringValue(record.submittedValues?.pickupSetting)) ??
    resolveServiceFrequencyValue(record.facts["Service frequency"]) ??
    resolveServiceFrequencyValue(record.facts["Pickup setting"])
  )
}

/**
 * Fold a display value onto its definition name so filter facets show one
 * option per cadence (the canonicalCalendarName pattern). Unresolvable values
 * pass through unchanged so legacy free text keeps displaying and filtering.
 */
export function canonicalServiceFrequencyName(value: string | undefined) {
  if (!value) return value
  return resolveServiceFrequencyValue(value)?.name ?? value
}

/** Derived fact value for a typed reference; "—" when there is none. */
export function serviceFrequencyFactValue(id: string | null | undefined) {
  return (id && serviceFrequencyById.get(id)?.name) || "—"
}

/**
 * A promise's nominal collections per week — the interval-vocabulary side of
 * the reconciliation comparison (issue #21 asks for interval comparison, not a
 * hard-coded cadence ladder).
 * weeks-between divides; days-between promises already state a weekly count.
 * The monthly definition carries no faithful interval fields by design, so it
 * reads the scheme-cadence rate. null = on demand — no standing cadence to
 * reconcile.
 */
export function promisedCollectionsPerWeek(
  definition: ServiceFrequencyDefinition,
): number | null {
  if (definition.collectionsPerWeek === null) return null
  if (definition.weeksBetween !== null) {
    return definition.collectionsPerWeek / definition.weeksBetween
  }
  if (definition.schemeFrequency === "monthly") {
    return RECURRENCE_WEEKLY_RATES.monthly
  }
  return definition.collectionsPerWeek
}

/**
 * What the reconciliation validation needs to know about one linked
 * container: its name (for the warning copy), the promised cadence's display
 * name, and the promised rate on the shared collections-per-week scale.
 * Mirrors validation.ts SchemeFrequencyPromise structurally — validation
 * stays free of this module. null when the container carries no resolvable
 * standing promise (no frequency recorded, free text, or on demand).
 */
export function schemeFrequencyPromiseOfRecord(
  record: ServiceFrequencySource & { name: string },
): { containerName: string; promisedName: string; promisedRate: number } | null {
  const definition = serviceFrequencyOfRecord(record)
  if (!definition) return null
  const promisedRate = promisedCollectionsPerWeek(definition)
  if (promisedRate === null) return null
  return { containerName: record.name, promisedName: definition.name, promisedRate }
}
