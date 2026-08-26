"use client"

import Link from "next/link"
import Image from "next/image"
import { usePathname, useRouter } from "next/navigation"
import { useMemo, type ComponentType } from "react"
import {
  CaretRight,
  ChartBar,
  HouseLine,
  MagnifyingGlass,
  Path,
  ShieldCheck,
  SignOut,
  Ticket,
  Truck,
  UsersThree,
} from "@phosphor-icons/react/dist/ssr"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { ProgressCircle } from "@/components/progress-circle"
import { useBusinessRecordStore } from "@/components/wastehero/business-record-store"
import {
  resolveActiveRouteSummaries,
  routeDayFixtures,
  useActiveRoutes,
} from "@/components/wastehero/active-routes-store"

export type RestrictedPersona = "citizen" | "contractor"

type LeanPersona = Exclude<RestrictedPersona, "contractor">

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

const contractorNavItems: PersonaNavItem[] = [
  { label: "Dashboard", href: "/contractor-workspace", icon: ChartBar },
  { label: "Routes", href: "/contractor-workspace/routes", icon: Path },
  { label: "Fleet", href: "/contractor-workspace/fleet", icon: Truck },
  { label: "Tickets", href: "/contractor-workspace/tickets", icon: Ticket },
  { label: "Team", href: "/contractor-workspace/team", icon: UsersThree },
]

/**
 * The contractor manager sidebar mirrors the operator AppSidebar's layout and
 * typography — compact rows, search field, Active Routes group — scoped to
 * NordRen ApS pages and route days.
 */
function ContractorManagerSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { setOpenMobile } = useSidebar()
  const { starredRouteIds } = useActiveRoutes("contractor")
  const { getRecords } = useBusinessRecordStore()

  const activeRouteItems = useMemo(
    () =>
      resolveActiveRouteSummaries(
        starredRouteIds,
        getRecords("route-studio", "routes", routeDayFixtures),
        "contractor",
      ),
    [getRecords, starredRouteIds],
  )

  const isItemActive = (href: string): boolean =>
    href === "/contractor-workspace"
      ? pathname === "/contractor-workspace"
      : pathname.startsWith(href)

  return (
    <Sidebar className="border-none shadow-none">
      <SidebarHeader className="px-3 pb-2 pt-3">
        <div className="flex items-center">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <Image src="/logo-wrapper.png" alt="WasteHero" width={16} height={16} />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">WasteHero</span>
              <span className="text-xs text-sidebar-foreground/60">NordRen ApS</span>
            </div>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-0 gap-0">
        <SidebarGroup className="px-2 py-1.5">
          <div className="relative px-0 py-0">
            <MagnifyingGlass className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-sidebar-foreground/55" />
            <Input
              placeholder="Search"
              className="h-9 rounded-md border-sidebar-border bg-sidebar-accent/45 pl-8 text-sm text-sidebar-foreground shadow-none placeholder:text-sidebar-foreground/50 focus-visible:border-sidebar-ring focus-visible:ring-1 focus-visible:ring-sidebar-ring/25"
            />
            <kbd className="pointer-events-none absolute right-4 top-1/2 hidden h-5 -translate-y-1/2 select-none items-center gap-1 rounded border border-sidebar-border bg-sidebar-accent px-1.5 font-mono text-[10px] font-medium text-sidebar-foreground/60 sm:flex">
              <span className="text-xs">⌘</span>K
            </kbd>
          </div>
        </SidebarGroup>

        <SidebarGroup className="px-2 py-1">
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {contractorNavItems.map((item) => {
                const ItemIcon = item.icon
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      asChild
                      isActive={isItemActive(item.href)}
                      className="h-7 rounded-md px-2.5 font-normal text-sidebar-foreground/70"
                    >
                      <Link href={item.href} onClick={() => setOpenMobile(false)}>
                        <ItemIcon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="px-2 pb-1 pt-2">
          <SidebarGroupLabel className="h-6 px-2.5 text-[11px] font-medium text-sidebar-foreground/55">
            Active Routes
          </SidebarGroupLabel>
          <SidebarGroupContent>
            {activeRouteItems.length === 0 ? (
              <p className="px-2.5 py-1 text-xs text-sidebar-foreground/50">
                Star a route on the Routes page to pin it here.
              </p>
            ) : (
              <SidebarMenu className="gap-0.5">
                {activeRouteItems.map((route) => (
                  <SidebarMenuItem key={route.id}>
                    <SidebarMenuButton asChild className="h-7 rounded-md px-2.5 group">
                      <Link href={route.href} onClick={() => setOpenMobile(false)}>
                        <ProgressCircle progress={route.progress} color={route.color} size={16} />
                        <span className="flex-1 truncate text-sm">{route.name}</span>
                        <span className="rounded p-0.5 opacity-0 hover:bg-sidebar-accent group-hover:opacity-100">
                          <span className="text-lg text-sidebar-foreground/55">···</span>
                        </span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-sidebar-accent"
            >
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-accent-foreground">
                  LM
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-1 flex-col">
                <span className="text-sm font-medium">Lars Mikkelsen</span>
                <span className="text-xs text-sidebar-foreground/60">NordRen ApS · Manager</span>
              </div>
              <CaretRight className="h-4 w-4 text-sidebar-foreground/55" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-40">
            <DropdownMenuItem
              className="cursor-pointer text-destructive focus:text-destructive"
              onSelect={() => router.push("/login")}
            >
              <SignOut className="h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

type RestrictedPersonaSidebarProps = {
  persona: RestrictedPersona
}

export function RestrictedPersonaSidebar({ persona }: RestrictedPersonaSidebarProps) {
  const { setOpenMobile } = useSidebar()
  const pathname = usePathname()
  const router = useRouter()

  if (persona === "contractor") return <ContractorManagerSidebar />

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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex w-full cursor-pointer items-center gap-3 rounded-lg p-2 text-left hover:bg-sidebar-accent"
            >
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-accent-foreground">
                  {definition.initials}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{definition.identityName}</p>
                <p className="truncate text-xs text-sidebar-foreground/60">{definition.identityDetail}</p>
              </div>
              <CaretRight className="h-4 w-4 shrink-0 text-sidebar-foreground/55" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" className="w-40">
            <DropdownMenuItem
              className="cursor-pointer text-destructive focus:text-destructive"
              onSelect={() => router.push("/login")}
            >
              <SignOut className="h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
