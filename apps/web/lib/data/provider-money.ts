// The provider-money chain as the web keeps it on the Pilot (Issue #186,
// slice 11 of #81, for #148): Service Areas and their Assignments, Service
// Provider Prices with their indexation, Settlements, and weight review —
// each the module the API grants it under, read and written through
// lib/api/records/service-areas.ts, provider-prices.ts and weights.ts. This
// file is what every side of them shares: where each module lives, the prefix
// and the kind a record of it carries, and which adapter owns a record (the
// id's prefix first, then the kind a form stamped: adapter.ts, `ofKind`).
//
// The assignments are the second kind of `service-providers.service-areas`,
// the module the API grants `/service-area-assignments` under; its table
// lists the areas alone (the command surface's `shows`), and an area's
// details list its assignments, which the provider prices and the settlements
// pick from. An indexed provider price is a create of the prices module that
// names the row it indexes: the next row of the chain.
import { ofKind } from "@/lib/api/records/adapter"

import type { BusinessRecord, ModuleLocation } from "./business-modules"
import { SERVICE_AREAS_MODULE } from "./service-areas"

export { SERVICE_AREAS_MODULE }
export const PROVIDER_PRICES_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "service-provider-prices" }
export const SETTLEMENTS_MODULE: ModuleLocation = { workspaceId: "commercial", moduleId: "settlements" }
export const WEIGHTS_MODULE: ModuleLocation = { workspaceId: "route-studio", moduleId: "weights" }
/** The service providers an area is awarded to. */
export const SERVICE_PROVIDERS_MODULE: ModuleLocation = { workspaceId: "service-providers", moduleId: "service-providers" }

export const SERVICE_AREA_PREFIX = "service-area"
export const ASSIGNMENT_PREFIX = "assignment"
export const PROVIDER_PRICE_PREFIX = "provider-price"
export const SETTLEMENT_PREFIX = "settlement"
export const UNLOAD_PREFIX = "unload"

export const SERVICE_AREA_RECORD_KIND = "Service area"
export const ASSIGNMENT_RECORD_KIND = "Service area assignment"
export const PROVIDER_PRICE_RECORD_KIND = "Service provider price"
/** A price made by indexing another: the next row of its chain. */
export const INDEXED_PRICE_RECORD_KIND = "Indexed service provider price"
export const SETTLEMENT_RECORD_KIND = "Settlement"
export const UNLOAD_RECORD_KIND = "Weight record"

export const isServiceAreaRecord = ofKind(SERVICE_AREA_PREFIX, [SERVICE_AREA_RECORD_KIND])
export const isAssignmentRecord = ofKind(ASSIGNMENT_PREFIX, [ASSIGNMENT_RECORD_KIND])
export const isProviderPriceRecord = (record: Pick<BusinessRecord, "id" | "recordKind">) => ofKind(PROVIDER_PRICE_PREFIX, [PROVIDER_PRICE_RECORD_KIND, INDEXED_PRICE_RECORD_KIND])(record)
export const isSettlementRecord = ofKind(SETTLEMENT_PREFIX, [SETTLEMENT_RECORD_KIND])
export const isUnloadRecord = ofKind(UNLOAD_PREFIX, [UNLOAD_RECORD_KIND])

/** A period as a reading of a day: not yet in force, in force, or ended (ADR-0005: `validTo` is the first day out). */
export function periodReading(validFrom: string, validTo: string | null, day: string): "Upcoming" | "Active" | "Expired" {
  if (validFrom > day) return "Upcoming"
  if (validTo !== null && validTo <= day) return "Expired"
  return "Active"
}
