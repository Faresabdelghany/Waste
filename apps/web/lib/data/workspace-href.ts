// Where a workspace module opens, and a record in it: its workspace's page and
// the `?module=` / `?record=` the workspace reads (`WorkspaceQuerySync`),
// spelled here alone, or the Settings pane the manifest places it in
// (lib/modules). The Driver App opens its own surface. An address a module has
// left is redirected by lib/data/legacy-ids.ts (`migrateLegacyHref`) and
// next.config.mjs, never here.
import { CONTROL_CENTER_TWIN } from "@/lib/modules/keys"
import { WORKSPACES, moduleSpecOf, type ModuleLocation } from "@/lib/modules/manifest"

import { DEFAULT_SETTINGS_PANE, settingsHref } from "./settings-panes"

/** The params that name a module, and a record in it, on the page showing them: `params` kept beside them. */
export function moduleParams(moduleId: string, recordId?: string, params?: URLSearchParams): URLSearchParams {
  const named = new URLSearchParams(params)
  named.set("module", moduleId)
  if (recordId) named.set("record", recordId)
  return named
}

/**
 * The address that opens a module, and the record named where one is. `page`
 * is the path a restricted shell shows the module on
 * (`/service-provider-workspace/routes`), in place of its workspace's.
 */
export function workspaceHref(location: ModuleLocation, recordId?: string, { page }: { page?: string } = {}): string {
  const { workspaceId, moduleId } = location
  const params = moduleParams(moduleId, recordId)
  if (page !== undefined) return `${page}?${params.toString()}`
  const spec = moduleSpecOf(location)
  // An app of its own opens itself, reading no `?module=` (the Driver App, Issue #145); a module shown elsewhere keeps its workspace's address.
  if (spec?.shown === "app" && spec.deepLink !== undefined) return spec.deepLink
  const shown = spec?.shown
  if (typeof shown === "object") return settingsHref(shown.pane === "default" ? DEFAULT_SETTINGS_PANE : shown.pane, { record: recordId })
  // Configure's one module with no pane, Control Center, opens its twin.
  if (workspaceId === "configure") return workspaceHref(CONTROL_CENTER_TWIN, recordId)
  return `${WORKSPACES[workspaceId].path}?${params.toString()}`
}
