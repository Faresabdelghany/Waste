// A record's promised service frequency (issue #20): the catalogue's
// definition a container or product names (@waste/fixtures/service-frequencies),
// resolved from whatever shape the record stores it in, and the promise the
// scheme reconciliation (@waste/domain/planning/frequency-reconciliation)
// reads off a container, which a container read from the API names by rate.

import { intervalCollectionsPerWeek } from "@waste/domain/planning/frequency-reconciliation"
import { EMPTY_FACT } from "./record-values"
import { SERVICE_FREQUENCIES, type ServiceFrequencyDefinition } from "@waste/fixtures/service-frequencies"

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
  if (!value || value === EMPTY_FACT) return null
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

export function promisedCollectionsPerWeek(
  definition: ServiceFrequencyDefinition,
): number | null {
  return intervalCollectionsPerWeek(definition)
}

/**
 * Where a container read from the API carries its promise (O22 of #290): the
 * effective frequency's collections per week, resolved from the API's
 * interval, spelled as a number, or "" when it has no standing promise. A
 * record carrying the key is never resolved against the fixture catalog.
 */
export const PROMISED_RATE_KEY = "promisedCollectionsPerWeek"

/**
 * What the reconciliation validation needs to know about one linked
 * container: its name (for the warning copy), the promised cadence's display
 * name, and the promised rate on the shared collections-per-week scale.
 * Mirrors SchemeFrequencyPromise (planning/frequency-reconciliation)
 * structurally — the reconciliation stays free of this module. null when the container carries no resolvable
 * standing promise (no frequency recorded, free text, or on demand). A
 * record read from the API names its promise under `PROMISED_RATE_KEY`.
 */
export function schemeFrequencyPromiseOfRecord(
  record: ServiceFrequencySource & { name: string },
): { containerName: string; promisedName: string; promisedRate: number } | null {
  const typed = record.submittedValues?.[PROMISED_RATE_KEY]
  if (typeof typed === "string") {
    const promisedRate = Number(typed)
    const promisedName = record.facts["Service frequency"]
    if (typed === "" || !Number.isFinite(promisedRate) || promisedRate <= 0 || !promisedName) return null
    return { containerName: record.name, promisedName, promisedRate }
  }
  const definition = serviceFrequencyOfRecord(record)
  if (!definition) return null
  const promisedRate = promisedCollectionsPerWeek(definition)
  if (promisedRate === null) return null
  return { containerName: record.name, promisedName: definition.name, promisedRate }
}
