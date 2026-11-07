import { ACTIONS, WORKSPACE_KEYS, type Action } from "@waste/domain/access/modules"

import { charterOf } from "@/lib/api/grants"
import {
  businessWorkspaces,
  type WorkspaceId,
} from "@/lib/data/business-modules"

export const ROLE_PERMISSION_ACTION_LABELS: Record<
  Action,
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
export type RoleAccessMap = Record<string, Action[]>

export type RolePermissionItem = {
  key: string
  label: string
}

export type RolePermissionSection = {
  id: WorkspaceId
  label: string
  items: RolePermissionItem[]
}

// Every module of every workspace, in the domain's order of workspaces and
// each workspace's page order: one row per surface. Control Center's twin
// workspace is no row, since Configure already carries its module.
export const rolePermissionSections: RolePermissionSection[] =
  WORKSPACE_KEYS.map((workspaceId) => {
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
  rolePermissionItemCount * ACTIONS.length

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS)

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

const FIXTURE_ROLE_PREFIX = "role-"

/**
 * A role's seeded grants as the permission matrix draws them, by fixture role
 * id, so the matrix reflects each role's charter out of the box. The charters
 * live in @waste/domain/access/system-roles, where the database seed reads
 * them too (Issue #70), read here through `charterOf`. The web's fixture
 * roles are ided `role-<key>`; custom roles (and any unknown id) start with
 * nothing granted. The map is the caller's own.
 */
export function defaultAccessForRole(roleId: string): RoleAccessMap {
  if (!roleId.startsWith(FIXTURE_ROLE_PREFIX)) return {}
  return Object.fromEntries(charterOf(roleId.slice(FIXTURE_ROLE_PREFIX.length)).map((grant) => [grant.moduleKey, [...grant.actions]]))
}
