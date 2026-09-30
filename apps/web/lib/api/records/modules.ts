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
import { vehiclePlanningModule } from "./allocations"
import { containersModule, inventoryModule } from "./containers"
import { fleetDriversModule, fleetVehiclesModule } from "./fleet"
import { masterDataModule } from "./master-data"
import { accessModule, organisationModule, serviceProvidersModule } from "./organisation"
import { placesModule, warehousesModule } from "./places"
import { collectionCalendarsModule, planningAreasModule } from "./planning"
import { propertiesModule, propertyGroupsModule, sharedPointsModule } from "./properties"
import { customersModule } from "./registry"
import { routeSchemesModule } from "./route-schemes"

/**
 * The switched modules, in load order: a module another module resolves
 * against comes first. The planning configuration and the master data after
 * the organisation, since an area, a calendar and a service frequency name
 * their project; the places after the master data, since a station names
 * its fractions, and the warehouses after the depots one may share a yard
 * with; the fleet after the master data (a vehicle's type and fractions),
 * the access module (a driver's login) and the depots (a home base) (#180);
 * the properties after the customers their parties name, and the groups and
 * the shared points after the properties they gather (#184); the agreements
 * after the customers they name and the places their subscriptions are
 * delivered at, and before the placements that name their subscriptions
 * (#183); the containers after the master data
 * and the warehouses they name, the ledger after the containers its movements
 * name, and the allocations after the fleet and the places they reserve (#181);
 * the route schemes last, after everything a scheme and its groups name —
 * the areas, the master data, the providers, the fleet and the places —
 * so none of it is left an id chip on a scheme (#177).
 */
export const SERVER_MODULES: readonly ServerModule[] = [
  organisationModule,
  serviceProvidersModule,
  accessModule,
  customersModule,
  planningAreasModule,
  collectionCalendarsModule,
  masterDataModule,
  placesModule,
  warehousesModule,
  fleetVehiclesModule,
  fleetDriversModule,
  propertiesModule,
  propertyGroupsModule,
  sharedPointsModule,
  agreementsModule,
  containersModule,
  inventoryModule,
  vehiclePlanningModule,
  routeSchemesModule,
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
 * Driver App least of all (Issue #145).
 */
export function viewableModules(grants: readonly { moduleKey: string; actions: readonly string[] }[], modules: readonly ServerModule[]): ServerModule[] {
  const viewed = new Set<string>(grants.filter((grant) => grant.actions.includes("view")).map((grant) => grant.moduleKey))
  return modules.filter((module) => viewed.has(moduleKeyOf(module.workspaceId, module.moduleId)))
}
