// The planning map's filter readers (2026-09-16): one function per filter
// category, shared by the toolbar popover (which offers the values) and the
// map (which matches records against the picks), so both read the same
// facts — the @waste/domain/business-filters contract.

import type { BusinessRecord } from "../prototype-record"
import { singleFilterValue, type FilterValueReaders } from "../business-filters"
import { containerAreaRefs } from "../route-schemes/matching"
import { containerFractions } from "./points"

const fact = (record: BusinessRecord, key: string) => singleFilterValue(record.facts[key])

/** Categories in the order the popover offers them. */
export const MAP_FILTER_READERS: FilterValueReaders = {
  wasteFractions: (record) => containerFractions(record),
  containerTypes: (record) => fact(record, "Container type"),
  // Every area it lies in today, by name (`containerAreaRefs`, #232): a name holding " · " stays whole.
  planningAreas: (record) => containerAreaRefs(record).names,
  statuses: (record) => singleFilterValue(record.status),
  propertyTypes: (record) => fact(record, "Property type"),
  serviceFrequencies: (record) => fact(record, "Service frequency"),
  routeSchemes: (record) => fact(record, "Route scheme"),
}

/**
 * The map's readers where the routes name the schemes a container is
 * collected by (#232): a container that names no scheme of its own — one the
 * API holds — is read by the names `schemesByContainer` gives it
 * (`routeSchemeIndex`), kept as a list, since a scheme's name may hold " · ".
 */
export function mapFilterReaders(schemesByContainer: ReadonlyMap<string, readonly string[]>): FilterValueReaders {
  return {
    ...MAP_FILTER_READERS,
    routeSchemes: (record) => {
      const own = fact(record, "Route scheme")
      return own.length > 0 ? own : [...(schemesByContainer.get(record.id) ?? [])]
    },
  }
}
