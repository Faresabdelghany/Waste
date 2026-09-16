// The planning map's marker vocabulary (2026-09-16): one MapPoint per located
// container, or one per property when the map is in Properties mode. Pure
// data logic over business records — positions come from positions.ts, the
// rendering from components/wastehero/map-planning.

import type { BusinessRecord } from "../data/business-modules"
import { isSoftDeleted } from "../data/record-visibility"
import type { LngLat } from "./geo"
import { containerLocation, containerPropertyKey } from "./positions"

export type MapPointKind = "container" | "property"

export type MapPoint = {
  id: string
  kind: MapPointKind
  lngLat: LngLat
  /** Distinct waste fractions at this point, most frequent first. */
  fractions: string[]
  /** The marker's title: the container id or the property name. */
  label: string
  /** The marker's second line: the address, or the container count. */
  sublabel: string
  /** The property the point belongs to — the key containers share a spot under. */
  propertyKey: string
  /** Every container the point stands for (one for a container point). */
  containerIds: string[]
  /** The record a click opens: the container, or the property when one exists. */
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
      kind: "container",
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

function propertyRecordFor(
  key: string,
  properties: readonly BusinessRecord[],
): BusinessRecord | undefined {
  const lower = key.toLowerCase()
  return properties.find(
    (property) =>
      !isSoftDeleted(property) &&
      (property.name.trim().toLowerCase() === lower ||
        (property.facts.ServiceAddress ?? "").trim().toLowerCase().startsWith(lower)),
  )
}

/** One point per property: its containers, their distinct fractions, and the property record when one exists. */
export function propertyPoints(
  containers: readonly BusinessRecord[],
  properties: readonly BusinessRecord[],
): MapPoint[] {
  const groups = new Map<string, MapPoint[]>()
  for (const point of containerPoints(containers)) {
    const group = groups.get(point.propertyKey)
    if (group) group.push(point)
    else groups.set(point.propertyKey, [point])
  }
  return Array.from(groups.entries()).map(([key, members]) => {
    const property = propertyRecordFor(key, properties)
    const address = members[0].record.facts.Address ?? key
    return {
      id: property ? property.id : `property:${key}`,
      kind: "property" as const,
      lngLat: members[0].lngLat,
      fractions: rankFractions(members.map((member) => member.fractions)),
      label: key,
      sublabel: `${members.length} container${members.length === 1 ? "" : "s"} · ${address}`,
      propertyKey: key,
      containerIds: members.map((member) => member.id),
      record: property ?? members[0].record,
    }
  })
}
