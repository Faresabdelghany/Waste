// Coverage gaps (2026-09-16): which containers that need service no Route
// Scheme lists, and which scheme stops fall on containers that cannot be
// served. A container needs service when it is Available and its Agreement
// fact does not say ended, paused, or future (no fact at all is not a reason
// to skip it). A container is covered when a scheme that still takes part in
// planning and is Validated, Scheduled, or Effective resolves it as a stop on
// any service day — through @waste/domain/route-schemes/groups, the one seam every
// consumer resolves a scheme's stops through. Drafts promise nothing and
// expired schemes no longer do. Pure data logic.

import type { BusinessRecord } from "../data/business-modules"
import { effectiveStopPlans } from "@waste/domain/route-schemes/groups"
import { effectiveSchemeStatus, schemesInPlanning } from "@waste/domain/route-schemes/lifecycle"
import { ELIGIBLE_CONTAINER_STATUSES } from "@waste/domain/route-schemes/matching"
import { recurrenceFromValues } from "@waste/domain/route-schemes/recurrence"

export type CoverageGaps = {
  /** Containers that need service. */
  needing: ReadonlySet<string>
  /** Needing containers some counting scheme lists. */
  covered: ReadonlySet<string>
  /** Needing containers no counting scheme lists. */
  uncovered: ReadonlySet<string>
  /** Scheme stops on containers that do not need service (defect, ended agreement, …). */
  unservable: ReadonlySet<string>
  /** Schemes whose stops counted. */
  schemesConsidered: number
}

export type CoverageCounts = { needing: number; covered: number; uncovered: number; unservable: number }

const INACTIVE_AGREEMENT = /·\s*(ended|paused|future|cancelled|terminated)\b/i

/** Available, and the agreement fact — when there is one — does not say the service is off. */
export function needsService(container: Pick<BusinessRecord, "status" | "facts">): boolean {
  if (!ELIGIBLE_CONTAINER_STATUSES.has(container.status)) return false
  return !INACTIVE_AGREEMENT.test(container.facts.Agreement ?? "")
}

const COUNTING_STATUSES = new Set(["Validated", "Scheduled", "Effective"])

export function coverageGaps(
  containers: readonly BusinessRecord[],
  schemes: readonly BusinessRecord[],
  today: string,
): CoverageGaps {
  const needing = new Set(containers.filter(needsService).map((container) => container.id))
  const known = new Set(containers.map((container) => container.id))

  const planned = new Set<string>()
  let schemesConsidered = 0
  for (const scheme of schemesInPlanning(schemes)) {
    if (!COUNTING_STATUSES.has(effectiveSchemeStatus(scheme, today))) continue
    const recurrence = recurrenceFromValues(scheme.submittedValues ?? {})
    if (!recurrence) continue
    schemesConsidered += 1
    for (const plan of effectiveStopPlans(scheme, recurrence.serviceDays, containers)) {
      for (const containerId of plan.containerIds) {
        if (known.has(containerId)) planned.add(containerId)
      }
    }
  }

  const covered = new Set([...needing].filter((id) => planned.has(id)))
  const uncovered = new Set([...needing].filter((id) => !planned.has(id)))
  const unservable = new Set([...planned].filter((id) => !needing.has(id)))
  return { needing, covered, uncovered, unservable, schemesConsidered }
}

/** The gap sets counted over one selection. */
export function coverageInSelection(gaps: CoverageGaps, selectedIds: ReadonlySet<string>): CoverageCounts {
  const count = (set: ReadonlySet<string>) => [...selectedIds].filter((id) => set.has(id)).length
  return {
    needing: count(gaps.needing),
    covered: count(gaps.covered),
    uncovered: count(gaps.uncovered),
    unservable: count(gaps.unservable),
  }
}

/** The ring an uncovered container's marker wears, and the cluster badge. */
export const UNCOVERED_COLOR = "#dc2626"
