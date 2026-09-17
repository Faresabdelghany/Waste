// Service Areas on the planning map (2026-09-16): the create seed a
// selection hands to the Service Area form (project when uniform, the
// planning areas the containers name, a boundary line, and the drawn
// polygon), the stored polygon read back, and the layers the Layers control
// can switch on. Only areas created from the map carry a polygon; fixture
// areas are covered through their planning areas (coverage.ts). The seed is
// typed (issue #58): which form field each value lands in is the web's to
// decide, since the form schema lives there — apps/web/lib/data/service-areas.ts
// maps it. Pure data logic.

import type { BusinessRecord } from "../prototype-record"
import { cleanFact, typedString, uniform } from "../record-values"
import { isSoftDeleted } from "../record-visibility"
import { count } from "../text"
import { boundsFromPolygon, type LngLat, type LngLatBounds } from "./geo"
import type { SelectionShape } from "./selection"

/**
 * The typed value a map-drawn service area keeps its boundary under. Not a
 * form field: the web stores it beside the form's values, spelled by
 * serviceAreaPolygonValue, and serviceAreaPolygon reads it back.
 */
export const SERVICE_AREA_POLYGON_KEY = "boundaryPolygon"

/** What a selection proposes for a new Service Area. */
export type ServiceAreaSeed = {
  /** The project every selected container belongs to, or null when they disagree or say nothing. */
  projectId: string | null
  /** The planning areas the selected containers name, in planning-area order. */
  planningAreaIds: string[]
  /** The boundary description the form shows: how the area was picked and what it holds. */
  boundary: string
  /** The drawn polygon, or null for a hand-picked selection. */
  polygon: LngLat[] | null
}

export type ServiceAreaLayer = {
  id: string
  name: string
  serviceProvider: string
  status: string
  color: string
  polygon: LngLat[]
  bounds: LngLatBounds
}

/** Outline colours for drawn service areas, cycled in list order. */
export const SERVICE_AREA_LAYER_PALETTE = ["#0f766e", "#b45309", "#6d28d9", "#be123c", "#1d4ed8", "#4d7c0f"] as const

const isLngLat = (value: unknown): value is LngLat =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as LngLat).lng === "number" &&
  typeof (value as LngLat).lat === "number"

/** The stored spelling of a drawn polygon — what serviceAreaPolygon reads back. */
export function serviceAreaPolygonValue(polygon: readonly LngLat[]): string {
  return JSON.stringify(polygon.map((point) => ({ lng: point.lng, lat: point.lat })))
}

/** The polygon a service area was drawn with, or null when it has none the map can use. */
export function serviceAreaPolygon(area: BusinessRecord): LngLat[] | null {
  const raw = cleanFact(area.submittedValues?.[SERVICE_AREA_POLYGON_KEY])
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length < 3 || !parsed.every(isLngLat)) return null
    return parsed.map((point) => ({ lng: point.lng, lat: point.lat }))
  } catch {
    return null
  }
}

/** The planning-area ids the selected containers name — typed id first, display fact second. */
function planningAreaIds(selected: readonly BusinessRecord[], planningAreas: readonly BusinessRecord[]): string[] {
  const byName = new Map(planningAreas.map((area) => [area.name.trim().toLowerCase(), area.id]))
  const known = new Set(planningAreas.map((area) => area.id))
  const named = new Set<string>()
  for (const container of selected) {
    const typed = typedString(container.submittedValues, "planningAreaId")
    if (typed && known.has(typed)) {
      named.add(typed)
      continue
    }
    const fact = cleanFact(container.facts["Planning area"])
    const id = fact ? byName.get(fact.toLowerCase()) : undefined
    if (id) named.add(id)
  }
  return planningAreas.map((area) => area.id).filter((id) => named.has(id))
}

export function serviceAreaSeedFromSelection({
  selected,
  shape,
  planningAreas,
  properties,
}: {
  selected: readonly BusinessRecord[]
  shape: SelectionShape | null
  planningAreas: readonly BusinessRecord[]
  properties: number
}): ServiceAreaSeed {
  // Typed project first, record scope second — the same order the wizard seed uses.
  const project = uniform(
    selected.map(
      (container) =>
        typedString(container.submittedValues, "projectId") ??
        (container.projectIds?.length === 1 ? container.projectIds[0] : undefined),
    ),
  )
  return {
    projectId: project ?? null,
    planningAreaIds: planningAreaIds(selected, planningAreas),
    boundary: `${shape ? "Drawn" : "Selected"} on Map Planning · ${count(selected.length, "container")} across ${count(properties, "property")}`,
    polygon: shape ? shape.polygon.map((point) => ({ lng: point.lng, lat: point.lat })) : null,
  }
}

/** One layer per visible service area that carries a polygon, in record order. */
export function serviceAreaLayers(serviceAreas: readonly BusinessRecord[]): ServiceAreaLayer[] {
  const layers: ServiceAreaLayer[] = []
  for (const area of serviceAreas) {
    if (isSoftDeleted(area)) continue
    const polygon = serviceAreaPolygon(area)
    if (!polygon) continue
    layers.push({
      id: area.id,
      name: area.name,
      serviceProvider: cleanFact(area.facts["Service provider"]) ?? "Unassigned",
      status: area.status,
      color: SERVICE_AREA_LAYER_PALETTE[layers.length % SERVICE_AREA_LAYER_PALETTE.length],
      polygon,
      bounds: boundsFromPolygon(polygon),
    })
  }
  return layers
}
