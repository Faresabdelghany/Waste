// Scheme detail page (D9, D17): what its tabs read off the scheme and the
// routes and stops generated for it, and the derivations that let the Routes
// and Stops tabs render and filter through the shared filter model
// (lib/prototype/business-filters) exactly like the workspace record tables.
//
// A generated route carries no waste-fraction fact of its own — its fractions
// are whatever the Stops still in its plan serve, read live so a Stop
// reassignment or a regeneration is reflected immediately. Generated Stops
// carry no date of their own either — the Stops tab projects the dated
// route's operating date onto each one. Both projections are render-time
// only and are never written back to the store.
//
// Reader declaration order is the category order the filter popover shows.
import type { BusinessRecord } from "../prototype-record"
import {
  singleFilterValue,
  splitFilterValues,
  type FilterValueReaders,
} from "../business-filters"
import { EMPTY_FACT } from "../record-values"
import { stringValue } from "./validation"

/** Fact the Routes tab exposes derived fractions under — the containers convention. */
const ROUTE_FRACTIONS_FACT = "Waste fractions"
/** Fact the Stops tab exposes the route's operating date under (ISO date). */
const STOP_SERVICE_DATE_FACT = "Service date"

/** A record's submitted value as a non-empty string, else undefined. */
export const stringValueOf = (
  record: BusinessRecord,
  key: string,
): string | undefined => stringValue(record.submittedValues ?? {}, key)

/** "v6 draft" → "v6"; absent → "v1". */
export function schemeVersionOf(scheme: BusinessRecord): string {
  const version = scheme.facts?.Version?.trim().split(/\s+/)[0]
  return version || "v1"
}

/**
 * The scheme's planned start time, or undefined when it has none (issue
 * #32): submittedValues win over the legacy "Planned start" fact, both are
 * trimmed, and the "—" display placeholder counts as absent — a scheme
 * without one shows "—".
 */
export function schemePlannedStartTime(
  scheme: BusinessRecord,
): string | undefined {
  const raw =
    stringValueOf(scheme, "plannedStartTime")?.trim() ||
    scheme.facts?.["Planned start"]?.trim()
  return raw && raw !== EMPTY_FACT ? raw : undefined
}

/**
 * The note a route detail shows for its `Deviation` fact (issue #26): the
 * stamped fact other than "None", read from the record alone so every
 * presentation path agrees. A route with the "None" placeholder or no fact
 * renders no deviation row.
 */
export function routeDeviationNote(route: BusinessRecord): string | null {
  const stamped = route.facts.Deviation?.trim()
  return stamped && stamped !== "None" ? stamped : null
}

/** The routes one scheme generated, sorted by service date. */
export function schemeGeneratedRoutes(
  schemeId: string,
  routes: readonly BusinessRecord[],
): BusinessRecord[] {
  return routes
    .filter((route) => stringValueOf(route, "schemeId") === schemeId)
    .sort((a, b) =>
      (stringValueOf(a, "serviceDate") ?? "").localeCompare(
        stringValueOf(b, "serviceDate") ?? "",
      ),
    )
}

/** The Stops in a dated route's plan: linked by structured routeId. */
function plannedRouteStops(
  route: BusinessRecord,
  pickups: readonly BusinessRecord[],
): BusinessRecord[] {
  return pickups.filter((pickup) => stringValueOf(pickup, "routeId") === route.id)
}

/** The waste fractions a route serves: the sorted union over its planned Stops. */
export function routeWasteFractions(
  route: BusinessRecord,
  pickups: readonly BusinessRecord[],
): string[] {
  const fractions = plannedRouteStops(route, pickups).flatMap((stop) =>
    splitFilterValues(stop.facts["Waste fraction"]),
  )
  return Array.from(new Set(fractions)).sort((left, right) =>
    left.localeCompare(right),
  )
}

/** Render-time projection: the route with its derived fractions as a fact. */
export function withRouteWasteFractions(
  route: BusinessRecord,
  pickups: readonly BusinessRecord[],
): BusinessRecord {
  const fractions = routeWasteFractions(route, pickups)
  if (fractions.length === 0) return route
  return {
    ...route,
    facts: { ...route.facts, [ROUTE_FRACTIONS_FACT]: fractions.join(" · ") },
  }
}

/** The projected fractions of a route row — the table cell and the filter read this. */
export function routeWasteFractionsLabel(route: BusinessRecord): string | undefined {
  return route.facts[ROUTE_FRACTIONS_FACT]
}

/** Render-time projection: the Stop with its route's operating date as a fact. */
export function withStopServiceDate(
  pickup: BusinessRecord,
  isoDate: string | undefined,
): BusinessRecord {
  if (!isoDate) return pickup
  return { ...pickup, facts: { ...pickup.facts, [STOP_SERVICE_DATE_FACT]: isoDate } }
}

/**
 * The container a Stop serves, as the street line of its address; a Stop
 * without an address shows its Container ID — the same fallback the
 * generated Stop name uses.
 */
export function schemeStopContainerLabel(pickup: BusinessRecord): string | undefined {
  const street = pickup.facts.Address?.split(",")[0]?.trim()
  return street || pickup.facts["Container ID"] || undefined
}

/** Generated Stops store "Container Type"; the lower-case key covers rows copied from container facts. */
export function schemeStopContainerType(pickup: BusinessRecord): string | undefined {
  return pickup.facts["Container Type"] ?? pickup.facts["Container type"]
}

/** Routes tab: Waste fraction · Vehicle · Driver. */
export const SCHEME_ROUTE_FILTER_READERS: FilterValueReaders = {
  wasteFractions: (record) => splitFilterValues(routeWasteFractionsLabel(record)),
  vehicles: (record) => singleFilterValue(record.facts.Vehicle),
  drivers: (record) => singleFilterValue(record.facts.Driver),
}

/**
 * Stops tab: Container · Container ID · Container type · Status · Waste
 * fraction · Driver, then Route and Service date so D9's route/date filters
 * live in the shared popover.
 */
export const SCHEME_STOP_FILTER_READERS: FilterValueReaders = {
  containers: (record) => singleFilterValue(schemeStopContainerLabel(record)),
  containerIds: (record) => singleFilterValue(record.facts["Container ID"]),
  containerTypes: (record) => singleFilterValue(schemeStopContainerType(record)),
  statuses: (record) => [record.status],
  wasteFractions: (record) =>
    splitFilterValues(record.facts["Waste fraction"] ?? record.facts["Waste fractions"]),
  drivers: (record) => singleFilterValue(record.facts.Driver),
  routes: (record) => singleFilterValue(record.facts.Route),
  serviceDates: (record) => singleFilterValue(record.facts[STOP_SERVICE_DATE_FACT]),
}
