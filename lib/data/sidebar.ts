export type NavItemId =
  | "operate"
  | "plan"
  | "route-studio"
  | "fleet"
  | "customers"
  | "resources"
  | "contractors"
  | "commercial"
  | "improve"

export type SidebarFooterItemId = "settings" | "templates"

export type NavItem = {
  id: NavItemId
  label: string
  href: string
  badge?: number
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
}

export const navItems: NavItem[] = [
  { id: "improve", label: "Dashboard", href: "/performance" },
  { id: "operate", label: "Tickets", href: "/tickets", badge: 6 },
  { id: "plan", label: "Plan", href: "/plan", badge: 3 },
  { id: "route-studio", label: "Route Studio", href: "/route-studio" },
  { id: "fleet", label: "Fleet", href: "/fleet" },
  { id: "customers", label: "Customers", href: "/customers" },
  { id: "resources", label: "Assets & Inventory", href: "/resources", badge: 8 },
  { id: "contractors", label: "Contractors", href: "/contractors" },
  { id: "commercial", label: "Price Engine", href: "/commercial", badge: 14 },
]

export const activeRoutes: ActiveRouteSummary[] = [
  {
    id: "route-1042",
    name: "Central · Residual",
    color: "var(--chart-5)",
    progress: 82,
    href: "/route-studio?module=live&record=route-1042",
  },
  {
    id: "route-1048",
    name: "Østerbro · Organic",
    color: "var(--chart-3)",
    progress: 64,
    href: "/route-studio?module=live&record=route-1048",
  },
  {
    id: "route-1039",
    name: "Vesterbro · Paper",
    color: "var(--chart-3)",
    progress: 91,
    href: "/route-studio?module=live&record=route-1039",
  },
  {
    id: "route-1051",
    name: "Amager · Glass",
    color: "var(--chart-2)",
    progress: 48,
    href: "/route-studio?module=live&record=route-1051",
  },
]

export const footerItems: SidebarFooterItem[] = [
  { id: "settings", label: "Settings" },
  { id: "templates", label: "Ticket templates" },
]
