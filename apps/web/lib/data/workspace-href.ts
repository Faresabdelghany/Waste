// Where a workspace module opens, and a record in it: each workspace's path
// and the `?module=` / `?record=` the workspace reads (`WorkspaceQuerySync`),
// spelled here alone. A Settings module opens its pane, the Driver App its own
// surface. An address a module has left is redirected by
// lib/data/legacy-ids.ts (`migrateLegacyHref`) and next.config.mjs, never here.
import { settingsModuleDomains } from "./business-domain"
import type { ModuleLocation, WorkspaceId } from "./business-modules"
import { DEFAULT_SETTINGS_PANE, settingsHref, type SettingsPaneId } from "./settings-panes"

const workspacePaths: Record<Exclude<WorkspaceId, "configure">, string> = {
  operate: "/tickets",
  plan: "/plan",
  "route-studio": "/route-studio",
  fleet: "/fleet",
  customers: "/customers",
  resources: "/resources",
  "service-providers": "/service-providers",
  commercial: "/commercial",
  improve: "/improve",
  "control-center": "/control-center",
}

const settingsPaneByModule: Record<string, SettingsPaneId> = {
  ...Object.fromEntries(settingsModuleDomains.map((module) => [module.moduleId, module.settingsPaneId])),
  access: "access",
  templates: "tickets",
  finance: "finance-invoicing",
  integrations: "integrations-on-api",
  portals: "portals-on-api",
}

/**
 * The address that opens a module, and the record named where one is. `page`
 * is the path a restricted shell shows the module on
 * (`/service-provider-workspace/routes`), in place of its workspace's.
 */
export function workspaceHref(location: ModuleLocation, recordId?: string, { page }: { page?: string } = {}): string {
  const { workspaceId, moduleId } = location
  const params = new URLSearchParams({ module: moduleId })
  if (recordId) params.set("record", recordId)
  if (page !== undefined) return `${page}?${params.toString()}`
  // The Driver App is a surface of its own (Issue #145), never a workspace module.
  if (workspaceId === "operate" && moduleId === "driver-app") return "/driver"
  if (workspaceId === "configure") {
    if (moduleId === "control-center") return workspaceHref({ workspaceId: "control-center", moduleId: "control-center" }, recordId)
    return settingsHref(settingsPaneByModule[moduleId] ?? DEFAULT_SETTINGS_PANE, { record: recordId })
  }
  return `${workspacePaths[workspaceId]}?${params.toString()}`
}
