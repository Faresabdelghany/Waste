import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"

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

// Seeded grants for the built-in roles, keyed by fixture role id, so the
// permission matrix reflects each role's charter out of the box. The charters
// themselves live in @waste/domain/access/system-roles, where the database
// seed reads them too (Issue #70): one source for the grants a company starts
// with, whether they are drawn as a matrix or written as `role_grant` rows.
// The web's fixture roles are ided `role-<key>`; custom roles (and any unknown
// id) start with nothing granted.
const DEFAULT_ROLE_ACCESS: Record<string, RoleAccessMap> = Object.fromEntries(
  SYSTEM_ROLES.map((role) => [
    `role-${role.key}`,
    Object.fromEntries(role.grants.map((grant) => [grant.moduleKey, [...grant.actions]])),
  ]),
)

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
