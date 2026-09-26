// Quick Create alignment (issue #31). Pure data logic — no UI or store
// dependencies. Quick Create and Guided Setup are two UX paths to the same
// domain entity, so on submit the quick form's stored values are mapped onto
// the exact draft shape the wizard hands to record creation
// (GuidedSchemeData) and from there share every downstream step: the same
// validateScheme outcome, the same canonical record shape, and the same
// creation orchestration (planSchemeCreation). Parity holds by construction —
// there is no second create path to drift.

import { typedString } from "../record-values"
import {
  DEFAULT_SCHEME_EDIT_POLICY,
  isSchemeCreateAs,
  isSchemeEditPolicy,
  type SchemeCreateAs,
  type SchemeEditPolicy,
} from "./creation"
import {
  driverIneligibilityReason,
  driverOptions,
  driverProfile,
  vehicleProfile,
  type DriverEligibility,
  type FleetRecord,
} from "./fleet-profiles"
import {
  COLLECTION_GROUPS_KEY,
  IMPLICIT_GROUP_ID,
  hasExplicitCollectionGroups,
  parseCollectionGroups,
  type CollectionGroup,
} from "./groups"
import {
  matchPlansFromValues,
  matchPlansToValues,
  stopSelectionMode,
  type StopMatchRule,
} from "./matching"
import { isHolidayPolicy, type HolidayPolicy } from "./occurrences"
import {
  SERVICE_DAYS,
  isRecurrenceFrequency,
  parseServiceDays,
  type RecurrenceFrequency,
  type ServiceDay,
  type WeekRotation,
} from "./recurrence"
import { isSchemeServiceType } from "./scope"

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
  /**
   * The waste fraction this scheme plans for (display vocabulary, e.g.
   * "Residual") — scoped once here; every collection group inherits it
   * (draft.ts draftGroups). Both create paths pick it on their first step
   * (issue #43); empty only while nothing has been picked.
   */
  wasteFraction: string
  /** The service type this scheme plans for (scope.ts vocabulary); both create paths gate on it. */
  serviceType: string
  frequency: RecurrenceFrequency
  weekRotation: WeekRotation
  serviceDays: ServiceDay[]
  effectiveFrom: string
  effectiveTo: string
  plannedStartTime: string
  /**
   * What a collection on a holiday does (guided setup 2026-09-16). Applied by
   * generateOccurrences (@waste/domain/route-schemes/occurrences) — the preview and
   * generation share it.
   */
  holidayPolicy: HolidayPolicy
  /** Review step: create Validated (no generation) or Effective (generate + Plan Ahead). */
  createAs: SchemeCreateAs
  /**
   * Review step, and the quick form's last field: how a later edit of the
   * running scheme applies (issue #38) — the edit-save planner (edit.ts)
   * reads it off the stored record.
   */
  editPolicy: SchemeEditPolicy
  serviceProviderId?: string
  plannedVehicleId?: string
  plannedDriverId?: string
  depotId?: string
  unloadingStationId?: string
  /**
   * The scheme's collection groups (D33): each carries its days, the fraction
   * it inherits from the scheme, vehicle, default driver, optional service
   * provider, and its stop source — a matching rule (fraction + container
   * types inside the scheme's planning area) or explicitly picked containers.
   * Record creation stores
   * one group covering every service day in the legacy single-assignment
   * shape and anything else explicitly (collectionGroupsToValues).
   */
  groups: CollectionGroup[]
}

type StoredValues = Record<string, string | boolean | undefined>

/** Quick Create reads its form values as strings; a missing one is "". */
const stringOf = (values: StoredValues, key: string): string => typedString(values, key) ?? ""

const optionalId = typedString

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
  "wasteFraction",
  "serviceType",
  "frequency",
  "weekRotation",
  "serviceDays",
  "effectiveFrom",
  "effectiveTo",
  "plannedStartTime",
  "holidayPolicy",
  "createAs",
  "editPolicy",
  "serviceProviderId",
  "plannedVehicleId",
  "plannedDriverId",
  "depotId",
  "unloadingStationId",
  "stopSelection",
  "matchVehicleType",
  "matchContainerTypes",
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
 * to the wizard's own defaults. The rule's vehicle and container types are
 * read through matchPlansFromValues — the same deserialization every record
 * reader uses — so the stop-rule storage convention stays defined in one
 * place; its fraction is the scheme's (issue #43): the form picks one Waste
 * fraction on its first section, as Guided Setup does on step 1, so the rule
 * cannot name a second and the retired `matchFractions` list is not read.
 */
export function quickSchemeDraftFromValues(values: StoredValues): GuidedSchemeData {
  const frequency = stringOf(values, "frequency")
  const weekRotation = stringOf(values, "weekRotation")
  // A daily scheme serves the full week whatever days the form picked.
  const serviceDays =
    frequency === "daily" ? [...SERVICE_DAYS] : parseServiceDays(stringOf(values, "serviceDays"))
  const schemeName = stringOf(values, "schemeName")
  const wasteFraction = stringOf(values, "wasteFraction").trim()
  const rule = matchPlansFromValues(values).sharedRule
  const stopSource = values.stopSelection === "manual" ? "manual" : "rule"
  const group: CollectionGroup = {
    id: IMPLICIT_GROUP_ID,
    name: schemeName || "Collection",
    days: serviceDays,
    fractions: stopSource === "rule" && wasteFraction ? [wasteFraction] : [],
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
    ...(stopSource === "rule" && rule.containerTypes && rule.containerTypes.length > 0
      ? { containerTypes: [...rule.containerTypes] }
      : {}),
    containerIds: [],
  }
  const holidayPolicy = values.holidayPolicy
  const createAs = values.createAs
  const editPolicy = values.editPolicy
  return {
    schemeName,
    projectId: optionalId(values, "projectId"),
    planningAreaId: optionalId(values, "planningAreaId"),
    wasteFraction,
    serviceType: stringOf(values, "serviceType"),
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
    // Quick Create keeps the engine's behaviour: holidays skipped, the
    // initial window generated on create (the pre-2026-09-16 default).
    holidayPolicy: isHolidayPolicy(holidayPolicy) ? holidayPolicy : "skip",
    createAs: isSchemeCreateAs(createAs) ? createAs : "effective",
    // The form's own select (issue #38); a form without a pick asks, the default.
    editPolicy: isSchemeEditPolicy(editPolicy) ? editPolicy : DEFAULT_SCHEME_EDIT_POLICY,
    depotId: optionalId(values, "depotId"),
    unloadingStationId: optionalId(values, "unloadingStationId"),
    groups: [group],
  }
}

/** The fleet record the quick form's `plannedVehicleId` names; undefined when it names none, or none that exists. */
export function quickPlannedVehicle<T extends FleetRecord>(
  values: StoredValues,
  vehicles: readonly T[],
): T | undefined {
  const plannedVehicleId = optionalId(values, "plannedVehicleId")
  return plannedVehicleId ? vehicles.find((vehicle) => vehicle.id === plannedVehicleId) : undefined
}

/**
 * The quick form's driver select, judged by the same licence rule as Guided
 * Setup step 3 (issue #37): every driver listed, an ineligible one disabled
 * with the reason beside the name, judged against the vehicle the form's
 * `plannedVehicleId` names. Without a planned vehicle nothing can be judged,
 * so every driver is offered; a vehicle without a class on record can judge
 * nobody, so every driver says so.
 */
export function quickDriverOptions(
  values: StoredValues,
  drivers: readonly FleetRecord[],
  vehicles: readonly FleetRecord[],
): DriverEligibility[] {
  const vehicle = quickPlannedVehicle(values, vehicles)
  return driverOptions(drivers.map(driverProfile), vehicle ? vehicleProfile(vehicle) : null)
}

/**
 * The quick form's submit check: why the driver its `plannedDriverId` names
 * may not take the vehicle its `plannedVehicleId` names, undefined when the
 * pair may go out — or when there is no pair to judge, which the required
 * fields refuse in their own words.
 */
export function quickDriverIssue(
  values: StoredValues,
  drivers: readonly FleetRecord[],
  vehicles: readonly FleetRecord[],
): string | undefined {
  const plannedDriverId = optionalId(values, "plannedDriverId")
  const driver = plannedDriverId ? drivers.find((candidate) => candidate.id === plannedDriverId) : undefined
  return driverIneligibilityReason(driver, quickPlannedVehicle(values, vehicles))
}

/**
 * The quick-schema field ids a multi-group scheme's groups own (D36): the
 * schema dialog edits scheme-level fields only for such a scheme
 * (hasExplicitCollectionGroups) — its groups are edited on the scheme page —
 * so these fields are hidden there instead of showing values the groups
 * would ignore. The waste fraction and the service type are the scheme's,
 * not a group's (every group inherits the fraction), so they stay.
 */
export const GROUP_OWNED_SCHEME_FIELD_IDS: ReadonlySet<string> = new Set([
  "serviceProviderId",
  "plannedVehicleId",
  "plannedDriverId",
  "stopSelection",
  "matchVehicleType",
  "matchContainerTypes",
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
 * The single Waste fraction select (issue #43) seeds from the stored
 * scheme-level fraction, else from the one fraction the stored rule or every
 * explicit group names (a record that predates the field), and blanks for a
 * re-pick when they name several; a service type outside scope.ts's
 * vocabulary (round 2's "Collection") reads as unset. Undefined entries are
 * dropped so they cannot shadow the schema defaults the dialog merges
 * underneath, and the retired `matchFractions` is not seeded at all.
 */
export function seedSchemeEditValues(
  stored: StoredValues,
): Record<string, string | boolean> {
  const seeded: Record<string, string | boolean> = {}
  for (const [key, value] of Object.entries(stored)) {
    if (value !== undefined && key !== "matchFractions") seeded[key] = value
  }
  seeded.stopSelection = stopSelectionMode(stored)
  if (typeof seeded.serviceDays === "string") {
    seeded.serviceDays = parseServiceDays(seeded.serviceDays).join(", ")
  }
  if (seeded.frequency === "biweekly") seeded.frequency = "every-2-weeks"
  // Neither retired shape is offered by the form (every-4-weeks exists in the
  // engine for stored records only), so both blank for a re-pick.
  if (seeded.frequency === "four-week" || seeded.frequency === "calendar-rule") {
    seeded.frequency = ""
  }
  if (typeof seeded.plannedStartTime !== "string") seeded.plannedStartTime = ""
  seeded.wasteFraction = stringOf(stored, "wasteFraction").trim() || storedRuleFraction(stored)
  seeded.serviceType = isSchemeServiceType(stored.serviceType) ? stored.serviceType : ""
  return seeded
}

/**
 * The one fraction a stored scheme's stop selection names — its explicit
 * groups between them, or its shared rule — and "" when it names none or
 * several. The seed for a record written before the scheme-level fraction.
 */
function storedRuleFraction(stored: StoredValues): string {
  const fractions = hasExplicitCollectionGroups(stored)
    ? parseCollectionGroups(typedString(stored, COLLECTION_GROUPS_KEY)).flatMap(
        (group) => group.fractions,
      )
    : stopSelectionMode(stored) === "rule"
      ? matchPlansFromValues(stored).sharedRule.fractions
      : []
  const distinct = [...new Set(fractions)]
  return distinct.length === 1 ? distinct[0] : ""
}

/**
 * The stored values an edit-save leaves behind once the quick form's Waste
 * fraction has been merged in (issue #43). The fraction is scoped once on the
 * scheme and every group inherits it (draft.ts draftGroups) — but a saved
 * record keeps the rule's fractions under `matchFractions` and the explicit
 * groups' inside `collectionGroups`, the keys every reader consumes, so the
 * save has to write them or stop matching would go on reading the fraction
 * the form no longer shows. A rule scheme gets it on the shared rule and on
 * every per-day rule; an explicit-groups scheme on every group; a manual
 * scheme's stops are picked, so nothing else changes; and without a
 * scheme-level fraction the values are returned as they are.
 */
export function applySchemeWasteFraction<T extends StoredValues>(values: T): T {
  const fraction = stringOf(values, "wasteFraction").trim()
  if (!fraction) return values
  if (hasExplicitCollectionGroups(values)) {
    const groups = parseCollectionGroups(typedString(values, COLLECTION_GROUPS_KEY))
    return {
      ...values,
      [COLLECTION_GROUPS_KEY]: JSON.stringify(
        groups.map((group) => ({ ...group, fractions: [fraction] })),
      ),
    }
  }
  if (stopSelectionMode(values) !== "rule") return values
  const plans = matchPlansFromValues(values)
  const withFraction = (rule: StopMatchRule): StopMatchRule => ({ ...rule, fractions: [fraction] })
  const rulesByDay = Object.fromEntries(
    Object.entries(plans.rulesByDay).map(([day, rule]) => [day, withFraction(rule)]),
  ) as typeof plans.rulesByDay
  const { matchRulesByDay, ...shared } = matchPlansToValues({
    ...plans,
    sharedRule: withFraction(plans.sharedRule),
    rulesByDay,
  })
  return {
    ...values,
    ...shared,
    // A record without per-day rules does not gain the key.
    ...(Object.keys(rulesByDay).length > 0 ? { matchRulesByDay } : {}),
  }
}
