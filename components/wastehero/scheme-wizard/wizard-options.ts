// Option vocabularies the guided setup shows, and the draft defaults it
// opens with. The frequency options are the product's four cadences mapped
// onto the engine's (frequency, weekRotation) pair.

import { SCHEME_CREATE_AS_LABELS, SCHEME_EDIT_POLICY_LABELS } from "@/lib/route-schemes/creation"
import { HOLIDAY_POLICIES, HOLIDAY_POLICY_LABELS } from "@/lib/route-schemes/occurrences"
import type { GuidedSchemeData } from "@/lib/route-schemes/quick-create"
import { todayIso } from "@/lib/route-schemes/recurrence"

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

export type WizardFrequencyValue = "weekly" | "biweekly-even" | "biweekly-odd" | "every-4-weeks"

export const WIZARD_FREQUENCIES: readonly { value: WizardFrequencyValue; label: string }[] = [
  { value: "weekly", label: "Every week" },
  { value: "biweekly-even", label: "Every 2 weeks (even ISO weeks)" },
  { value: "biweekly-odd", label: "Every 2 weeks (odd ISO weeks)" },
  { value: "every-4-weeks", label: "Every 4 weeks" },
]

/** The select value for the draft's cadence; empty for a cadence the wizard does not offer. */
export function wizardFrequencyValue(
  data: Pick<GuidedSchemeData, "frequency" | "weekRotation">,
): WizardFrequencyValue | "" {
  if (data.frequency === "weekly") return "weekly"
  if (data.frequency === "every-4-weeks") return "every-4-weeks"
  if (data.frequency === "every-2-weeks") {
    return data.weekRotation === "even" ? "biweekly-even" : "biweekly-odd"
  }
  return ""
}

export function applyWizardFrequency(value: string): Pick<GuidedSchemeData, "frequency" | "weekRotation"> {
  switch (value) {
    case "biweekly-even":
      return { frequency: "every-2-weeks", weekRotation: "even" }
    case "biweekly-odd":
      return { frequency: "every-2-weeks", weekRotation: "odd" }
    case "every-4-weeks":
      return { frequency: "every-4-weeks", weekRotation: "odd" }
    default:
      return { frequency: "weekly", weekRotation: "odd" }
  }
}

export const HOLIDAY_POLICY_OPTIONS: readonly SelectOption[] = HOLIDAY_POLICIES.map((value) => ({
  value,
  label: HOLIDAY_POLICY_LABELS[value],
}))

export const CREATE_AS_OPTIONS: readonly SelectOption[] = Object.entries(SCHEME_CREATE_AS_LABELS).map(
  ([value, label]) => ({ value, label }),
)

export const EDIT_POLICY_OPTIONS: readonly SelectOption[] = Object.entries(
  SCHEME_EDIT_POLICY_LABELS,
).map(([value, label]) => ({ value, label }))

/** A blank draft: today as effective-from, weekly, 06:30, holidays skipped. */
export function initialSchemeDraft(): GuidedSchemeData {
  return {
    schemeName: "",
    frequency: "weekly",
    weekRotation: "odd",
    serviceDays: [],
    effectiveFrom: todayIso(),
    effectiveTo: "",
    plannedStartTime: "06:30",
    holidayPolicy: "skip",
    createAs: "validated",
    editPolicy: "ask",
    groups: [],
  }
}
