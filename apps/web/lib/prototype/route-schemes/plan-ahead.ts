// Plan Ahead (ticket #8): a scheme flag (submittedValues.planAhead + a "Plan
// ahead" fact) the nightly plan-ahead run reads — flipping it never touches
// generated routes.

import type { BusinessRecord } from "../prototype-record"

export function isPlanAheadEnabled(scheme: BusinessRecord): boolean {
  const value = scheme.submittedValues?.planAhead
  return value === true || value === "true"
}

export function setPlanAhead(
  scheme: BusinessRecord,
  enabled: boolean,
): BusinessRecord {
  return {
    ...scheme,
    updated: "Now",
    freshness: "Now",
    facts: { ...scheme.facts, "Plan ahead": enabled ? "On" : "Off" },
    submittedValues: { ...scheme.submittedValues, planAhead: enabled },
  }
}
