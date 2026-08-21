"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ProgressCircle } from "@/components/progress-circle"
import {
  MagnifyingGlass,
  Tray,
  CalendarBlank,
  Users,
  ChartBar,
  CreditCard,
  Gear,
  Layout,
  MapTrifold,
  Truck,
  Buildings,
  SignOut,
  CaretRight,
} from "@phosphor-icons/react/dist/ssr"
import { activeRoutes, footerItems, navItems, type NavItemId, type SidebarFooterItemId } from "@/lib/data/sidebar"

const navItemIcons: Record<NavItemId, React.ComponentType<{ className?: string }>> = {
  operate: Tray,
  plan: CalendarBlank,
  "route-studio": MapTrifold,
  fleet: Truck,
  customers: Users,
  resources: Layout,
  contractors: Buildings,
  commercial: CreditCard,
  improve: ChartBar,
}

const footerItemIcons: Record<SidebarFooterItemId, React.ComponentType<{ className?: string }>> = {
  settings: Gear,
  templates: Layout,
}

export function AppSidebar() {
  const pathname = usePathname()
  const router = useRouter()
  const { setOpenMobile } = useSidebar()

  const isItemActive = (id: NavItemId): boolean => {
    if (id === "operate")
      return (
        pathname === "/" ||
        pathname.startsWith("/operate") ||
        pathname.startsWith("/projects") ||
        pathname.startsWith("/tasks") ||
        pathname.startsWith("/tickets") ||
        pathname.startsWith("/inbox")
      )
    if (id === "plan") return pathname.startsWith("/plan")
    if (id === "route-studio")
      return pathname.startsWith("/route-studio") || pathname.startsWith("/routes")
    if (id === "fleet") return pathname.startsWith("/fleet")
    if (id === "customers")
      return (
        pathname.startsWith("/customers") ||
        pathname.startsWith("/clients") ||
        pathname.startsWith("/portal")
      )
    if (id === "resources") return pathname.startsWith("/resources")
    if (id === "contractors")
      return pathname.startsWith("/contractors") || pathname.startsWith("/contractor-workspace")
    if (id === "commercial")
      return pathname.startsWith("/commercial")
    if (id === "improve") return pathname.startsWith("/improve") || pathname.startsWith("/performance")
    return false
  }

  return (
    <Sidebar className="border-none shadow-none">
      <SidebarHeader className="px-3 pb-2 pt-3">
        <div className="flex items-center">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
              <img src="/logo-wrapper.png" alt="WasteHero" className="h-4 w-4" />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">WasteHero</span>
              <span className="text-xs text-sidebar-foreground/60">Copenhagen Central</span>
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
              {navItems.map((item) => {
                const active = isItemActive(item.id)

                return (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      className="h-7 rounded-md px-2.5 font-normal text-sidebar-foreground/70"
                    >
                      <Link href={item.href} onClick={() => setOpenMobile(false)}>
                        {(() => {
                          const Icon = navItemIcons[item.id]
                          return Icon ? <Icon className="h-4 w-4" /> : null
                        })()}
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                    {item.badge && (
                      <SidebarMenuBadge className="rounded-full bg-sidebar-accent px-2 text-sidebar-foreground/65">
                        {item.badge}
                      </SidebarMenuBadge>
                    )}
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
            <SidebarMenu className="gap-0.5">
              {activeRoutes.map((route) => (
                <SidebarMenuItem key={route.name}>
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
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-2">
        <SidebarMenu className="gap-0.5">
          {footerItems.map((item) => {
            const pane = item.id === "settings" ? "account" : "ticket-comms"
            const href = `/settings?pane=${pane}&from=${encodeURIComponent(pathname)}`

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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="mt-1.5 flex w-full cursor-pointer items-center gap-2.5 rounded-md p-1.5 text-left hover:bg-sidebar-accent"
            >
              <Avatar className="h-8 w-8">
                <AvatarImage src="/avatar-profile.jpg" />
                <AvatarFallback>OL</AvatarFallback>
              </Avatar>
              <div className="flex flex-1 flex-col">
                <span className="text-sm font-medium">Olivia Larsen</span>
                <span className="text-xs text-sidebar-foreground/60">Operations manager</span>
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
