// The planning map's marker vocabulary (2026-09-16): one MapPoint per located
// container. Pure data logic over business records — positions come from
// positions.ts, the rendering from components/wastehero/map-planning.

import type { BusinessRecord } from "../prototype-record"
import { isSoftDeleted } from "../record-visibility"
import type { LngLat } from "./geo"
import { containerLocation, containerPropertyKey } from "./positions"

export type MapPoint = {
  id: string
  lngLat: LngLat
  /** Distinct waste fractions at this point, most frequent first. */
  fractions: string[]
  /** The marker's title: the container id. */
  label: string
  /** The marker's second line: the address. */
  sublabel: string
  /** The property the point belongs to — the key containers share a spot under. */
  propertyKey: string
  /** Every container the point stands for (one for a container point; several for a search hit). */
  containerIds: string[]
  /** The container record a click opens. */
  record: BusinessRecord
}

const EMPTY_FACT = "—"

/** "Residual · Mixed" → ["Residual", "Mixed"]; the empty fact → []. */
export function containerFractions(record: BusinessRecord): string[] {
  const fact = record.facts["Waste fractions"] ?? record.facts["Waste fraction"] ?? ""
  return Array.from(
    new Set(
      fact
        .split("·")
        .map((part) => part.trim())
        .filter((part) => part && part !== EMPTY_FACT),
    ),
  )
}

/** Distinct fractions across points, most frequent first, ties in first-seen order. */
export function rankFractions(lists: ReadonlyArray<readonly string[]>): string[] {
  const counts = new Map<string, number>()
  for (const list of lists) {
    for (const fraction of list) counts.set(fraction, (counts.get(fraction) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([fraction]) => fraction)
}

/** One point per located, in-service, visible container. */
export function containerPoints(containers: readonly BusinessRecord[]): MapPoint[] {
  const points: MapPoint[] = []
  for (const record of containers) {
    if (isSoftDeleted(record)) continue
    const lngLat = containerLocation(record)
    const propertyKey = containerPropertyKey(record)
    if (!lngLat || !propertyKey) continue
    points.push({
      id: record.id,
      lngLat,
      fractions: containerFractions(record),
      label: record.facts["Container ID"] ?? record.name,
      sublabel: record.facts.Address ?? propertyKey,
      propertyKey,
      containerIds: [record.id],
      record,
    })
  }
  return points
}
