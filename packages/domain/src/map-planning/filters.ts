// The planning map's filter readers (2026-09-16): one function per filter
// category, shared by the toolbar popover (which offers the values) and the
// map (which matches records against the picks), so both read the same
// facts — the @waste/domain/business-filters contract.

import type { BusinessRecord } from "../prototype-record"
import { singleFilterValue, type FilterValueReaders } from "../business-filters"
import { containerFractions } from "./points"

const fact = (record: BusinessRecord, key: string) => singleFilterValue(record.facts[key])

/** Categories in the order the popover offers them. */
export const MAP_FILTER_READERS: FilterValueReaders = {
  wasteFractions: (record) => containerFractions(record),
  containerTypes: (record) => fact(record, "Container type"),
  planningAreas: (record) => fact(record, "Planning area"),
  statuses: (record) => singleFilterValue(record.status),
  propertyTypes: (record) => fact(record, "Property type"),
  serviceFrequencies: (record) => fact(record, "Service frequency"),
  routeSchemes: (record) => fact(record, "Route scheme"),
}
