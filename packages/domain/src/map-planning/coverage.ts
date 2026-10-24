// What already covers a map selection (2026-09-16): the Service Areas whose
// planning areas hold the selected containers, or whose drawn boundary
// contains them. Read, never guessed — a container names its planning areas
// today (`containerAreaRefs`: by id, else by name; every one its serving
// placement lies in, for one the API holds, #232); a service area names its planning areas
// through the zoneIds reference (typed, else the relation refs) and, when it
// was created from the map, keeps its polygon (service-areas.ts). The dated
// Routes over a selection live in routes.ts. Pure data logic for the
// Selected area panel.

import type { BusinessRecord } from "../prototype-record"
import { EMPTY_FACT, cleanFact } from "../record-values"
import { isSoftDeleted } from "../record-visibility"
import { containerAreaRefs } from "../route-schemes/matching"
import { pointInPolygon } from "./geo"
import { containerLocation, type Gazetteer } from "./positions"
import { serviceAreaPolygon, serviceAreaZoneIds } from "./service-areas"

export type ServiceAreaCoverage = {
  id: string
  name: string
  serviceProvider: string
  status: string
  services: string
  /** Selected containers inside the area's planning areas. */
  containers: number
}

const lower = (value: string) => value.trim().toLowerCase()

/** The planning-area ids a service area covers, plus the names its refs and facts carry. */
function serviceAreaZones(area: BusinessRecord): { ids: Set<string>; names: Set<string> } {
  const ids = new Set(serviceAreaZoneIds(area))
  const names = new Set<string>()
  for (const ref of area.relationRefs ?? []) if (ref.fieldId === "zoneIds") names.add(lower(ref.label))
  for (const name of cleanFact(area.facts["Planning areas"])?.split(/[·,]/) ?? []) {
    if (name.trim()) names.add(lower(name))
  }
  return { ids, names }
}

export function serviceAreasForSelection(
  containers: readonly BusinessRecord[],
  serviceAreas: readonly BusinessRecord[],
  gazetteer: Gazetteer,
): ServiceAreaCoverage[] {
  if (containers.length === 0) return []
  // Where each container lies today, read once rather than once per service area (`containerAreaRefs`).
  const read = containers.map((container) => ({ container, refs: containerAreaRefs(container) }))
  const rows: ServiceAreaCoverage[] = []
  for (const area of serviceAreas) {
    if (isSoftDeleted(area)) continue
    const zones = serviceAreaZones(area)
    const polygon = serviceAreaPolygon(area)
    const count = read.filter(({ container, refs }) => {
      if (polygon) {
        const spot = containerLocation(container, gazetteer)
        if (spot && pointInPolygon(spot, polygon)) return true
      }
      if (refs.ids.length > 0) return refs.ids.some((id) => zones.ids.has(id))
      return refs.names.some((name) => zones.names.has(lower(name)))
    }).length
    if (count === 0) continue
    rows.push({
      id: area.id,
      name: area.name,
      serviceProvider: cleanFact(area.facts["Service provider"]) ?? EMPTY_FACT,
      status: area.status,
      services: cleanFact(area.facts.Services) ?? cleanFact(area.facts["Waste fractions"]) ?? EMPTY_FACT,
      containers: count,
    })
  }
  return rows.sort((a, b) => b.containers - a.containers || a.name.localeCompare(b.name))
}
