/**
 * The shared filter model behind every record toolbar: the one
 * `BusinessFilters` shape the filter popover variants edit, the chip labels
 * the toolbar renders active selections as, and the pure matching used by
 * surfaces that filter records outside `BusinessWorkspace` (the Route Scheme
 * detail tabs). The workspace component keeps its own per-module matching
 * with legacy-key fallbacks; both read this file for the shape and labels so
 * a new category is declared in exactly one place.
 */
import type { BusinessRecord } from "./business-modules"

export type BusinessFilters = {
  statuses: string[]
  sources: string[]
  freshness: string[]
  containerTypes: string[]
  wasteFractions: string[]
  vehicles: string[]
  drivers: string[]
  containers: string[]
  containerIds: string[]
  routes: string[]
  serviceDates: string[]
  serviceFrequencies: string[]
  routeSchemes: string[]
  collectionCalendars: string[]
  propertyTypes: string[]
  serviceAreas: string[]
  serviceScopes: string[]
  reliabilityBands: string[]
  roles: string[]
  ticketTypes: string[]
  priorities: string[]
  teams: string[]
}

export type BusinessFilterKey = keyof BusinessFilters

/**
 * Chip label per category — also the popover's category label, so the chip a
 * user removes names exactly the category they picked it from. Order is the
 * chip render order.
 */
export const BUSINESS_FILTER_CHIP_LABELS: Readonly<Record<BusinessFilterKey, string>> = {
  statuses: "Status",
  sources: "Source",
  freshness: "Freshness",
  containerTypes: "Container type",
  wasteFractions: "Waste fraction",
  vehicles: "Vehicle",
  drivers: "Driver",
  containers: "Container",
  containerIds: "Container ID",
  routes: "Route",
  serviceDates: "Service date",
  serviceFrequencies: "Service frequency",
  routeSchemes: "Route scheme",
  collectionCalendars: "Collection calendar",
  propertyTypes: "Property type",
  serviceAreas: "Service area",
  serviceScopes: "Service scope",
  reliabilityBands: "Reliability",
  roles: "Role",
  ticketTypes: "Type",
  priorities: "Priority",
  teams: "Assigned team",
}

export const BUSINESS_FILTER_KEYS = Object.keys(
  BUSINESS_FILTER_CHIP_LABELS,
) as readonly BusinessFilterKey[]

export const emptyBusinessFilters: BusinessFilters = Object.fromEntries(
  BUSINESS_FILTER_KEYS.map((key) => [key, [] as string[]]),
) as BusinessFilters

/** A single-valued fact as filter values; the "—" placeholder is no value. */
export function singleFilterValue(value: string | undefined): string[] {
  return value && value !== "—" ? [value] : []
}

/** A " · "-joined multi-valued fact (waste fractions, service scope) as values. */
export function splitFilterValues(value: string | undefined): string[] {
  if (!value || value === "—") return []
  return value
    .split(" · ")
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * How one surface reads each filterable category off a record. A category
 * without a reader is not filterable on that surface, so selections on it
 * (which its popover cannot produce) are ignored.
 */
export type FilterValueReaders = Partial<
  Record<BusinessFilterKey, (record: BusinessRecord) => string[]>
>

/** AND across categories, OR within one; empty categories always pass. */
export function matchesBusinessFilters(
  record: BusinessRecord,
  filters: BusinessFilters,
  readers: FilterValueReaders,
): boolean {
  for (const key of BUSINESS_FILTER_KEYS) {
    const selections = filters[key]
    if (selections.length === 0) continue
    const reader = readers[key]
    if (!reader) continue
    const values = reader(record)
    if (!selections.some((selection) => values.includes(selection))) return false
  }
  return true
}

/** The workspace search semantics: every display field and fact value. */
export function matchesBusinessQuery(record: BusinessRecord, query: string): boolean {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return true
  return [
    record.name,
    record.context,
    record.status,
    record.value,
    record.description,
    ...Object.values(record.facts),
    ...record.related,
  ]
    .join(" ")
    .toLowerCase()
    .includes(normalized)
}

export function applyBusinessFilters<T extends BusinessRecord>(
  records: readonly T[],
  filters: BusinessFilters,
  readers: FilterValueReaders,
  query = "",
): T[] {
  return records.filter(
    (record) =>
      matchesBusinessFilters(record, filters, readers) &&
      matchesBusinessQuery(record, query),
  )
}

export type BusinessFilterChip = { key: string; value: string }

/** Active selections as removable chips, in category order. */
export function businessFilterChips(filters: BusinessFilters): BusinessFilterChip[] {
  const chips: BusinessFilterChip[] = []
  for (const key of BUSINESS_FILTER_KEYS) {
    for (const value of filters[key]) {
      chips.push({ key: BUSINESS_FILTER_CHIP_LABELS[key], value })
    }
  }
  return chips
}

export function filterKeyForChipLabel(label: string): BusinessFilterKey | undefined {
  return BUSINESS_FILTER_KEYS.find((key) => BUSINESS_FILTER_CHIP_LABELS[key] === label)
}

/** Removes one chip's value; labels that are not business filter chips are untouched. */
export function removeBusinessFilterValue(
  filters: BusinessFilters,
  chipLabel: string,
  value: string,
): BusinessFilters {
  const key = filterKeyForChipLabel(chipLabel)
  if (!key) return filters
  return {
    ...filters,
    [key]: filters[key].filter((candidate) => candidate !== value),
  }
}
