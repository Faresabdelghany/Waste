import type { SettingsPaneId } from "./settings-panes"

export type NavItemId =
  | "operate"
  | "plan"
  | "route-studio"
  | "fleet"
  | "customers"
  | "resources"
  | "service-providers"
  | "commercial"
  | "improve"

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

export const navItems: NavItem[] = [
  { id: "improve", label: "Dashboard", href: "/performance" },
  { id: "operate", label: "Tickets", href: "/tickets" },
  { id: "plan", label: "Map Planning", href: "/plan" },
  { id: "route-studio", label: "Route Studio", href: "/route-studio" },
  { id: "fleet", label: "Fleet", href: "/fleet" },
  { id: "customers", label: "Customers", href: "/customers" },
  { id: "resources", label: "Assets & Inventory", href: "/resources" },
  { id: "service-providers", label: "Service providers", href: "/service-providers" },
  { id: "commercial", label: "Price Engine", href: "/commercial" },
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
