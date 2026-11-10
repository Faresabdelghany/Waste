import { WORKSPACE_KEYS, type WorkspaceKey } from "@waste/domain/access/modules"

import { WORKSPACES } from "@/lib/modules/manifest"

import type { SettingsPaneId } from "@/lib/modules/settings-panes"

/** A workspace the sidebar lists: every one but Configure, whose modules are Settings'. */
export type NavItemId = Exclude<WorkspaceKey, "configure">

export type SidebarFooterItemId = "settings" | "templates"

export type NavItem = {
  id: NavItemId
  label: string
  href: string
  /** The pages it is the item of, the active one where a page's path starts with one of them. */
  paths: readonly string[]
}

export type ActiveRouteSummary = {
  id: string
  name: string
  color: string
  progress: number
  href: string
}

export type SidebarFooterItem = {
  id: SidebarFooterItemId
  label: string
  /** The Settings pane it opens; a pane its mode lacks opens the one it names instead. */
  pane: SettingsPaneId
}

/**
 * The pages a workspace's item stands for: the item's own, the workspace's,
 * the other pages that show it (`alsoAt`), and the surfaces its modules are
 * shown on elsewhere (the citizen portal, a provider's own workspace), never
 * an app of its own (the Driver App), which no office sidebar frames.
 */
function pathsOf(id: NavItemId, href: string): readonly string[] {
  const workspace = WORKSPACES[id]
  const elsewhere = Object.values(workspace.modules).flatMap((spec) => (spec.shown === "elsewhere" && spec.deepLink !== undefined ? [spec.deepLink] : []))
  return [...new Set([href, workspace.path, ...(workspace.alsoAt ?? []), ...elsewhere])]
}

const itemOf = (id: NavItemId, href: string): NavItem => ({ id, label: WORKSPACES[id].label, href, paths: pathsOf(id, href) })

/** The Dashboard leads the sidebar, at its own page; every other workspace follows in the domain's order, at its page, under its name. */
const DASHBOARD: NavItem = itemOf("improve", "/performance")

/** The item the root shows: without the API `/` is Operate's page, and on the Pilot it lands a person by `/me`. */
const HOME: NavItemId = "operate"

export const navItems: NavItem[] = [
  DASHBOARD,
  ...WORKSPACE_KEYS.flatMap((id) => (id === "configure" || id === DASHBOARD.id ? [] : [itemOf(id, WORKSPACES[id].path)])),
]

export function navItemActive(item: NavItem, pathname: string): boolean {
  if (pathname === "/") return item.id === HOME
  return item.paths.some((path) => pathname.startsWith(path))
}

/**
 * A nav item's badge (#248): a count of rows the API answered — the open
 * tickets once read, none before — and no badge on an item no count is read
 * for.
 */
export function navBadgeOf(item: NavItem, openTickets: number | undefined): number | undefined {
  return item.id === "operate" ? openTickets : undefined
}

export const footerItems: SidebarFooterItem[] = [
  { id: "settings", label: "Settings", pane: "account" },
  { id: "templates", label: "Ticket templates", pane: "message-templates" },
]
