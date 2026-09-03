import {
  businessWorkspaces,
  type WorkspaceId,
} from "@/lib/data/business-modules"

export const ROLE_PERMISSION_ACTIONS = [
  "view",
  "edit",
  "create",
  "delete",
] as const

export type RolePermissionAction = (typeof ROLE_PERMISSION_ACTIONS)[number]

export const ROLE_PERMISSION_ACTION_LABELS: Record<
  RolePermissionAction,
  string
> = {
  view: "Can view",
  edit: "Can edit",
  create: "Can create",
  delete: "Can delete",
}

/**
 * Sparse map of granted permissions: `${workspaceId}.${moduleId}` → granted
 * actions. Items and actions absent from the map are not granted.
 */
export type RoleAccessMap = Record<string, RolePermissionAction[]>

export type RolePermissionItem = {
  key: string
  label: string
}

export type RolePermissionSection = {
  id: WorkspaceId
  label: string
  items: RolePermissionItem[]
}

// Every navigable surface, in sidebar order. The standalone Control Center
// workspace is omitted because Configure already carries a Control Center
// module — one row per surface, not one per route alias.
const SECTION_ORDER: WorkspaceId[] = [
  "operate",
  "plan",
  "route-studio",
  "fleet",
  "customers",
  "resources",
  "service-providers",
  "commercial",
  "improve",
  "configure",
]

export const rolePermissionSections: RolePermissionSection[] =
  SECTION_ORDER.map((workspaceId) => {
    const workspace = businessWorkspaces[workspaceId]
    return {
      id: workspace.id,
      label: workspace.label,
      items: workspace.modules.map((module) => ({
        key: `${workspace.id}.${module.id}`,
        label: module.label,
      })),
    }
  })

export const rolePermissionItemCount = rolePermissionSections.reduce(
  (sum, section) => sum + section.items.length,
  0,
)

export const rolePermissionCellCount =
  rolePermissionItemCount * ROLE_PERMISSION_ACTIONS.length

const ACTION_SET: ReadonlySet<string> = new Set(ROLE_PERMISSION_ACTIONS)

export function isRoleAccessMap(value: unknown): value is RoleAccessMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every(
    (actions) =>
      Array.isArray(actions) &&
      actions.every(
        (action) => typeof action === "string" && ACTION_SET.has(action),
      ),
  )
}

const ALL_ACTIONS: RolePermissionAction[] = [...ROLE_PERMISSION_ACTIONS]
const VIEW_EDIT: RolePermissionAction[] = ["view", "edit"]
const VIEW_EDIT_CREATE: RolePermissionAction[] = ["view", "edit", "create"]
const VIEW_ONLY: RolePermissionAction[] = ["view"]

function workspaceGrant(
  workspaceId: WorkspaceId,
  actions: RolePermissionAction[],
): RoleAccessMap {
  const grant: RoleAccessMap = {}
  for (const module of businessWorkspaces[workspaceId].modules) {
    grant[`${workspaceId}.${module.id}`] = [...actions]
  }
  return grant
}

function mergeAccess(...maps: RoleAccessMap[]): RoleAccessMap {
  const merged: RoleAccessMap = {}
  for (const map of maps) {
    for (const [key, actions] of Object.entries(map)) {
      merged[key] = [...new Set([...(merged[key] ?? []), ...actions])]
    }
  }
  return merged
}

// Seeded grants for the built-in roles, keyed by fixture role id, so the
// permission matrix reflects each role's charter out of the box. Custom roles
// (and any unknown id) start with nothing granted.
const DEFAULT_ROLE_ACCESS: Record<string, RoleAccessMap> = {
  "role-company-administrator": mergeAccess(
    ...SECTION_ORDER.map((workspaceId) =>
      workspaceGrant(workspaceId, ALL_ACTIONS),
    ),
  ),
  "role-operations-manager": mergeAccess(
    workspaceGrant("operate", ALL_ACTIONS),
    workspaceGrant("plan", ALL_ACTIONS),
    workspaceGrant("route-studio", ALL_ACTIONS),
    workspaceGrant("fleet", ALL_ACTIONS),
    workspaceGrant("resources", VIEW_EDIT),
    workspaceGrant("service-providers", VIEW_EDIT),
    workspaceGrant("customers", VIEW_ONLY),
    workspaceGrant("commercial", VIEW_ONLY),
    workspaceGrant("improve", VIEW_ONLY),
    {
      // Areas & Zones moved from Plan to Settings (2026-09-03, D37): the
      // roles that had full Plan access keep full access to the module.
      "configure.areas": ALL_ACTIONS,
      "configure.master": VIEW_EDIT,
      "configure.templates": VIEW_EDIT,
    },
  ),
  "role-dispatcher": mergeAccess(
    workspaceGrant("operate", VIEW_EDIT_CREATE),
    workspaceGrant("route-studio", VIEW_EDIT),
    workspaceGrant("fleet", VIEW_ONLY),
    workspaceGrant("customers", VIEW_ONLY),
    { "improve.performance": VIEW_ONLY },
  ),
  "role-route-planner": mergeAccess(
    workspaceGrant("plan", ALL_ACTIONS),
    workspaceGrant("route-studio", ALL_ACTIONS),
    workspaceGrant("fleet", VIEW_ONLY),
    workspaceGrant("customers", VIEW_ONLY),
    workspaceGrant("resources", VIEW_ONLY),
    { "configure.areas": ALL_ACTIONS, "improve.analytics": VIEW_ONLY },
  ),
  "role-fleet-manager": mergeAccess(
    workspaceGrant("fleet", ALL_ACTIONS),
    workspaceGrant("resources", VIEW_EDIT),
    workspaceGrant("route-studio", VIEW_ONLY),
    workspaceGrant("operate", VIEW_ONLY),
    workspaceGrant("improve", VIEW_ONLY),
  ),
  "role-customer-service": mergeAccess(
    workspaceGrant("customers", VIEW_EDIT_CREATE),
    workspaceGrant("operate", VIEW_EDIT_CREATE),
    {
      "commercial.invoices": VIEW_ONLY,
      "configure.templates": VIEW_EDIT,
    },
  ),
  "role-finance-specialist": mergeAccess(
    workspaceGrant("commercial", ALL_ACTIONS),
    workspaceGrant("customers", VIEW_ONLY),
    workspaceGrant("service-providers", VIEW_ONLY),
    workspaceGrant("improve", VIEW_ONLY),
    { "configure.finance": VIEW_EDIT },
  ),
  "role-service-provider-manager": mergeAccess(
    workspaceGrant("service-providers", VIEW_EDIT),
    workspaceGrant("fleet", VIEW_EDIT),
    workspaceGrant("route-studio", VIEW_ONLY),
    workspaceGrant("operate", VIEW_ONLY),
    {
      // The restricted service provider workspace reads these grants live: fleet is
      // fully self-managed, tickets can be raised, and service provider users are
      // fully administered by the manager — while routes stay read-only.
      "fleet.vehicles": ALL_ACTIONS,
      "fleet.drivers": ALL_ACTIONS,
      "operate.tickets": ["view", "create"],
      "service-providers.service-provider-workspace": ALL_ACTIONS,
      "commercial.service-provider-prices": VIEW_ONLY,
      "commercial.settlements": VIEW_ONLY,
    },
  ),
  "role-service-provider-foreman": mergeAccess(
    workspaceGrant("service-providers", VIEW_ONLY),
    workspaceGrant("fleet", VIEW_EDIT),
    workspaceGrant("route-studio", VIEW_ONLY),
    workspaceGrant("operate", VIEW_ONLY),
  ),
  "role-driver": {
    "operate.driver-app": VIEW_EDIT,
    "route-studio.routes": VIEW_ONLY,
    "route-studio.pickups": VIEW_EDIT,
  },
  "role-integration-writer": {
    "improve.imports": VIEW_EDIT_CREATE,
    "configure.integrations": VIEW_EDIT,
    "configure.privacy": VIEW_ONLY,
  },
}

export function defaultAccessForRole(roleId: string): RoleAccessMap {
  const defaults = DEFAULT_ROLE_ACCESS[roleId]
  if (!defaults) return {}
  return Object.fromEntries(
    Object.entries(defaults).map(([key, actions]) => [key, [...actions]]),
  )
}

/**
 * The grants a role is effectively working with: its stored map when it has
 * one (an empty object means "explicitly nothing"), otherwise the seeded
 * defaults for built-in roles.
 */
export function effectiveRoleAccess(role: {
  id: string
  access?: RoleAccessMap
}): RoleAccessMap {
  return role.access ?? defaultAccessForRole(role.id)
}
