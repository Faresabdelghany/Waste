// The modules the record store reads from the server (Issue #81), in the
// order they load: a module listed after another may resolve that one's
// rows. Organisation & Access first — the company and its projects, which
// every scope compares against; the service providers, which a user may
// belong to; then the users and roles, whose mapping names all three — and
// then the Registry's first, the customers. A `workspace.module` not listed
// here stays on the browser's own path: its fixtures merged with what the
// browser holds, exactly as before this issue.
//
// Switching a module is adding it here and, where the wire does not carry
// what the prototype's form says, a mapping under records/. The store reads
// this list, narrowed to what the person's grants let them view
// (`viewableModules`), and nothing else to decide.
import type { WorkspaceId } from "@/lib/data/business-modules"

import { moduleKeyOf, type ServerModule } from "./adapter"
import { agreementsModule } from "./agreements"
import { applicationsModule } from "./applications"
import { alertsModule } from "./alerts"
import { vehiclePlanningModule } from "./allocations"
import { billingModule, eventsModule, invoicesModule } from "./billing"
import { containersModule, inventoryModule } from "./containers"
import { fleetDriversModule, fleetVehiclesModule } from "./fleet"
import { liveModule } from "./live"
import { masterDataModule } from "./master-data"
import { accessModule, organisationModule, serviceProvidersModule, teamModule } from "./organisation"
import { accountingModule } from "./accounting"
import { paymentsModule } from "./payments"
import { pickupsModule } from "./pickups"
import { placesModule, warehousesModule } from "./places"
import { collectionCalendarsModule, planningAreasModule } from "./planning"
import { priceRowsModule, productsModule } from "./pricing"
import { propertiesModule, propertyGroupsModule, sharedPointsModule } from "./properties"
import { customersModule } from "./registry"
import { dropOffPointsModule } from "./drop-off-points"
import { providerPricesModule, settlementsModule } from "./provider-money"
import { routeSchemesModule } from "./route-schemes"
import { serviceAreasModule } from "./service-areas"
import { sortingGuideModule } from "./sorting-guide"
import { routesModule } from "./routes"
import { ticketsModule } from "./tickets"
import { weightsModule } from "./weights"

/**
 * The switched modules, in load order: a module another module resolves
 * against comes first. The planning configuration and the master data after
 * the organisation, since an area, a calendar and a service frequency name
 * their project; the Sorting Guide's items after both, since an item names
 * its project and its fraction (#293); the places after the master data, since a station names
 * its fractions, and the warehouses after the depots one may share a yard
 * with; the Drop-off Points after the places, since a point names its
 * project and its fractions (#293 M3); the fleet after the master data (a vehicle's type and fractions),
 * the access module (a driver's login) and the depots (a home base) (#180);
 * the properties after the customers their parties name, and the groups and
 * the shared points after the properties they gather (#184); the Price
 * Engine's catalogue, which names no route: the products after the master
 * data, and the price lists and their rows after the products, the customers
 * and the planning areas their conditions name (#185); the agreements after
 * the customers they name, the price lists they are priced under and the
 * products and places their subscriptions deliver (#291), and before the
 * placements that name their subscriptions (#183); the containers after the
 * master data and the warehouses they name, the ledger after the containers
 * its movements name, and the allocations after the fleet and the places they
 * reserve (#181);
 * the route schemes after everything a scheme and its groups name — the
 * areas, the master data, the providers, the fleet and the places — so none
 * of it is left an id chip on a scheme (#177); then the Live board, today's
 * routes, the short read ahead of the two windowed ones: the routes, which
 * name their scheme and the fleet and the places of their Planned Assignment,
 * and the pickups after the routes and the containers they name (#179); then
 * the tickets, after every module a ticket's links and its assignee name —
 * its parent among the tickets themselves — and the alerts after the
 * tickets they are linked to (#182); then the money the routes' work
 * makes: the billable events after the agreements, the products, the
 * routes and the tickets they name, the billing runs after the events they
 * invoice, and the invoices after the runs that issue them (#185); and the
 * payments after the invoices they pay and the customers who pay them
 * (#291 C6).
 */
export const SERVER_MODULES: readonly ServerModule[] = [
  organisationModule,
  serviceProvidersModule,
  accessModule,
  // A provider's team (#291 C24), after the providers its accounts name.
  teamModule,
  customersModule,
  planningAreasModule,
  collectionCalendarsModule,
  masterDataModule,
  sortingGuideModule,
  placesModule,
  warehousesModule,
  dropOffPointsModule,
  fleetVehiclesModule,
  fleetDriversModule,
  propertiesModule,
  propertyGroupsModule,
  sharedPointsModule,
  productsModule,
  priceRowsModule,
  agreementsModule,
  // The Applications (M7 of #293), after the customers, the places and the agreements their subjects name.
  applicationsModule,
  containersModule,
  inventoryModule,
  vehiclePlanningModule,
  serviceAreasModule,
  providerPricesModule,
  routeSchemesModule,
  liveModule,
  routesModule,
  pickupsModule,
  ticketsModule,
  alertsModule,
  eventsModule,
  billingModule,
  invoicesModule,
  paymentsModule,
  accountingModule,
  settlementsModule,
  weightsModule,
]

const byKey = new Map(SERVER_MODULES.map((module) => [moduleKeyOf(module.workspaceId, module.moduleId), module]))

/** The server module behind a `workspace.module`, or undefined for one still on fixtures. */
export function serverModuleOf(workspaceId: WorkspaceId, moduleId: string): ServerModule | undefined {
  return byKey.get(moduleKeyOf(workspaceId, moduleId))
}

/** Whether a `workspace.module` reads from the server. */
export function isServerBacked(workspaceId: WorkspaceId, moduleId: string): boolean {
  return byKey.has(moduleKeyOf(workspaceId, moduleId))
}

/** The `workspace.module` keys switched so far, in load order. */
export const SERVER_MODULE_KEYS: readonly string[] = SERVER_MODULES.map((module) => moduleKeyOf(module.workspaceId, module.moduleId))

/**
 * The modules a person's grants let the store read, in the order given: those
 * whose key — the store's key is the API's module key — the `/me` role grants
 * `view` on (the API normalises `view` wherever anything is granted, so it is
 * the one action to look for). A module the grants do not cover is never
 * requested — the store marks it not granted and tells nobody (Issue #200)
 * — so nobody meets a refusal for a pane they cannot open, a driver on the
 * Driver App least of all (Issue #145). A module read for a Service
 * Provider's account alone (`providersOnly`) is read only where `provider`
 * says the account is one (#291 C24).
 */
export function viewableModules(grants: readonly { moduleKey: string; actions: readonly string[] }[], modules: readonly ServerModule[], { provider = false }: { provider?: boolean } = {}): ServerModule[] {
  const viewed = new Set<string>(grants.filter((grant) => grant.actions.includes("view")).map((grant) => grant.moduleKey))
  return modules.filter((module) => viewed.has(moduleKeyOf(module.workspaceId, module.moduleId)) && (provider || module.providersOnly !== true))
}

/** The modules tried where `/me` could not be read: every one an office account may be refused nothing by (#291 C24: a provider's own are its alone). */
export const MODULES_WITHOUT_ME: readonly ServerModule[] = SERVER_MODULES.filter((module) => module.providersOnly !== true)
