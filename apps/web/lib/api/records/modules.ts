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
import { accessModule, organisationModule, serviceProvidersModule } from "./organisation"
import { customersModule } from "./registry"

/** The switched modules, in load order. */
export const SERVER_MODULES: readonly ServerModule[] = [organisationModule, serviceProvidersModule, accessModule, customersModule]

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
