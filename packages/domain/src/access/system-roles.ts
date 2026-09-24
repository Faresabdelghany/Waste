// The eleven roles every company is seeded with: their copy and the grants
// they start with. This is `DEFAULT_ROLE_ACCESS` from
// apps/web/lib/data/role-permissions.ts, moved here so the database seed and
// the web read one source (Issue #70): the names, scopes and descriptions are
// the prototype's fixture roles, and the grants are the same charters, with
// the workspace-wide sugar expanded against MODULE_KEYS instead of the web's
// `businessWorkspaces`.
//
// A seeded role keeps its `key` in the database (`role.key`, `system = true`),
// so a company's rows can be matched back to the charter here; a custom role
// has neither. The grants are the defaults a company starts with, not a rule
// the API enforces: once seeded, a role's grants are its own rows, and
// `PUT /roles/:id/grants` may take them anywhere (a system role's key and
// `system` flag are what stay immutable).
//
// Every list below is already normalised in the sense of grants.ts — `view`
// wherever anything else is granted — and a test holds it to that, so the
// seed writes what the API would compute.
import { mergeGrants, type Grant } from "./grants"
import { ACTIONS, WORKSPACE_KEYS, modulesOf, type Action, type ModuleKey, type WorkspaceKey } from "./modules"

/** The stable keys of the seeded roles, in the order a company is seeded with them. */
export const SYSTEM_ROLE_KEYS = [
  "company-administrator",
  "operations-manager",
  "dispatcher",
  "route-planner",
  "fleet-manager",
  "customer-service",
  "finance-specialist",
  "service-provider-manager",
  "service-provider-foreman",
  "driver",
  "integration-writer",
] as const

/** The key of a seeded role. Null in the database for a custom one. */
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number]

/** A seeded role: its key, the copy Settings shows, and the grants it starts with. */
export type SystemRole = {
  key: SystemRoleKey
  name: string
  /** The label of what the role reaches: Company, Assigned projects, Own service provider, ... */
  scope: string
  /** One line on what the role is for; `role.description` in the database. */
  description: string
  system: true
  /** Normalised (grants.ts): one entry per module, sorted, `view` implied. */
  grants: readonly Grant[]
}

const ALL: readonly Action[] = ACTIONS
const VIEW_EDIT: readonly Action[] = ["view", "edit"]
const VIEW_EDIT_CREATE: readonly Action[] = ["view", "edit", "create"]
const VIEW: readonly Action[] = ["view"]

/** Every module of a workspace, with the same actions: the web's `workspaceGrant`, expanded against the vocabulary. */
function workspace(id: WorkspaceKey, actions: readonly Action[]): Grant[] {
  return modulesOf(id).map((moduleKey) => ({ moduleKey, actions }))
}

/** One module's actions, for the charters that name a single surface. */
function only(moduleKey: ModuleKey, actions: readonly Action[]): Grant {
  return { moduleKey, actions }
}

/**
 * The web's `mergeAccess`: a module named by two lines of a charter keeps the
 * union of their actions, and the result is spelled as grants.ts spells a
 * grant set. It merges, it does not imply `view` — every charter below says
 * `view` itself, and a test holds it to that, so what is read here is what is
 * seeded. Called at module load over literal data, so the export is data.
 */
function charter(...grants: (Grant | Grant[])[]): readonly Grant[] {
  return mergeGrants(grants.flat())
}

export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    key: "company-administrator",
    name: "Company Administrator",
    scope: "Company",
    description: "Company, projects, users, and settings",
    system: true,
    // Everything, everywhere: the role that owns the tenant.
    grants: charter(...WORKSPACE_KEYS.map((id) => workspace(id, ALL))),
  },
  {
    key: "operations-manager",
    name: "Operations Manager",
    scope: "Assigned projects",
    description: "Routes, tickets, fleet, and approvals",
    system: true,
    grants: charter(
      workspace("operate", ALL),
      workspace("plan", ALL),
      workspace("route-studio", ALL),
      workspace("fleet", ALL),
      workspace("resources", VIEW_EDIT),
      workspace("service-providers", VIEW_EDIT),
      workspace("customers", VIEW),
      workspace("commercial", VIEW),
      workspace("improve", VIEW),
      // Areas & Zones (2026-09-03) and Collection Calendars (2026-09-16) moved
      // from Plan to Settings: the roles that had full Plan access keep full
      // access to both modules.
      only("configure.areas", ALL),
      only("configure.calendars", ALL),
      only("configure.master", VIEW_EDIT),
      only("configure.templates", VIEW_EDIT),
    ),
  },
  {
    key: "dispatcher",
    name: "Dispatcher",
    scope: "Assigned projects",
    description: "Live routes, assignments, and tickets",
    system: true,
    grants: charter(
      workspace("operate", VIEW_EDIT_CREATE),
      workspace("route-studio", VIEW_EDIT),
      workspace("fleet", VIEW),
      workspace("customers", VIEW),
      only("improve.performance", VIEW),
    ),
  },
  {
    key: "route-planner",
    name: "Route Planner",
    scope: "Assigned projects",
    description: "Route schemes, routes, and planning",
    system: true,
    grants: charter(
      workspace("plan", ALL),
      workspace("route-studio", ALL),
      workspace("fleet", VIEW),
      workspace("customers", VIEW),
      workspace("resources", VIEW),
      only("configure.areas", ALL),
      only("configure.calendars", ALL),
      only("improve.analytics", VIEW),
    ),
  },
  {
    key: "fleet-manager",
    name: "Fleet Manager",
    scope: "Assigned projects",
    description: "Vehicles, drivers, and vehicle planning",
    system: true,
    grants: charter(
      workspace("fleet", ALL),
      workspace("resources", VIEW_EDIT),
      workspace("route-studio", VIEW),
      workspace("operate", VIEW),
      workspace("improve", VIEW),
    ),
  },
  {
    key: "customer-service",
    name: "Customer Service",
    scope: "Assigned projects",
    description: "Customers, properties, tickets, and communication",
    system: true,
    grants: charter(
      workspace("customers", VIEW_EDIT_CREATE),
      workspace("operate", VIEW_EDIT_CREATE),
      only("commercial.invoices", VIEW),
      only("configure.templates", VIEW_EDIT),
    ),
  },
  {
    key: "finance-specialist",
    name: "Finance Specialist",
    scope: "Company or project",
    description: "Prices, billing, invoices, and settlements",
    system: true,
    grants: charter(
      workspace("commercial", ALL),
      workspace("customers", VIEW),
      workspace("service-providers", VIEW),
      workspace("improve", VIEW),
      only("configure.finance", VIEW_EDIT),
    ),
  },
  {
    key: "service-provider-manager",
    name: "Service Provider Manager",
    scope: "Own service provider",
    description: "Service provider users, fleet, routes, and settlements",
    system: true,
    grants: charter(
      workspace("service-providers", VIEW_EDIT),
      workspace("fleet", VIEW_EDIT),
      workspace("route-studio", VIEW),
      workspace("operate", VIEW),
      // The restricted service provider workspace reads these grants live:
      // fleet is fully self-managed, tickets can be raised, and service
      // provider users are fully administered by the manager — while routes
      // stay read-only.
      only("fleet.vehicles", ALL),
      only("fleet.drivers", ALL),
      only("operate.tickets", ["view", "create"]),
      only("service-providers.service-provider-workspace", ALL),
      only("commercial.service-provider-prices", VIEW),
      only("commercial.settlements", VIEW),
    ),
  },
  {
    // The prototype lists this one as a Custom role; the spec names its key
    // among the eleven a company is seeded with, so here it is a system role
    // like the rest — a company may still delete or re-grant it.
    key: "service-provider-foreman",
    name: "Service Provider Foreman",
    scope: "Own service provider",
    description: "Service provider routes, vehicles, and drivers",
    system: true,
    grants: charter(
      workspace("service-providers", VIEW),
      workspace("fleet", VIEW_EDIT),
      workspace("route-studio", VIEW),
      workspace("operate", VIEW),
    ),
  },
  {
    key: "driver",
    name: "Driver",
    scope: "Assigned routes",
    description: "Driver app and assigned route execution",
    system: true,
    grants: charter(
      only("operate.driver-app", VIEW_EDIT),
      only("route-studio.routes", VIEW),
      only("route-studio.pickups", VIEW_EDIT),
    ),
  },
  {
    key: "integration-writer",
    name: "Integration Writer",
    scope: "Explicit API scope",
    description: "Configured integration read and write access",
    system: true,
    grants: charter(
      only("improve.imports", VIEW_EDIT_CREATE),
      only("configure.integrations", VIEW_EDIT),
      only("configure.privacy", VIEW),
    ),
  },
]
