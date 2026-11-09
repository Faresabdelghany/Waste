"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useMemo } from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { SidebarActiveRoutes, SidebarBrand, SidebarPages, SidebarSearch } from "@/components/sidebar-parts"
import {
  Tray,
  Users,
  ChartBar,
  CreditCard,
  Gear,
  Layout,
  MapPinArea,
  MapTrifold,
  Truck,
  Buildings,
} from "@phosphor-icons/react/dist/ssr"
import { useApiSession } from "@/components/platform/api-session-store"
import { useBusinessRecordStore, useServerModuleState } from "@/components/platform/business-record-store"
import {
  resolveActiveRouteSummaries,
  useActiveRoutes,
} from "@/components/platform/active-routes-store"
import { projectScopeOfMe, projectWebIdOf } from "@/lib/api/records/me-projects"
import { ROUTES_MODULE } from "@/lib/api/records/routes"
import { TICKETS_MODULE } from "@/lib/api/records/tickets"
import { settingsHref } from "@/lib/modules/settings-panes"
import { footerItems, navBadgeOf, navItemActive, navItems, type NavItem, type NavItemId, type SidebarFooterItemId } from "@/lib/data/sidebar"
import { opennessOf } from "@/lib/data/tickets"
import { OPERATOR_PROJECT_NAME } from "@/lib/data/fixture-identity"
import { projectScopeLabel, selectedProjectIds } from "@/lib/data/project-scope"

const navItemIcons: Record<NavItemId, React.ComponentType<{ className?: string }>> = {
  operate: Tray,
  plan: MapPinArea,
  "route-studio": MapTrifold,
  fleet: Truck,
  customers: Users,
  resources: Layout,
  "service-providers": Buildings,
  commercial: CreditCard,
  improve: ChartBar,
}

const footerItemIcons: Record<SidebarFooterItemId, React.ComponentType<{ className?: string }>> = {
  settings: Gear,
  templates: Layout,
}

export function AppSidebar() {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  const { starredRouteIds } = useActiveRoutes("operator")
  const { getRecords } = useBusinessRecordStore()
  // The project scope the office's workspace runs in on the Pilot (`projectScopeOfMe`), read as a record's scope reads.
  const { apiConfigured, me } = useApiSession()
  const meProjects = (me?.projects ?? []).map((project) => ({ id: projectWebIdOf(project), name: project.name }))
  const projectLabel = apiConfigured ? projectScopeLabel(selectedProjectIds(projectScopeOfMe(me?.projects), {}, meProjects), meProjects) : OPERATOR_PROJECT_NAME
  // The Tickets badge is the open tickets the store has loaded, and none until it has (#147); no other item carries a number (#248).
  const ticketsOnApi = useServerModuleState(TICKETS_MODULE.workspaceId, TICKETS_MODULE.moduleId)
  const badgeOf = (item: NavItem): number | undefined =>
    navBadgeOf(item, ticketsOnApi?.status === "ready" ? ticketsOnApi.records.filter((record) => opennessOf(record) === "Open").length : undefined)

  // A pin is a starred route the API holds, read from its rows alone (#248).
  const activeRouteItems = useMemo(
    () => resolveActiveRouteSummaries(starredRouteIds, getRecords(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId), "operator"),
    [getRecords, starredRouteIds],
  )

  return (
    <Sidebar className="border-none shadow-none">
      <SidebarBrand scope={projectLabel} />

      <SidebarContent className="px-0 gap-0">
        <SidebarSearch />
        <SidebarPages
          pages={navItems.map((item) => ({ href: item.href, label: item.label, icon: navItemIcons[item.id], active: navItemActive(item, pathname), badge: badgeOf(item) }))}
        />
        <SidebarActiveRoutes routes={activeRouteItems} hint="Star a route in Route Studio to pin it here." />
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu className="gap-0.5">
          {footerItems.map((item) => {
            const href = settingsHref(item.pane, { from: pathname })

            return (
              <SidebarMenuItem key={item.label}>
                <SidebarMenuButton
                  asChild
                  className="h-7 rounded-md px-2.5 text-sidebar-foreground/70"
                >
                  <Link href={href} onClick={() => setOpenMobile(false)}>
                    {(() => {
                      const Icon = footerItemIcons[item.id]
                      return Icon ? <Icon className="h-4 w-4" /> : null
                    })()}
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarFooter>

    </Sidebar>
  )
}
