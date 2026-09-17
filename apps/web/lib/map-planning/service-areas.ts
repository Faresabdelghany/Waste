// Service Areas on the planning map (2026-09-16): the create seed a
// selection hands to the Service Area form (project when uniform, the
// planning areas the containers name, a boundary line, and the drawn
// polygon as a typed value the form never shows), the stored polygon read
// back, and the layers the Layers control can switch on. Only areas created
// from the map carry a polygon; fixture areas are covered through their
// planning areas (coverage.ts). Pure data logic.

import type { BusinessFormValues } from "../data/business-form-types"
import type { BusinessRecord } from "../data/business-modules"
import { isSoftDeleted } from "../data/record-visibility"
import { boundsFromPolygon, type LngLat, type LngLatBounds } from "./geo"
import type { SelectionShape } from "./selection"

/** Where Service Areas live — the module the create dialog targets. */
export const SERVICE_AREAS_MODULE = { workspaceId: "service-providers", moduleId: "service-areas" } as const

/** The typed value a map-drawn service area keeps its boundary under (JSON LngLat[]). */
export const SERVICE_AREA_POLYGON_KEY = "boundaryPolygon"

export type ServiceAreaSeed = {
  /** Values the form shows and the user can change. */
  initialValues: BusinessFormValues
  /** Values stored on the record without a form field — the polygon. */
  extraValues: BusinessFormValues
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

const EMPTY_FACT = "—"
const clean = (value: string | boolean | undefined): string | undefined => {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed && trimmed !== EMPTY_FACT ? trimmed : undefined
}

const isLngLat = (value: unknown): value is LngLat =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as LngLat).lng === "number" &&
  typeof (value as LngLat).lat === "number"

/** The polygon a service area was drawn with, or null when it has none the map can use. */
export function serviceAreaPolygon(area: BusinessRecord): LngLat[] | null {
  const raw = clean(area.submittedValues?.[SERVICE_AREA_POLYGON_KEY])
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length < 3 || !parsed.every(isLngLat)) return null
    return parsed.map((point) => ({ lng: point.lng, lat: point.lat }))
  } catch {
    return null
  }
}

function uniform<T>(values: readonly (T | undefined)[]): T | undefined {
  const first = values[0]
  return first !== undefined && values.every((value) => value === first) ? first : undefined
}

/** The planning-area ids the selected containers name — typed id first, display fact second. */
function planningAreaIds(selected: readonly BusinessRecord[], planningAreas: readonly BusinessRecord[]): string[] {
  const byName = new Map(planningAreas.map((area) => [area.name.trim().toLowerCase(), area.id]))
  const known = new Set(planningAreas.map((area) => area.id))
  const named = new Set<string>()
  for (const container of selected) {
    const typed = clean(container.submittedValues?.planningAreaId)
    if (typed && known.has(typed)) {
      named.add(typed)
      continue
    }
    const fact = clean(container.facts["Planning area"])
    const id = fact ? byName.get(fact.toLowerCase()) : undefined
    if (id) named.add(id)
  }
  return planningAreas.map((area) => area.id).filter((id) => named.has(id))
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

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
  const initialValues: BusinessFormValues = {}
  const project = uniform(
    selected.map(
      (container) =>
        clean(container.submittedValues?.projectId) ??
        (container.projectIds?.length === 1 ? container.projectIds[0] : undefined),
    ),
  )
  if (project) initialValues.projectId = project
  const zones = planningAreaIds(selected, planningAreas)
  if (zones.length) initialValues.zoneIds = zones.join(",")
  initialValues.boundary = `${shape ? "Drawn" : "Selected"} on Map Planning · ${plural(selected.length, "container")} across ${plural(properties, "property").replace("propertys", "properties")}`
  const extraValues: BusinessFormValues = shape ? { [SERVICE_AREA_POLYGON_KEY]: JSON.stringify(shape.polygon) } : {}
  return { initialValues, extraValues }
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
      serviceProvider: clean(area.facts["Service provider"]) ?? "Unassigned",
      status: area.status,
      color: SERVICE_AREA_LAYER_PALETTE[layers.length % SERVICE_AREA_LAYER_PALETTE.length],
      polygon,
      bounds: boundsFromPolygon(polygon),
    })
  }
  return layers
}
