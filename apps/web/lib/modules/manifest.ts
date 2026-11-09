// The module manifest: every module of the office by its `ModuleKey`, as its
// workspace's file (operate.ts … configure.ts) specifies it, and what the
// web's registries read off it — the workspaces and their pages, a module's
// address, its Settings pane, its list's view and the provider's pages it is
// shown on. The domain's `MODULE_KEYS` is the one list of modules; the
// manifest spells each exactly once (__tests__/manifest.test.ts).
import { WORKSPACE_KEYS, type ModuleKey } from "@waste/domain/access/modules"

import { COMMERCIAL } from "./commercial"
import { CONFIGURE } from "./configure"
import { CUSTOMERS } from "./customers"
import { FLEET } from "./fleet"
import { IMPROVE } from "./improve"
import { OPERATE } from "./operate"
import { PLAN } from "./plan"
import { RESOURCES } from "./resources"
import { ROUTE_STUDIO } from "./route-studio"
import { SERVICE_PROVIDERS } from "./service-providers"
import { CONTROL_CENTER, type ModuleLocation, type WorkspaceId } from "./keys"
import type { ModuleSpec, ProviderPageId, WorkspacePath } from "./spec"

export type { LocationOf, ModuleIdOf, ModuleLocation, WorkspaceId } from "./keys"
export { CONTROL_CENTER, moduleAt } from "./keys"
export type { ModulePlacement, ModuleSpec, ModuleView, ProviderPageId, RichModuleTable } from "./spec"

/** A workspace of the registry as the web reads it: its words, its page, and its modules by id in the order its page offers them. */
export type Workspace<W extends WorkspaceId = WorkspaceId> = {
  readonly id: W
  readonly label: string
  readonly description: string
  readonly alsoAt?: readonly string[]
  readonly modules: Readonly<Record<string, ModuleSpec>>
} & WorkspacePath<W>

const controlCenterModule = CONFIGURE.modules[CONTROL_CENTER]

/** Every workspace, in the domain's order, and Control Center's twin last: one module, Configure's, whose form the registry keeps under the twin's key. */
export const WORKSPACES: { readonly [W in WorkspaceId]: Workspace<W> } = {
  operate: OPERATE,
  plan: PLAN,
  "route-studio": ROUTE_STUDIO,
  fleet: FLEET,
  customers: CUSTOMERS,
  resources: RESOURCES,
  "service-providers": SERVICE_PROVIDERS,
  commercial: COMMERCIAL,
  improve: IMPROVE,
  configure: CONFIGURE,
  [CONTROL_CENTER]: {
    id: CONTROL_CENTER,
    label: "Control Center",
    description: "Manage role-gated sales, onboarding, subscriptions, entitlements, and marketplace fulfillment.",
    path: "/control-center",
    modules: { [CONTROL_CENTER]: { ...controlCenterModule, shown: "tab", form: undefined, deepLink: undefined } },
  },
}

/** Every module's spec by its key. */
export const MODULES = Object.fromEntries(
  WORKSPACE_KEYS.flatMap((workspaceId) => Object.entries(WORKSPACES[workspaceId].modules).map(([moduleId, spec]) => [`${workspaceId}.${moduleId}`, spec])),
) as { readonly [Key in ModuleKey]: ModuleSpec }

/** The spec of the module at a location, or undefined where the registry holds none. */
export function moduleSpecOf({ workspaceId, moduleId }: ModuleLocation): ModuleSpec | undefined {
  return Object.hasOwn(WORKSPACES, workspaceId) && Object.hasOwn(WORKSPACES[workspaceId].modules, moduleId) ? WORKSPACES[workspaceId].modules[moduleId] : undefined
}

/** The ids of the modules a workspace's page shows, tabs and More, in its order: not one shown elsewhere or in Settings. */
export function pageModuleIds(workspaceId: WorkspaceId): string[] {
  return Object.entries(WORKSPACES[workspaceId].modules).flatMap(([moduleId, spec]) => (spec.shown === "tab" || spec.shown === "more" ? [moduleId] : []))
}

/** The modules a page of the provider's workspace shows, in the manifest's order: each one's workspace and id. */
export function providerPageModules(page: ProviderPageId): ModuleLocation[] {
  return Object.values(WORKSPACES).flatMap((workspace) =>
    Object.entries(workspace.modules).flatMap(([moduleId, spec]) => (spec.providerPage === page ? [{ workspaceId: workspace.id, moduleId }] : [])),
  )
}
