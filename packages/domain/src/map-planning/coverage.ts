// What already covers a map selection (2026-09-16): the Service Areas whose
// planning areas hold the selected containers, or whose drawn boundary
// contains them. Read, never guessed — a container names its planning area
// (typed id, else the display fact); a service area names its planning areas
// through the zoneIds reference (typed, else the relation refs) and, when it
// was created from the map, keeps its polygon (service-areas.ts). The dated
// Routes over a selection live in routes.ts. Pure data logic for the
// Selected area panel.

import type { BusinessRecord } from "../prototype-record"
import { EMPTY_FACT, cleanFact, typedString } from "../record-values"
import { isSoftDeleted } from "../record-visibility"
import { pointInPolygon } from "./geo"
import { containerLocation, type Gazetteer } from "./positions"
import { serviceAreaPolygon } from "./service-areas"

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
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const id of typedString(area.submittedValues, "zoneIds")?.split(",") ?? []) {
    if (id.trim()) ids.add(id.trim())
  }
  for (const ref of area.relationRefs ?? []) {
    if (ref.fieldId !== "zoneIds") continue
    ids.add(ref.recordId)
    names.add(lower(ref.label))
  }
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
  const rows: ServiceAreaCoverage[] = []
  for (const area of serviceAreas) {
    if (isSoftDeleted(area)) continue
    const zones = serviceAreaZones(area)
    const polygon = serviceAreaPolygon(area)
    const count = containers.filter((container) => {
      if (polygon) {
        const spot = containerLocation(container, gazetteer)
        if (spot && pointInPolygon(spot, polygon)) return true
      }
      const typed = typedString(container.submittedValues, "planningAreaId")
      if (typed) return zones.ids.has(typed)
      const fact = cleanFact(container.facts["Planning area"])
      return fact ? zones.names.has(lower(fact)) : false
    }).length
    if (count === 0) continue
    rows.push({
      id: area.id,
      name: area.name,
      serviceProvider: cleanFact(area.facts["Service provider"]) ?? EMPTY_FACT,
      status: area.status,
      services: cleanFact(area.facts.Services) ?? EMPTY_FACT,
      containers: count,
    })
  }
  return rows.sort((a, b) => b.containers - a.containers || a.name.localeCompare(b.name))
}
