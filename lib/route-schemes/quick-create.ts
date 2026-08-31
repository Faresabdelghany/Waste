// Quick Create alignment (issue #31; docs/new-changes/SPEC.md area D,
// DECISIONS.md D19/D23/D29, P1). Pure data logic — no UI or store
// dependencies. Quick Create and Guided Setup are two UX paths to the same
// domain entity, so on submit the quick form's stored values are mapped onto
// the exact draft shape the wizard hands to record creation
// (GuidedSchemeData) and from there share every downstream step: the same
// validateScheme outcome, the same canonical record shape, and the same
// creation orchestration (planSchemeCreation). Parity holds by construction —
// there is no second create path to drift.
// Harness: scripts/route-scheme-validation-harness.ts.

import {
  matchPlansFromValues,
  type StopMatchRule,
  type StopSelectionMode,
} from "./matching"
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
 * so the mapping and the harness can read it without pulling in UI code.
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
  contractorId?: string
  plannedVehicleId?: string
  plannedDriverId?: string
  depotId?: string
  unloadingStationId?: string
  /**
   * Stop selection (issue #19): "rule" stores a declarative matching rule
   * (fractions + optional vehicle type inside the scheme's planning area);
   * "manual" keeps the explicitly picked container lists.
   */
  stopSelection: StopSelectionMode
  sameAllDays: boolean
  sharedContainerIds: string[]
  containersByDay: Partial<Record<ServiceDay, string[]>>
  matchRule: StopMatchRule
  matchRulesByDay: Partial<Record<ServiceDay, StopMatchRule>>
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
  "contractorId",
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
 * field ids) onto the wizard's draft shape (D19). Single-rule by design
 * (D29): the draft always carries one shared rule across all service days —
 * per-day rules and manual container lists are Guided Setup capabilities, so
 * those draft fields stay empty. A "manual" stop selection is preserved (the
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
  return {
    schemeName: stringOf(values, "schemeName"),
    projectId: optionalId(values, "projectId"),
    planningAreaId: optionalId(values, "planningAreaId"),
    calendarId: optionalId(values, "calendarId"),
    frequency: isRecurrenceFrequency(frequency) ? frequency : "weekly",
    weekRotation: weekRotation === "even" ? "even" : "odd",
    serviceDays: parseServiceDays(stringOf(values, "serviceDays")),
    effectiveFrom: stringOf(values, "effectiveFrom"),
    // Optional (D23): an omitted To means the scheme runs open-ended until
    // explicitly ended or expired through later configuration.
    effectiveTo: stringOf(values, "effectiveTo"),
    // No silent time injection (issue #32): a scheme without a planned start
    // time stays without one — its routes then carry no estimated start.
    plannedStartTime: stringOf(values, "plannedStartTime"),
    contractorId: optionalId(values, "contractorId"),
    plannedVehicleId: optionalId(values, "plannedVehicleId"),
    plannedDriverId: optionalId(values, "plannedDriverId"),
    depotId: optionalId(values, "depotId"),
    unloadingStationId: optionalId(values, "unloadingStationId"),
    stopSelection: values.stopSelection === "manual" ? "manual" : "rule",
    sameAllDays: true,
    sharedContainerIds: [],
    containersByDay: {},
    matchRule: matchPlansFromValues(values).sharedRule,
    matchRulesByDay: {},
  }
}
