"use client"

import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import { useMemo, type ComponentType } from "react"
import {
  ClipboardText,
  HouseLine,
  Path,
  ShieldCheck,
  Ticket,
  Truck,
  UsersThree,
} from "@phosphor-icons/react/dist/ssr"

import { Badge } from "@/components/ui/badge"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { SidebarActiveRoutes, SidebarBrand, SidebarPages, SidebarSearch } from "@/components/sidebar-parts"
import { useApiConfigured } from "@/components/platform/api-session-store"
import { useBusinessRecordStore } from "@/components/platform/business-record-store"
import { useProviderWorkspace } from "@/components/platform/provider-account"
import { ROUTES_MODULE } from "@/lib/data/routes"
import { PROVIDER_PAGES, PROVIDER_WORKSPACE_PATH } from "@/lib/modules/provider-pages"
import type { ProviderPageId } from "@/lib/modules/manifest"
import {
  resolveActiveRouteSummaries,
  useActiveRoutes,
} from "@/components/platform/active-routes-store"

export type RestrictedPersona = "citizen" | "service-provider"

type LeanPersona = Exclude<RestrictedPersona, "service-provider">

type PersonaNavItem = {
  label: string
  href: string
  icon: ComponentType<{ className?: string }>
}

type PersonaScopeCard = {
  workspaceName: string
  badgeLabel: string
  icon: ComponentType<{ className?: string }>
}

type PersonaSidebarDefinition = {
  personaLabel: string
  identityName: string
  identityDetail: string
  initials: string
  navItems: PersonaNavItem[]
  scopeCard?: PersonaScopeCard
  accessLabel?: string
}

const personaDefinitions: Record<LeanPersona, PersonaSidebarDefinition> = {
  citizen: {
    personaLabel: "Customer self-service",
    identityName: "Østerbro Housing",
    identityDetail: "Authorized property user",
    initials: "ØH",
    scopeCard: {
      workspaceName: "Citizen Portal",
      badgeLabel: "Verified access",
      icon: HouseLine,
    },
    accessLabel:
      "Verified Parkvej 18 services, requests, documents, and customer-safe history only.",
    navItems: [{ label: "Citizen Portal", href: "/portal", icon: HouseLine }],
  },
}

const PROVIDER_PAGE_ICONS: Record<ProviderPageId, PersonaNavItem["icon"]> = {
  routes: Path,
  fleet: Truck,
  tickets: Ticket,
  activities: ClipboardText,
  team: UsersThree,
}

const serviceProviderNavItems: PersonaNavItem[] = PROVIDER_PAGES.map((page) => ({ label: page.label, href: page.path, icon: PROVIDER_PAGE_ICONS[page.id] }))

/** The workspace's landing, its first page: its routes (#291 C24). */
const LANDING_PAGE = PROVIDER_PAGES[0].path

/**
 * The service provider manager sidebar mirrors the operator AppSidebar's layout and
 * typography — compact rows, search field, Active Routes group — scoped to
 * NordRen ApS pages and route days in fixture mode, and on the Pilot to the
 * provider `/me` names, with no Dashboard.
 */
function ServiceProviderManagerSidebar() {
  const pathname = usePathname()
  const apiConfigured = useApiConfigured()
  const { starredRouteIds } = useActiveRoutes("service-provider")
  const { getRecords } = useBusinessRecordStore()
  const provider = useProviderWorkspace()

  // A pin is a starred route the API holds, read from its rows alone (#248).
  const activeRouteItems = useMemo(
    () => resolveActiveRouteSummaries(starredRouteIds, getRecords(ROUTES_MODULE.workspaceId, ROUTES_MODULE.moduleId), "service-provider"),
    [getRecords, starredRouteIds],
  )

  const isItemActive = (href: string): boolean => {
    if (pathname === PROVIDER_WORKSPACE_PATH) return href === LANDING_PAGE
    return pathname.startsWith(href)
  }

  return (
    <Sidebar className="border-none shadow-none">
      <SidebarBrand scope={apiConfigured ? provider?.legalName ?? "" : "NordRen ApS"} />

      <SidebarContent className="px-0 gap-0">
        <SidebarSearch />
        <SidebarPages pages={serviceProviderNavItems.map((item) => ({ ...item, active: isItemActive(item.href) }))} />
        <SidebarActiveRoutes routes={activeRouteItems} hint="Star a route on the Routes page to pin it here." />
      </SidebarContent>
    </Sidebar>
  )
}

type RestrictedPersonaSidebarProps = {
  persona: RestrictedPersona
}

export function RestrictedPersonaSidebar({ persona }: RestrictedPersonaSidebarProps) {
  const { setOpenMobile } = useSidebar()
  const pathname = usePathname()

  if (persona === "service-provider") return <ServiceProviderManagerSidebar />

  const definition = personaDefinitions[persona]
  const ScopeCardIcon = definition.scopeCard?.icon

  return (
    <Sidebar className="border-none shadow-none">
      <SidebarHeader className="gap-4 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Image src="/logo-wrapper.png" alt="Waste" width={16} height={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Waste</p>
            <p className="truncate text-xs text-sidebar-foreground/60">{definition.personaLabel}</p>
          </div>
        </div>

        {definition.scopeCard && ScopeCardIcon && (
          <div className="border-y border-sidebar-border py-3">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center text-sidebar-foreground">
                <ScopeCardIcon className="h-[18px] w-[18px]" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <p className="truncate text-sm font-medium">
                  {definition.scopeCard.workspaceName}
                </p>
                <Badge
                  variant="outline"
                  className="rounded-full border-sidebar-border px-2 py-0 text-[10px] font-normal text-sidebar-foreground/70"
                >
                  {definition.scopeCard.badgeLabel}
                </Badge>
              </div>
            </div>
          </div>
        )}
      </SidebarHeader>

      <SidebarContent className="gap-0 px-2">
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {definition.navItems.map((item) => {
                const ItemIcon = item.icon
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === item.href}
                      className="h-9 rounded-md px-3 text-sidebar-foreground"
                    >
                      <Link href={item.href} onClick={() => setOpenMobile(false)}>
                        <ItemIcon className="h-[18px] w-[18px]" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {definition.accessLabel && (
          <SidebarGroup>
            <SidebarGroupLabel>Access scope</SidebarGroupLabel>
            <div className="mx-2 flex items-start gap-2.5 border-y border-sidebar-border py-3">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" weight="fill" />
              <p className="text-xs leading-5 text-sidebar-foreground/60">{definition.accessLabel}</p>
            </div>
          </SidebarGroup>
        )}
      </SidebarContent>
    </Sidebar>
  )
}
