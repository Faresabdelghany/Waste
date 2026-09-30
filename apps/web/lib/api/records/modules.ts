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
// this list and nothing else to decide.
import type { WorkspaceId } from "@/lib/data/business-modules"

import { moduleKeyOf, type ServerModule } from "./adapter"
import { fleetDriversModule, fleetVehiclesModule } from "./fleet"
import { masterDataModule } from "./master-data"
import { accessModule, organisationModule, serviceProvidersModule } from "./organisation"
import { placesModule, warehousesModule } from "./places"
import { collectionCalendarsModule, planningAreasModule } from "./planning"
import { customersModule } from "./registry"

/**
 * The switched modules, in load order: a module another module resolves
 * against comes first. The planning configuration and the master data after
 * the organisation, since an area, a calendar and a service frequency name
 * their project; the places after the master data, since a station names
 * its fractions, and the warehouses after the depots one may share a yard
 * with; the fleet after the master data (a vehicle's type and fractions),
 * the access module (a driver's login) and the depots (a home base) (#180).
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
