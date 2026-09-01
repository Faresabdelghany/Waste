// Route Scheme lifecycle (issue #25; docs/new-changes/SPEC.md area B,
// DECISIONS.md D5/D20/D25/D30). Pure data logic — no UI, store, or fixture
// dependencies — the single seam every surface reads scheme status through:
//
//   Draft → Validated → Scheduled → Effective → Expired
//
// Draft, Validated, and Scheduled are persisted and event-driven (written at
// create/edit-save and on the first successful generation); Effective and
// Expired are derived at evaluation time from the effective period, so a
// stale persisted Effective/Expired string is never trusted — display and
// eligibility always go through effectiveSchemeStatus(record, today).
//
// "Attention" is deliberately NOT a status: it is a live-derived warning
// badge (schemeAttention), recomputed from the scheme's canonical stored
// configuration plus the current related records at render time. Persisted
// "Validation warnings" facts remain for history/debugging only.

import type { BusinessRecord } from "../data/business-modules"
import { schemeFrequencyPromiseOfRecord } from "../data/service-frequencies"
import { calendarFromRecord } from "./calendar"
import {
  effectiveDayRules,
  effectiveStopPlans,
  matchPlansFromValues,
  schemeStopRuleSources,
  stopSelectionMode,
  vehicleTypeOfRecord,
} from "./matching"
import { isIsoDate, recurrenceFromValues, serviceDaysFromValues } from "./recurrence"
import {
  allocationConflictSources,
  dayPlansFromValues,
  schemeDefaultsFromValues,
  stringValue,
  validateScheme,
  type SchemeFrequencyPromise,
  type SchemeValidationResult,
} from "./validation"

export const SCHEME_LIFECYCLE_STATUSES = [
  "Draft",
  "Validated",
  "Scheduled",
  "Effective",
  "Expired",
] as const

export type SchemeLifecycleStatus = (typeof SCHEME_LIFECYCLE_STATUSES)[number]

/** The minimal record shape the status derivation reads. */
type SchemeStatusSource = Pick<BusinessRecord, "status" | "submittedValues">

/**
 * Whether a successful generation has been recorded on the scheme: the
 * persisted marker (`submittedValues.lastGeneratedAt`, stamped by
 * recordSchemeGeneration) or — legacy tolerance for records written before
 * the marker existed — a persisted Scheduled/Effective status. A persisted
 * "Expired" is NOT evidence: it is exactly the stale derived value this
 * module distrusts, and without a marker the scheme may never have generated.
 */
export function schemeGenerationRecorded(record: SchemeStatusSource): boolean {
  const marker = record.submittedValues?.lastGeneratedAt
  if (typeof marker === "string" && marker) return true
  return record.status === "Scheduled" || record.status === "Effective"
}

/**
 * The canonical derived scheme status (D30), used everywhere scheme status
 * is displayed or evaluated. Persisted Draft and Validated pass through;
 * generation evidence promotes to the Scheduled base; Effective and Expired
 * are then re-derived from the effective period against `today` — never read
 * from the stored string. Unknown legacy strings (the retired fixture-only
 * "Validation issue" shape) fall back to Draft: an unrecognizable status is
 * not a promise the scheme can generate.
 */
export function effectiveSchemeStatus(
  record: SchemeStatusSource,
  today: string,
): SchemeLifecycleStatus {
  if (record.status === "Draft") return "Draft"
  const base: SchemeLifecycleStatus = schemeGenerationRecorded(record)
    ? "Scheduled"
    : record.status === "Validated" || record.status === "Expired"
      ? "Validated"
      : "Draft"
  if (base === "Draft") return "Draft"
  const values = record.submittedValues ?? {}
  const effectiveTo = stringValue(values, "effectiveTo")
  if (effectiveTo && isIsoDate(effectiveTo) && today > effectiveTo) return "Expired"
  if (base === "Validated") return "Validated"
  const effectiveFrom = stringValue(values, "effectiveFrom")
  if (effectiveFrom && isIsoDate(effectiveFrom) && today >= effectiveFrom) {
    return "Effective"
  }
  return "Scheduled"
}

/**
 * The record with its status replaced by the derived one — the display seam
 * for record tables and detail views. Returns the input unchanged when the
 * status already matches, so mapped lists stay referentially stable.
 */
export function withEffectiveSchemeStatus(
  record: BusinessRecord,
  today: string,
): BusinessRecord {
  const status = effectiveSchemeStatus(record, today)
  return status === record.status ? record : { ...record, status }
}

/**
 * The first-successful-generation event (D25): stamps the persisted marker
 * and promotes a Validated scheme to Scheduled. Later generations are
 * no-ops (schemeGenerationRecorded guards the callers), and a technical
 * generation failure must never reach this — failure is not scheduling.
 */
export function recordSchemeGeneration(
  scheme: BusinessRecord,
  generatedAt: string,
): BusinessRecord {
  return {
    ...scheme,
    status: scheme.status === "Validated" ? "Scheduled" : scheme.status,
    submittedValues: { ...scheme.submittedValues, lastGeneratedAt: generatedAt },
  }
}

/**
 * Whether the scheme detail should explain that future planning stopped
 * (issue #33, SPEC G): the scheme is Draft — an edit invalidated it — yet
 * generation evidence shows it planned before, so edit-save reconciliation
 * cancelled its future refreshable routes with the resurrection marker.
 * Derived, never persisted: the state clears itself the moment a valid save
 * moves the scheme off Draft.
 */
export function schemeFuturePlanningStopped(record: SchemeStatusSource): boolean {
  return record.status === "Draft" && schemeGenerationRecorded(record)
}

/**
 * Generation eligibility, re-expressed through the derived status (SPEC B):
 * a scheme can generate when its recurrence is structured enough for the
 * engine AND it is not Draft — blocking issues generate nothing (D18/D26).
 * Expired schemes stay eligible: Generate routes remains the manual
 * regeneration/backfill action inside the effective period (D8/D32).
 */
export function schemeCanGenerateRoutes(
  record: BusinessRecord,
  today: string,
): boolean {
  if (recurrenceFromValues(record.submittedValues ?? {}) === null) return false
  return effectiveSchemeStatus(record, today) !== "Draft"
}

/** The related record sets live validation resolves against. */
export type SchemeRelatedRecords = {
  /** Every scheme record (this one included; it is excluded internally). */
  schemes: readonly BusinessRecord[]
  /** Collection Calendar records; the scheme's calendarId resolves here. */
  calendars?: readonly BusinessRecord[]
  /** Vehicle Planning allocation records (issue #11 cross-check). */
  allocations?: readonly BusinessRecord[]
  /** Container records — stop-rule matches and frequency promises. */
  containers?: readonly BusinessRecord[]
  /** Vehicle records — the default vehicle's canonical type. */
  vehicles?: readonly BusinessRecord[]
}

/**
 * Re-runs validateScheme against a stored record's canonical configuration
 * plus the current related records — the record-side counterpart of the
 * wizard's validateGuidedScheme, sharing every check (FR-5 blocking issues,
 * calendar/allocation/rule-overlap/frequency-reconciliation warnings).
 * Null for legacy records without structured recurrence: there is nothing
 * to evaluate live.
 */
export function schemeLiveValidation(
  record: BusinessRecord,
  related: SchemeRelatedRecords,
): SchemeValidationResult | null {
  const values = record.submittedValues
  if (!values) return null
  const recurrence = recurrenceFromValues(values)
  if (!recurrence) return null

  const serviceDays = serviceDaysFromValues(values)
  const containers = related.containers ?? []
  const calendarId = stringValue(values, "calendarId")
  const calendar = calendarId
    ? calendarFromRecord(related.calendars?.find((candidate) => candidate.id === calendarId))
    : null
  const plannedVehicleId = stringValue(values, "plannedVehicleId")
  const plannedDriverId = stringValue(values, "plannedDriverId")

  // In rule mode these are the current rule matches, day-aligned with
  // effectiveDayRules below (effectiveStopPlans maps that same list).
  const dayPlans = effectiveStopPlans(record, serviceDays, containers)
  const linkedContainerIds = new Set(dayPlans.flatMap((plan) => plan.containerIds))
  const promises = containers
    .filter((container) => linkedContainerIds.has(container.id))
    .map((container) => schemeFrequencyPromiseOfRecord(container))
    .filter((promise): promise is SchemeFrequencyPromise => promise !== null)

  const matchPlans = matchPlansFromValues(values)
  const otherSchemes = related.schemes.filter(
    (candidate) => candidate.id !== record.id,
  )
  return validateScheme(
    {
      serviceDays,
      effectiveFrom: recurrence.effectiveFrom,
      effectiveTo: recurrence.effectiveTo,
      plans: dayPlansFromValues(values),
      plannedVehicleId,
      plannedDriverId,
      calendar,
      schemeId: record.id,
      frequencyReconciliation: { frequency: recurrence.frequency, promises },
      ...(stopSelectionMode(values) === "rule"
        ? {
            stopMatching: {
              areaId: stringValue(values, "planningAreaId"),
              sameAllDays: matchPlans.sameAllDays,
              dayRules: effectiveDayRules(serviceDays, matchPlans).map(
                ({ day, rule }, index) => ({
                  day,
                  fractions: rule.fractions,
                  vehicleType: rule.vehicleType,
                  matchedCount: dayPlans[index]?.containerIds.length ?? 0,
                }),
              ),
              plannedVehicleType: vehicleTypeOfRecord(
                related.vehicles?.find((vehicle) => vehicle.id === plannedVehicleId),
              ),
            },
          }
        : {}),
    },
    otherSchemes
      .map((candidate) =>
        schemeDefaultsFromValues(candidate.name, candidate.submittedValues),
      )
      .filter((source): source is NonNullable<typeof source> => source !== null),
    allocationConflictSources(related.allocations ?? []),
    schemeStopRuleSources(otherSchemes),
  )
}

/**
 * The live Attention warnings (D5/D20): the amber badge shows when this is
 * non-empty. Warnings only — blocking issues are the Draft status's own
 * presentation (D26), never folded into Attention.
 */
export function schemeAttention(
  record: BusinessRecord,
  related: SchemeRelatedRecords,
): string[] {
  return schemeLiveValidation(record, related)?.warnings ?? []
}
