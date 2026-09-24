// The permission vocabulary: every surface a role can be granted something on,
// and the four things it can be granted. One `workspace.module` key per row of
// the prototype's permission matrix (Settings → Users, Roles & Teams), which is
// the ten workspaces of the sidebar and their modules; the standalone Control
// Center workspace is left out because Configure already carries a Control
// Center module — one row per surface, not one per route alias.
//
// The list lives here, not in the web and not in the database: `role_grant`
// stores `module_key` as text and the contracts' `z.enum(MODULE_KEYS)` is what
// checks it at the API boundary (Issue #70), so adding a module is a code
// change and never a migration. The web still derives its matrix from
// `businessWorkspaces`, and apps/web/lib/data/__tests__/permission-catalogue.test.ts
// holds the two lists equal in both directions: a module added to a workspace
// fails that test until it is named here.

/** Every `workspace.module` key a grant can name, in sidebar order. */
export const MODULE_KEYS = [
  // Tickets
  "operate.tickets",
  "operate.exceptions",
  "operate.driver-app",
  // Map Planning
  "plan.map-planning",
  // Route Studio
  "route-studio.live",
  "route-studio.schemes",
  "route-studio.routes",
  "route-studio.pickups",
  "route-studio.weights",
  // Fleet
  "fleet.vehicles",
  "fleet.drivers",
  "fleet.vehicle-planning",
  // Customers
  "customers.properties",
  "customers.groups",
  "customers.shared",
  "customers.contacts",
  "customers.agreements",
  "customers.citizen-portal",
  // Assets & Inventory
  "resources.containers",
  "resources.inventory",
  "resources.warehouses",
  "resources.depots",
  // Service providers
  "service-providers.service-providers",
  "service-providers.service-areas",
  "service-providers.activities",
  "service-providers.service-provider-workspace",
  // Price Engine
  "commercial.products",
  "commercial.price-rows",
  "commercial.service-provider-prices",
  "commercial.settlements",
  "commercial.events",
  "commercial.billing",
  "commercial.invoices",
  // Dashboard
  "improve.intelligence",
  "improve.analytics",
  "improve.autopilot",
  "improve.imports",
  "improve.performance",
  "improve.compliance",
  // Configure
  "configure.organization",
  "configure.access",
  "configure.master",
  "configure.areas",
  "configure.templates",
  "configure.finance",
  "configure.integrations",
  "configure.portals",
  "configure.privacy",
  "configure.control-center",
  "configure.calendars",
] as const

/** A surface a grant can name. */
export type ModuleKey = (typeof MODULE_KEYS)[number]

/** The workspace half of a module key. Read off the keys themselves, so the two can never disagree. */
export type WorkspaceKey = ModuleKey extends `${infer Workspace}.${string}` ? Workspace : never

/**
 * The workspaces the keys name, in the order they first appear. Derived, so a
 * workspace exists exactly as long as it has a module; the cast is safe because
 * every key is a literal of the form above.
 */
export const WORKSPACE_KEYS: readonly WorkspaceKey[] = [
  ...new Set(MODULE_KEYS.map((key) => key.slice(0, key.indexOf(".")) as WorkspaceKey)),
]

/** The workspace's own module keys, in sidebar order: what a workspace-wide grant expands to. */
export function modulesOf(workspace: WorkspaceKey): ModuleKey[] {
  const prefix = `${workspace}.`
  return MODULE_KEYS.filter((key) => key.startsWith(prefix))
}

/** What a grant allows on a module. `view` is implied by the other three (grants.ts). */
export const ACTIONS = ["view", "edit", "create", "delete"] as const

/** One of the four things a grant allows. */
export type Action = (typeof ACTIONS)[number]
