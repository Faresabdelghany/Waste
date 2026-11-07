import { WORKSPACE_KEYS, type WorkspaceKey } from "@waste/domain/access/modules"

import { WORKSPACES } from "@/lib/modules/manifest"

import type { SettingsPaneId } from "./settings-panes"

/** A workspace the sidebar lists: every one but Configure, whose modules are Settings'. */
export type NavItemId = Exclude<WorkspaceKey, "configure">

export type SidebarFooterItemId = "settings" | "templates"

export type NavItem = {
  id: NavItemId
  label: string
  href: string
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

/** The Dashboard leads the sidebar, at its own page; every other workspace follows in the domain's order, at its page, under its name. */
const DASHBOARD: NavItem = { id: "improve", label: WORKSPACES.improve.label, href: "/performance" }

export const navItems: NavItem[] = [
  DASHBOARD,
  ...WORKSPACE_KEYS.flatMap((id) => (id === "configure" || id === DASHBOARD.id ? [] : [{ id, label: WORKSPACES[id].label, href: WORKSPACES[id].path }])),
]

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
