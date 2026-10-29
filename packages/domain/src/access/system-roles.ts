// The twelve roles every company is seeded with: their copy and the grants
// they start with. This is `DEFAULT_ROLE_ACCESS` from
// apps/web/lib/data/role-permissions.ts, moved here so the database seed and
// the web read one source (Issue #70): the names, scopes and descriptions are
// the prototype's fixture roles, and the grants are the same charters, with
// the workspace-wide sugar expanded against MODULE_KEYS instead of the web's
// `businessWorkspaces`.
//
// A seeded role keeps its `key` in the database (`role.key`, `system = true`),
// so a company's rows can be matched back to the charter here; a custom role
// has neither. A system role's name and description are the tenant's once it
// is seeded — a company may call the Dispatcher "Disponent" — and the seed
// writes them on insert alone; its key, its scope and its grants are the
// platform's, which every seed restores to the charter, so the API refuses a
// change to its scope or its grants in the sentences below (#291), and a
// company that wants another reach makes a custom role.
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
  "site-attendant",
] as const

/** The key of a seeded role. Null in the database for a custom one. */
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number]

/** What a change to a system role's grants is refused with, the role named as the tenant calls it (#291). */
export const systemRoleKept = (name: string): string => `${name} is a system role, whose permissions every seed restores to its charter; make a custom role to allow something else`

/** What a change to a system role's scope is refused with (#291). */
export const systemRoleScopeKept = (name: string): string => `${name} is a system role, whose scope every seed restores to its charter; make a custom role for another scope`

/**
 * The scope label of a role a Service Provider's account holds (#291 slice
 * 23b): the two provider charters carry it, and the provider's team door
 * gives a role only when its scope says it (apps/api/src/routes/users.ts).
 */
export const PROVIDER_ROLE_SCOPE = "Own service provider"

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

/** Every module of a workspace, with the same actions: the web's `workspaceGrant`, expanded against the vocabulary, less any module named in `except`. */
function workspace(id: WorkspaceKey, actions: readonly Action[], except: readonly ModuleKey[] = []): Grant[] {
  return modulesOf(id)
    .filter((moduleKey) => !except.includes(moduleKey))
    .map((moduleKey) => ({ moduleKey, actions }))
}

/** The modules of the recycling centres' visits (M4 of #293): the plates, the cards and a household's visit history are personal data the office keeps, never a Service Provider's to read. */
const VISIT_MODULES: readonly ModuleKey[] = ["operate.site-visits", "customers.site-access"]

/** The modules of Operate a Service Provider's roles never read: the visits', and the inspections' (M23 of #293), whose photos and findings at a customer's bins are the office's to follow up. */
const OFFICE_OPERATE: readonly ModuleKey[] = [...VISIT_MODULES, "operate.inspections"]

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
      // A provider's coordination (#474): it raises the follow-ups and notes, and decides the proposals with its schemes' create.
      only("service-providers.activities", VIEW_EDIT_CREATE),
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
      // The office's ad-hoc route is a dispatcher's daily job (#111): whoever moves a route may make one.
      only("route-studio.routes", VIEW_EDIT_CREATE),
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
      // The stops a ticket is about, read: their photos are the evidence a missed-collection dispute is answered with (M6 of #293).
      only("route-studio.pickups", VIEW),
      // The catalogue it sells from (#291): the products a subscription names and the price lists an agreement is priced under, read and never set.
      only("commercial.products", VIEW),
      only("commercial.price-rows", VIEW),
      only("commercial.invoices", VIEW),
      // Whether a customer's payment arrived (#291 C6): read, never registered or matched.
      only("commercial.payments", VIEW),
      only("configure.templates", VIEW_EDIT),
      // The citizen-facing Sorting Guide (#293): it keeps the items up to date — adds, edits, withdraws — and leaves publishing the project to the administrator.
      // The pane reads the projects a guide is kept for and the fractions an item names, so it views both and changes neither.
      only("configure.sorting-guide", VIEW_EDIT_CREATE),
      only("configure.organization", VIEW),
      only("configure.master", VIEW),
      // The Drop-off Points residents bring waste to (#293, M3): it keeps their hours and fractions up to date, as it keeps the guide that points to them.
      only("resources.drop-off-points", VIEW_EDIT_CREATE),
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
    scope: PROVIDER_ROLE_SCOPE,
    description: "Service provider users, fleet, routes, and settlements",
    system: true,
    grants: charter(
      workspace("service-providers", VIEW_EDIT),
      workspace("fleet", VIEW_EDIT),
      workspace("route-studio", VIEW),
      workspace("operate", VIEW, OFFICE_OPERATE),
      // The restricted service provider workspace reads these grants live:
      // fleet is fully self-managed, tickets can be raised, and service
      // provider users are fully administered by the manager. The routes it
      // runs it crews (#291 slice 23b): `edit` on the routes reaches only
      // `assign` and `dispatch` from a provider's account, naming its own
      // vehicles and drivers — every other route command stays the office's.
      only("route-studio.routes", VIEW_EDIT),
      only("fleet.vehicles", ALL),
      only("fleet.drivers", ALL),
      only("operate.tickets", ["view", "create"]),
      only("service-providers.service-provider-workspace", ALL),
      // Its proposals and notes to the office (#474): opened and withdrawn here, decided only by the office.
      only("service-providers.activities", VIEW_EDIT_CREATE),
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
    scope: PROVIDER_ROLE_SCOPE,
    description: "Service provider routes, vehicles, and drivers",
    system: true,
    grants: charter(
      workspace("service-providers", VIEW),
      workspace("fleet", VIEW_EDIT),
      workspace("route-studio", VIEW),
      workspace("operate", VIEW, OFFICE_OPERATE),
    ),
  },
  {
    key: "driver",
    name: "Driver",
    scope: "Assigned routes",
    description: "Driver app and assigned route execution",
    system: true,
    // The driver door alone (#179): the Driver App reads and commands nothing
    // but `operate.driver-app` (apps/api/src/routes/driver.ts), and the
    // office's routes and pickups are not a driver's surface — granted, they
    // would have the phone read every route and pickup at sign-in.
    grants: charter(only("operate.driver-app", VIEW_EDIT)),
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
  {
    key: "site-attendant",
    name: "Site attendant",
    scope: "Assigned projects",
    description: "Recycling-centre check-in and the visit ledger",
    system: true,
    // A recycling centre's staff (M4 of #293): the check-in records a visit and the ledger reads it, the register of plates and cards is read to answer a visitor, and nothing else. The web lands the role on `/check-in`, as a driver's lands on `/driver`.
    grants: charter(only("operate.site-visits", ["view", "create"]), only("customers.site-access", VIEW)),
  },
]
