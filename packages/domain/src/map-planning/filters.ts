// The planning map's filter readers (2026-09-16): one function per filter
// category, shared by the toolbar popover (which offers the values) and the
// map (which matches records against the picks), so both read the same
// facts — the @waste/domain/business-filters contract.

import type { BusinessRecord } from "../prototype-record"
import { singleFilterValue, splitFilterValues, type FilterValueReaders } from "../business-filters"
import { containerFractions } from "./points"

const fact = (record: BusinessRecord, key: string) => singleFilterValue(record.facts[key])

/**
 * Where the map puts the names of the schemes whose routes stop at a
 * container that names none of its own — one the API holds — as a JSON list
 * (#232, `routeSchemeIndex`): a scheme's name may hold " · " itself, so the
 * names are no joined fact. A fixture's names its one in `Route scheme`.
 */
export const ROUTE_SCHEME_NAMES_KEY = "routeSchemeNames"

function routeSchemeNames(record: BusinessRecord): string[] {
  const raw = record.submittedValues?.[ROUTE_SCHEME_NAMES_KEY]
  if (typeof raw !== "string") return fact(record, "Route scheme")
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : []
  } catch {
    return []
  }
}

/** The containers with the schemes' names the index gives each that names no scheme of its own; the rest as they are. */
export function withRouteSchemeNames(containers: readonly BusinessRecord[], index: ReadonlyMap<string, readonly string[]>): BusinessRecord[] {
  return containers.map((container) => {
    const names = index.get(container.id)
    if (names === undefined || names.length === 0 || fact(container, "Route scheme").length > 0) return container
    return { ...container, submittedValues: { ...container.submittedValues, [ROUTE_SCHEME_NAMES_KEY]: JSON.stringify(names) } }
  })
}

/** Categories in the order the popover offers them. */
export const MAP_FILTER_READERS: FilterValueReaders = {
  wasteFractions: (record) => containerFractions(record),
  containerTypes: (record) => fact(record, "Container type"),
  // Every area it lies in: one the API holds names each, joined (#232).
  planningAreas: (record) => splitFilterValues(record.facts["Planning area"]),
  statuses: (record) => singleFilterValue(record.status),
  propertyTypes: (record) => fact(record, "Property type"),
  serviceFrequencies: (record) => fact(record, "Service frequency"),
  // Every scheme whose routes stop at it: the map names them for one the API holds (#232).
  routeSchemes: routeSchemeNames,
}
