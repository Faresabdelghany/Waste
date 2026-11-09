// The modules the record store reads from the server (Issue #81). A
// `workspace.module` not listed here stays on the browser's own path: its
// fixtures merged with what the browser holds, exactly as before this issue.
//
// Switching a module is adding its adapter here under its key and, where the
// wire does not carry what the prototype's form says, a mapping under
// records/; the workspace's surface for it, where it has one, is keyed by the
// same key (`COMMAND_SURFACES`), which only a switched module's may be. The
// store reads this list, narrowed to what the person's grants let them view
// (`viewableModules`), and nothing else to decide.

import type { ModuleKey } from "@waste/domain/access/modules"

import type { WorkspaceId } from "@/lib/data/business-modules"
import type { LocationOf } from "@/lib/modules/keys"

import { viewedModules, type Grants } from "@/lib/modules/grants"
import { type ServerModule } from "./adapter"
import { moduleKeyOf } from "@/lib/modules/keys"
import { agreementsModule } from "./agreements"
import { applicationsModule } from "./applications"
import { bulkyBookingsModule } from "./bulky-bookings"
import { inspectionsModule } from "./inspections"
import { rightSizingModule } from "./right-sizing"
import { sensorsModule } from "./sensors"
import { siteAccessModule } from "./site-access"
import { siteVisitsModule } from "./site-visits"
import { alertsModule } from "./alerts"
import { vehiclePlanningModule } from "./allocations"
import { billingModule, eventsModule, invoicesModule } from "./billing"
import { containersModule, inventoryModule } from "./containers"
import { fleetDriversModule, fleetVehiclesModule } from "./fleet"
import { liveModule } from "./live"
import { masterDataModule } from "./master-data"
import { accessModule, organisationModule, serviceProvidersModule, teamModule } from "./organisation"
import { paymentsModule } from "./payments"
import { pickupsModule } from "./pickups"
import { placesModule, warehousesModule } from "./places"
import { collectionCalendarsModule, planningAreasModule } from "./planning"
import { priceRowsModule, productsModule } from "./pricing"
import { propertiesModule, propertyGroupsModule, sharedPointsModule } from "./properties"
import { customersModule } from "./registry"
import { dropOffPointsModule } from "./drop-off-points"
import { providerActivitiesModule } from "./provider-activities"
import { providerPricesModule, settlementsModule } from "./provider-money"
import { routeSchemesModule } from "./route-schemes"
import { serviceAreasModule } from "./service-areas"
import { routesModule } from "./routes"
import { ticketTeamsModule } from "./ticket-teams"
import { ticketsModule } from "./tickets"
import { scaleHouseModule } from "./scale-house"
import { weighbridgeModule } from "./weighbridge"
import { weightsModule } from "./weights"

/**
 * Each switched module's adapter, by its key: the server half of the module
 * manifest (lib/modules/manifest.ts), which the store reads beneath the
 * workspace's surfaces. Each adapter is built from its key's location
 * (`moduleAt`), so one filed under another module's key is a compile error.
 * A mapping that names a row of a module read after it
 * finds none yet, and the store reads it again once that module holds the row
 * (server-records.ts, `readsChanged`), so the order is the store's first read
 * and its rows are the same either way.
 */
const ADAPTERS = {
  "configure.organization": organisationModule,
  "service-providers.service-providers": serviceProvidersModule,
  "configure.access": accessModule,
  "service-providers.service-provider-workspace": teamModule,
  "configure.templates": ticketTeamsModule,
  "customers.contacts": customersModule,
  "configure.areas": planningAreasModule,
  "configure.calendars": collectionCalendarsModule,
  "configure.master": masterDataModule,
  "resources.depots": placesModule,
  "resources.warehouses": warehousesModule,
  "resources.drop-off-points": dropOffPointsModule,
  "fleet.vehicles": fleetVehiclesModule,
  "fleet.drivers": fleetDriversModule,
  "customers.properties": propertiesModule,
  "customers.groups": propertyGroupsModule,
  "customers.shared": sharedPointsModule,
  "commercial.products": productsModule,
  "commercial.price-rows": priceRowsModule,
  "customers.agreements": agreementsModule,
  "customers.right-sizing": rightSizingModule,
  "customers.applications": applicationsModule,
  "customers.site-access": siteAccessModule,
  "resources.containers": containersModule,
  "resources.sensors": sensorsModule,
  "operate.inspections": inspectionsModule,
  "resources.inventory": inventoryModule,
  "fleet.vehicle-planning": vehiclePlanningModule,
  "service-providers.service-areas": serviceAreasModule,
  "commercial.service-provider-prices": providerPricesModule,
  "route-studio.schemes": routeSchemesModule,
  "route-studio.live": liveModule,
  "route-studio.routes": routesModule,
  "service-providers.activities": providerActivitiesModule,
  "route-studio.pickups": pickupsModule,
  "operate.bulky-bookings": bulkyBookingsModule,
  "operate.site-visits": siteVisitsModule,
  "operate.tickets": ticketsModule,
  "operate.exceptions": alertsModule,
  "commercial.events": eventsModule,
  "commercial.billing": billingModule,
  "commercial.invoices": invoicesModule,
  "commercial.payments": paymentsModule,
  "commercial.settlements": settlementsModule,
  "route-studio.weights": weightsModule,
  "route-studio.weighbridge": weighbridgeModule,
  "operate.scale-house": scaleHouseModule,
} as const satisfies { readonly [Key in ModuleKey]?: ServerModule & LocationOf<Key> }

/** A module switched onto the API: one the store reads from the server. */
export type SwitchedModuleKey = keyof typeof ADAPTERS

/** The switched modules, in the order the store first reads them. */
export const SERVER_MODULES: readonly ServerModule[] = Object.values(ADAPTERS)

const byKey: ReadonlyMap<string, ServerModule> = new Map(Object.entries(ADAPTERS))

/** The server module behind a `workspace.module`, or undefined for one still on fixtures. */
export function serverModuleOf(workspaceId: WorkspaceId, moduleId: string): ServerModule | undefined {
  return byKey.get(moduleKeyOf(workspaceId, moduleId))
}

/** Whether a `workspace.module` reads from the server. */
export function isServerBacked(workspaceId: WorkspaceId, moduleId: string): boolean {
  return byKey.has(moduleKeyOf(workspaceId, moduleId))
}

/** The `workspace.module` keys switched so far, in load order. */
export const SERVER_MODULE_KEYS = Object.keys(ADAPTERS) as readonly SwitchedModuleKey[]

/**
 * The modules a person's grants let the store read, in the order given: those
 * whose key — the store's key is the API's module key — the `/me` role grants
 * `view` on (the API normalises `view` wherever anything is granted, so it is
 * the one action to look for). A module the grants do not cover is never
 * requested — the store marks it not granted and tells nobody (Issue #200)
 * — so nobody meets a refusal for a pane they cannot open, a driver on the
 * Driver App least of all (Issue #145). A module read for a Service
 * Provider's account alone (`providersOnly`) is read only where `provider`
 * says the account is one (#291 C24). A module the API reads under another
 * module's grant too (`alsoViewedUnder`: the ticket teams and types under the
 * tickets', #545 of #544) is read under either.
 */
export function viewableModules(grants: Grants, modules: readonly ServerModule[], { provider = false }: { provider?: boolean } = {}): ServerModule[] {
  const viewed = viewedModules(grants)
  return modules.filter((module) => (viewed.has(moduleKeyOf(module.workspaceId, module.moduleId)) || (module.alsoViewedUnder ?? []).some((key) => viewed.has(key))) && (provider || module.providersOnly !== true))
}

/** The modules tried where `/me` could not be read: every one an office account may be refused nothing by (#291 C24: a provider's own are its alone). */
export const MODULES_WITHOUT_ME: readonly ServerModule[] = SERVER_MODULES.filter((module) => module.providersOnly !== true)
