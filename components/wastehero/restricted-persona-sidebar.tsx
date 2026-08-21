"use client"

import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import type { ComponentType } from "react"
import {
  HouseLine,
  Path,
  ShieldCheck,
  ShieldStar,
  Ticket,
  Truck,
  UsersThree,
} from "@phosphor-icons/react/dist/ssr"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export type RestrictedPersona = "citizen" | "contractor" | "internal"

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
  /** Workspace name + badge card under the header; omitted for lean personas. */
  scopeCard?: PersonaScopeCard
  /** Access-scope explainer group; omitted for lean personas. */
  accessLabel?: string
}

const personaDefinitions: Record<RestrictedPersona, PersonaSidebarDefinition> = {
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
  contractor: {
    personaLabel: "Contractor manager",
    identityName: "Lars Mikkelsen",
    identityDetail: "NordRen ApS · Manager",
    initials: "LM",
    navItems: [
      { label: "Routes", href: "/contractor-workspace", icon: Path },
      { label: "Fleet", href: "/contractor-workspace/fleet", icon: Truck },
      { label: "Tickets", href: "/contractor-workspace/tickets", icon: Ticket },
      { label: "Team", href: "/contractor-workspace/team", icon: UsersThree },
    ],
  },
  internal: {
    personaLabel: "WasteHero internal",
    identityName: "WasteHero Operations",
    identityDetail: "Authorized internal staff",
    initials: "WH",
    scopeCard: {
      workspaceName: "Control Center",
      badgeLabel: "Internal only",
      icon: ShieldStar,
    },
    accessLabel:
      "Internal sales, onboarding, subscriptions, entitlements, and fulfillment operations.",
    navItems: [
      { label: "Control Center", href: "/control-center", icon: ShieldStar },
    ],
  },
}

type RestrictedPersonaSidebarProps = {
  persona: RestrictedPersona
}

export function RestrictedPersonaSidebar({ persona }: RestrictedPersonaSidebarProps) {
  const { setOpenMobile } = useSidebar()
  const pathname = usePathname()
  const definition = personaDefinitions[persona]
  const ScopeCardIcon = definition.scopeCard?.icon

  return (
    <Sidebar className="border-none shadow-none">
      <SidebarHeader className="gap-4 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Image src="/logo-wrapper.png" alt="WasteHero" width={16} height={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">WasteHero</p>
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
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" weight="fill" />
              <p className="text-xs leading-5 text-sidebar-foreground/60">{definition.accessLabel}</p>
            </div>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3">
        <div className="flex items-center gap-3 rounded-lg p-2">
          <Avatar className="h-8 w-8">
            <AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-accent-foreground">
              {definition.initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{definition.identityName}</p>
            <p className="truncate text-xs text-sidebar-foreground/60">{definition.identityDetail}</p>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
