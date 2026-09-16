// What a map selection means (2026-09-16): its fraction summary, and the
// Guided Setup draft it seeds — only what every selected container agrees
// on, so the wizard never inherits a guess. The Selected area panel's
// numbers live in statistics.ts. Pure data logic.

import type { GuidedSchemeData } from "../route-schemes/quick-create"
import type { LngLat } from "./geo"
import type { MapPoint } from "./points"
import { rankFractions } from "./points"

export type SelectionSummary = {
  containers: number
  properties: number
  /** [fraction, container count], most frequent first. */
  byFraction: Array<[string, number]>
}

/** The selected points. */
export function selectedPoints(
  points: readonly MapPoint[],
  selectedIds: ReadonlySet<string>,
): MapPoint[] {
  return points.filter((point) => selectedIds.has(point.id))
}

export function selectionSummary(
  points: readonly MapPoint[],
  selectedIds: ReadonlySet<string>,
): SelectionSummary {
  const selected = selectedPoints(points, selectedIds)
  const counts = new Map<string, number>()
  let containers = 0
  for (const point of selected) {
    containers += point.containerIds.length
    for (const fraction of point.fractions) {
      counts.set(fraction, (counts.get(fraction) ?? 0) + point.containerIds.length)
    }
  }
  const ranked = rankFractions(selected.map((point) => point.fractions))
  return {
    containers,
    properties: new Set(selected.map((point) => point.propertyKey)).size,
    byFraction: ranked.map((fraction) => [fraction, counts.get(fraction) ?? 0]),
  }
}

/** The one value everything agrees on, or undefined. */
function uniform(values: ReadonlyArray<string | undefined>): string | undefined {
  const present = values.filter((value): value is string => Boolean(value))
  if (present.length === 0 || present.length !== values.length) return undefined
  return present.every((value) => value === present[0]) ? present[0] : undefined
}

const typedString = (point: MapPoint, key: string): string | undefined => {
  const value = point.record.submittedValues?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Seeds the Guided Setup wizard from a selection: the waste fraction when
 * every selected container carries exactly one and the same fraction, the
 * planning area when every container is typed to the same one, and the
 * project when it is uniform — typed first, record scope second.
 */
export function schemeDraftFromSelection(
  points: readonly MapPoint[],
  selectedIds: ReadonlySet<string>,
): Partial<GuidedSchemeData> {
  const selected = selectedPoints(points, selectedIds)
  if (selected.length === 0) return {}
  const draft: Partial<GuidedSchemeData> = {}

  const fraction = uniform(
    selected.map((point) => (point.fractions.length === 1 ? point.fractions[0] : undefined)),
  )
  if (fraction) draft.wasteFraction = fraction

  const area = uniform(selected.map((point) => typedString(point, "planningAreaId")))
  if (area) draft.planningAreaId = area

  const project = uniform(
    selected.map(
      (point) =>
        typedString(point, "projectId") ??
        (point.record.projectIds?.length === 1 ? point.record.projectIds[0] : undefined),
    ),
  )
  if (project) draft.projectId = project

  return draft
}

/** The shape a selection was drawn with — kept so the panel can name it and the map can edit it. */
export type SelectionShape = {
  kind: "rectangle" | "polygon"
  polygon: LngLat[]
}
