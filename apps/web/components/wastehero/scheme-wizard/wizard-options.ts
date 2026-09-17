// Option vocabularies the guided setup shows, and the draft defaults it
// opens with. The frequency options are the product's four cadences mapped
// onto the engine's (frequency, weekRotation) pair.

import { SCHEME_CREATE_AS_LABELS } from "@/lib/route-schemes/creation"
import { HOLIDAY_POLICIES, HOLIDAY_POLICY_LABELS } from "@/lib/route-schemes/occurrences"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { SCHEME_SERVICE_TYPES } from "@/lib/route-schemes/scope"
import {
  OFFERED_RECURRENCE_FREQUENCIES,
  RECURRENCE_FREQUENCY_LABELS,
  SERVICE_DAYS,
  isIsoDate,
  isRecurrenceFrequency,
  isoWeekRotation,
  todayIso,
  type RecurrenceFrequency,
} from "@/lib/route-schemes/recurrence"

import type { SelectOption } from "./wizard-fields"

export const WIZARD_STEPS = [
  { id: 1, label: "Scheme & scope" },
  { id: 2, label: "Recurrence" },
  { id: 3, label: "Collection groups" },
  { id: 4, label: "Route map" },
  { id: 5, label: "Review & create" },
] as const

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"]

export const WIZARD_STEP_TITLES: Record<WizardStepId, string> = {
  1: "Which scope does this scheme plan for?",
  2: "When does this scheme collect?",
  3: "Who collects what on which service days?",
  4: "How do the generated routes look?",
  5: "Ready to create this scheme?",
}

/** Daily · Every week · Every 2 weeks · Every 3 weeks · Once a month. */
export const WIZARD_FREQUENCIES: readonly SelectOption[] = OFFERED_RECURRENCE_FREQUENCIES.map(
  (value) => ({ value, label: RECURRENCE_FREQUENCY_LABELS[value] }),
)

/** The select value for the draft's cadence; empty for a cadence the wizard does not offer. */
export function wizardFrequencyValue(data: Pick<GuidedSchemeData, "frequency">): string {
  return OFFERED_RECURRENCE_FREQUENCIES.includes(data.frequency) ? data.frequency : ""
}

/**
 * The fortnight cadence anchors on the effective-from week: the week
 * rotation is that week's ISO parity, so "Every 2 weeks" reads as "from the
 * start week, every other week" while the engine keeps its parity model.
 */
export function fortnightRotation(effectiveFrom: string) {
  return isoWeekRotation(isIsoDate(effectiveFrom) ? effectiveFrom : todayIso())
}

/**
 * The draft patch for a picked cadence. Daily serves the whole week, so it
 * selects every service day; every 2 weeks derives its rotation from the
 * effective-from week.
 */
export function applyWizardFrequency(
  value: string,
  draft: Pick<GuidedSchemeData, "effectiveFrom" | "serviceDays" | "weekRotation">,
): Pick<GuidedSchemeData, "frequency" | "weekRotation" | "serviceDays"> {
  const frequency: RecurrenceFrequency = isRecurrenceFrequency(value) ? value : "weekly"
  return {
    frequency,
    weekRotation:
      frequency === "every-2-weeks" ? fortnightRotation(draft.effectiveFrom) : draft.weekRotation,
    serviceDays: frequency === "daily" ? [...SERVICE_DAYS] : draft.serviceDays,
  }
}

export const HOLIDAY_POLICY_OPTIONS: readonly SelectOption[] = HOLIDAY_POLICIES.map((value) => ({
  value,
  label: HOLIDAY_POLICY_LABELS[value],
}))

export const SERVICE_TYPE_OPTIONS: readonly SelectOption[] = SCHEME_SERVICE_TYPES.map((value) => ({
  value,
  label: value,
}))

export const CREATE_AS_OPTIONS: readonly SelectOption[] = Object.entries(SCHEME_CREATE_AS_LABELS).map(
  ([value, label]) => ({ value, label }),
)

/** A blank draft: today as effective-from, weekly, 06:30, holidays skipped. */
export function initialSchemeDraft(): GuidedSchemeData {
  return {
    schemeName: "",
    wasteFraction: "",
    serviceType: "",
    frequency: "weekly",
    weekRotation: "odd",
    serviceDays: [],
    effectiveFrom: todayIso(),
    effectiveTo: "",
    plannedStartTime: "06:30",
    holidayPolicy: "skip",
    createAs: "validated",
    groups: [],
  }
}
