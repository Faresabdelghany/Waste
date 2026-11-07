// Route Scheme lifecycle (issue #25). Pure data logic — no UI, store, or fixture
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

import type { BusinessRecord } from "../prototype-record"
import { isSoftDeleted } from "../record-visibility"
import { schemeFrequencyPromiseOfRecord } from "../service-frequencies"
import {
  containerDriftBetween,
  containerDriftWarning,
  generationMatchHistoryOf,
  type CollectionGroupContainerDrift,
} from "./container-drift"
import {
  schemeAssignmentSources,
  schemeGroupPlans,
  schemeStopRuleSources,
  schemeValidationGroups,
} from "./groups"
import { vehicleTypeOfRecord } from "./matching"
import { recurrenceFromValues, serviceDaysFromValues } from "./recurrence"
import { isIsoDate } from "../days"
import { servedFrequencyPromises } from "../planning/frequency-reconciliation"
import {
  allocationConflictSources,
  stringValue,
  validateScheme,
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
 * persisted marker (`submittedValues.lastGeneratedAt`, the scheme's last run
 * as the API reads it back) or — legacy tolerance for records written before
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
 * Soft-deleted schemes never are: deletion prevents further generation
 * (issue #34, D32).
 */
export function schemeCanGenerateRoutes(
  record: BusinessRecord,
  today: string,
): boolean {
  if (isSoftDeleted(record)) return false
  if (recurrenceFromValues(record.submittedValues ?? {}) === null) return false
  return effectiveSchemeStatus(record, today) !== "Draft"
}

/**
 * The schemes that still take part in planning: soft-deleted schemes have
 * left it (issue #34, D32) — their default assignment and stop rules no
 * longer conflict with anyone's save, create or edit alike. A deleted
 * scheme is hidden from the list, so a conflict with it could never be
 * resolved. The one filter every validation path's sibling sources go through.
 */
export function schemesInPlanning(
  records: readonly BusinessRecord[],
): BusinessRecord[] {
  return records.filter((record) => !isSoftDeleted(record))
}

/** The related record sets live validation resolves against. */
export type SchemeRelatedRecords = {
  /** Every scheme record (this one included; it is excluded internally). */
  schemes: readonly BusinessRecord[]
  /** Vehicle Planning allocation records (issue #11 cross-check). */
  allocations?: readonly BusinessRecord[]
  /** Container records — stop-rule matches and frequency promises. */
  containers?: readonly BusinessRecord[]
  /** Vehicle records — the default vehicle's canonical type. */
  vehicles?: readonly BusinessRecord[]
}

/** What the live look at a scheme yields: its validation and its last run's container drift. */
export type SchemeLiveAssessment = {
  validation: SchemeValidationResult
  /**
   * Rule groups whose matched containers drifted at the most recent change
   * of the matched set (issue #41), read from the two stamps the runs left —
   * never from the live container base, so the badge reports what a run
   * found and persists across identical runs until the set moves again.
   */
  containerDrift: CollectionGroupContainerDrift[]
}

/**
 * Where a scheme read from the API carries the warnings the API judged it by
 * (O22 of #290), a JSON array of sentences: the cadence against the
 * containers' promised service frequencies, read from the API's
 * `service_frequency` intervals. A record carrying it is not reconciled in
 * the browser; its warnings are the API's.
 */
export const SCHEME_API_WARNINGS_KEY = "apiWarnings"

/** The API's warnings a record carries, or null for a record the API did not answer (fixture mode). */
export function schemeApiWarnings(values: Record<string, string | boolean | undefined> | undefined): string[] | null {
  const stored = values?.[SCHEME_API_WARNINGS_KEY]
  if (typeof stored !== "string") return null
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? parsed.filter((warning): warning is string => typeof warning === "string") : null
  } catch {
    return null
  }
}

/**
 * Re-runs validateScheme against a stored record's canonical configuration
 * plus the current related records — the record-side counterpart of the
 * wizard's validateGuidedScheme, sharing every check (FR-5 blocking issues,
 * allocation/rule-overlap/frequency-reconciliation warnings) — and reads the
 * container drift the last run stamped. Null for legacy records without
 * structured recurrence: there is nothing to evaluate live.
 */
export function schemeLiveAssessment(
  record: BusinessRecord,
  related: SchemeRelatedRecords,
): SchemeLiveAssessment | null {
  const values = record.submittedValues
  if (!values) return null
  const recurrence = recurrenceFromValues(values)
  if (!recurrence) return null

  const serviceDays = serviceDaysFromValues(values)
  const containers = related.containers ?? []

  // The record's collection groups (implicit or explicit) resolved per day —
  // the same seam generation reads, so validation and generation agree.
  const { groups, resolution } = schemeGroupPlans(record, serviceDays, containers)
  // A scheme the API answered is reconciled by the API, against its own intervals.
  const apiWarnings = schemeApiWarnings(values)

  const otherSchemes = schemesInPlanning(related.schemes).filter(
    (candidate) => candidate.id !== record.id,
  )
  const validation = validateScheme(
    {
      serviceDays,
      effectiveFrom: recurrence.effectiveFrom,
      effectiveTo: recurrence.effectiveTo,
      areaId: stringValue(values, "planningAreaId"),
      schemeId: record.id,
      ...(apiWarnings === null
        ? {
            frequencyReconciliation: {
              frequency: recurrence.frequency,
              promises: servedFrequencyPromises(resolution.plans, containers, schemeFrequencyPromiseOfRecord),
              // Every cadence of the year, the seasons' among them (O17 of #290), as the API judges them.
              ...(recurrence.seasons === undefined ? {} : { seasons: recurrence.seasons }),
            },
          }
        : {}),
      ...schemeValidationGroups(
        groups,
        resolution,
        (vehicleId) =>
          vehicleTypeOfRecord(related.vehicles?.find((vehicle) => vehicle.id === vehicleId)),
        (containerId) => containers.find((container) => container.id === containerId)?.name,
      ),
    },
    otherSchemes.flatMap((candidate) =>
      schemeAssignmentSources(candidate.name, candidate.submittedValues),
    ),
    allocationConflictSources(related.allocations ?? []),
    schemeStopRuleSources(otherSchemes),
  )
  const history = generationMatchHistoryOf(values)
  return {
    validation: apiWarnings === null ? validation : { ...validation, warnings: [...validation.warnings, ...apiWarnings] },
    containerDrift: containerDriftBetween(history.previous, history.last, groups),
  }
}

/**
 * The validation half of schemeLiveAssessment — what edit-save judges a save
 * by and the Details tab reads its blocking issues from. Container drift is
 * not validation: it never blocks and never enters the persisted
 * "Validation warnings" fact.
 */
export function schemeLiveValidation(
  record: BusinessRecord,
  related: SchemeRelatedRecords,
): SchemeValidationResult | null {
  return schemeLiveAssessment(record, related)?.validation ?? null
}

/**
 * The warnings an assessment shows as Attention: validation's, then the one
 * container-drift sentence when the last run drifted (issue #41). Spelled
 * once, so the list badge and the detail header cannot disagree.
 */
export function attentionWarnings(assessment: SchemeLiveAssessment | null): string[] {
  if (!assessment) return []
  const drift = containerDriftWarning(assessment.containerDrift)
  return drift ? [...assessment.validation.warnings, drift] : assessment.validation.warnings
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
  return attentionWarnings(schemeLiveAssessment(record, related))
}
