// Quick Create alignment (issue #31). Pure data logic — no UI or store
// dependencies. Quick Create and Guided Setup are two UX paths to the same
// domain entity, so on submit the quick form's stored values are mapped onto
// the exact draft shape the wizard hands to record creation
// (GuidedSchemeData) and from there share every downstream step: the same
// validateScheme outcome, the same canonical record shape, and the same
// creation orchestration (planSchemeCreation). Parity holds by construction —
// there is no second create path to drift.

import { IMPLICIT_GROUP_ID, type CollectionGroup } from "./groups"
import { matchPlansFromValues, stopSelectionMode } from "./matching"
import {
  isRecurrenceFrequency,
  parseServiceDays,
  type RecurrenceFrequency,
  type ServiceDay,
  type WeekRotation,
} from "./recurrence"

/**
 * The scheme draft both create paths hand to record creation: Guided Setup
 * collects it across the wizard steps, Quick Create maps its form values onto
 * it (quickSchemeDraftFromValues). Lives here — not in the wizard component —
 * so the mapping can read it without pulling in UI code.
 */
export interface GuidedSchemeData {
  schemeName: string
  projectId?: string
  planningAreaId?: string
  calendarId?: string
  frequency: RecurrenceFrequency
  weekRotation: WeekRotation
  serviceDays: ServiceDay[]
  effectiveFrom: string
  effectiveTo: string
  plannedStartTime: string
  serviceProviderId?: string
  plannedVehicleId?: string
  plannedDriverId?: string
  depotId?: string
  unloadingStationId?: string
  /**
   * The scheme's collection groups (D33): each carries its days, fractions,
   * vehicle, default driver, optional service provider, and its stop source —
   * a matching rule (fractions + optional vehicle type inside the scheme's
   * planning area) or explicitly picked containers. Record creation stores
   * one group covering every service day in the legacy single-assignment
   * shape and anything else explicitly (collectionGroupsToValues).
   */
  groups: CollectionGroup[]
}

type StoredValues = Record<string, string | boolean | undefined>

const stringOf = (values: StoredValues, key: string): string => {
  const value = values[key]
  return typeof value === "string" ? value.trim() : ""
}

const optionalId = (values: StoredValues, key: string): string | undefined =>
  stringOf(values, key) || undefined

/**
 * The `route-studio.schemes` form fields quickSchemeDraftFromValues consumes
 * into the draft. The create handler treats every OTHER schema field as a
 * quick-only extra to carry onto the record verbatim (values, display fact,
 * relation ref) — derived as the complement so a field added to the schema is
 * carried automatically instead of silently dropped.
 */
export const QUICK_SCHEME_DRAFT_FIELD_IDS: ReadonlySet<string> = new Set([
  "schemeName",
  "projectId",
  "planningAreaId",
  "calendarId",
  "frequency",
  "weekRotation",
  "serviceDays",
  "effectiveFrom",
  "effectiveTo",
  "plannedStartTime",
  "serviceProviderId",
  "plannedVehicleId",
  "plannedDriverId",
  "depotId",
  "unloadingStationId",
  "stopSelection",
  "matchFractions",
  "matchVehicleType",
])

/**
 * Maps the Quick Create form's stored values (the `route-studio.schemes`
 * field ids) onto the wizard's draft shape (D19). Single-group by design
 * (D29): the draft carries ONE collection group covering every service day —
 * vehicle, driver, provider, and one shared rule or (empty) manual list from
 * the form — so record creation stores it in the legacy shape; several groups
 * are a Guided Setup capability. A "manual" stop selection is preserved (the
 * quick form offers no picker, so validation blocks it with the same
 * missing-containers issue the wizard would raise for an empty pick — never
 * silently converted to a rule). Unknown frequency/rotation values fall back
 * to the wizard's own defaults. The rule itself is read through
 * matchPlansFromValues — the same deserialization every record reader uses —
 * so the stop-rule storage convention stays defined in one place.
 */
export function quickSchemeDraftFromValues(values: StoredValues): GuidedSchemeData {
  const frequency = stringOf(values, "frequency")
  const weekRotation = stringOf(values, "weekRotation")
  const serviceDays = parseServiceDays(stringOf(values, "serviceDays"))
  const schemeName = stringOf(values, "schemeName")
  const rule = matchPlansFromValues(values).sharedRule
  const stopSource = values.stopSelection === "manual" ? "manual" : "rule"
  const group: CollectionGroup = {
    id: IMPLICIT_GROUP_ID,
    name: schemeName || "Collection",
    days: serviceDays,
    fractions: stopSource === "rule" ? [...rule.fractions] : [],
    ...(optionalId(values, "plannedVehicleId")
      ? { vehicleId: optionalId(values, "plannedVehicleId") }
      : {}),
    ...(optionalId(values, "plannedDriverId")
      ? { driverId: optionalId(values, "plannedDriverId") }
      : {}),
    ...(optionalId(values, "serviceProviderId")
      ? { serviceProviderId: optionalId(values, "serviceProviderId") }
      : {}),
    stopSource,
    ...(stopSource === "rule" && rule.vehicleType ? { ruleVehicleType: rule.vehicleType } : {}),
    containerIds: [],
  }
  return {
    schemeName,
    projectId: optionalId(values, "projectId"),
    planningAreaId: optionalId(values, "planningAreaId"),
    calendarId: optionalId(values, "calendarId"),
    frequency: isRecurrenceFrequency(frequency) ? frequency : "weekly",
    weekRotation: weekRotation === "even" ? "even" : "odd",
    serviceDays,
    effectiveFrom: stringOf(values, "effectiveFrom"),
    // Optional (D23): an omitted To means the scheme runs open-ended until
    // explicitly ended or expired through later configuration.
    effectiveTo: stringOf(values, "effectiveTo"),
    // No silent time injection (issue #32): a scheme without a planned start
    // time stays without one — its routes then carry no estimated start.
    plannedStartTime: stringOf(values, "plannedStartTime"),
    depotId: optionalId(values, "depotId"),
    unloadingStationId: optionalId(values, "unloadingStationId"),
    groups: [group],
  }
}

/**
 * The quick-schema field ids a multi-group scheme's groups own (D36): the
 * schema dialog edits scheme-level fields only for such a scheme
 * (hasExplicitCollectionGroups) — its groups are edited on the scheme page —
 * so these fields are hidden there instead of showing values the groups
 * would ignore.
 */
export const GROUP_OWNED_SCHEME_FIELD_IDS: ReadonlySet<string> = new Set([
  "serviceProviderId",
  "plannedVehicleId",
  "plannedDriverId",
  "stopSelection",
  "matchFractions",
  "matchVehicleType",
])

/**
 * Seeds the quick form for editing a stored scheme (issue #35). The stored
 * values are the truth: the schema's create-time defaults must never speak
 * for a record that predates a field. Stop selection is read through
 * stopSelectionMode — a scheme without the flag IS manual (legacy fixtures),
 * so seeding the create default "rule" would demand a matching rule the
 * scheme never had and, on save, silently flip where its stops come from.
 * Retired recurrence shapes (capitalized textarea day names; the biweekly /
 * four-week / calendar-rule frequencies) map onto today's options or blank
 * for a re-pick, and a missing planned start time stays missing (issue #32).
 * Undefined entries are dropped so they cannot shadow the schema defaults
 * the dialog merges underneath.
 */
export function seedSchemeEditValues(
  stored: StoredValues,
): Record<string, string | boolean> {
  const seeded: Record<string, string | boolean> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined) seeded[key] = value
  }
  seeded.stopSelection = stopSelectionMode(stored)
  if (typeof seeded.serviceDays === "string") {
    seeded.serviceDays = parseServiceDays(seeded.serviceDays).join(", ")
  }
  if (seeded.frequency === "biweekly") seeded.frequency = "every-2-weeks"
  if (seeded.frequency === "four-week" || seeded.frequency === "calendar-rule") {
    seeded.frequency = ""
  }
  if (typeof seeded.plannedStartTime !== "string") seeded.plannedStartTime = ""
  return seeded
}
