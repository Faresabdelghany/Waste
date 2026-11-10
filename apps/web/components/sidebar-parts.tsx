"use client"

// The parts the office's sidebar and a service provider's share: the brand
// over the scope it works in, the search field, the pages it lists, and the
// route days pinned to it.
import Image from "next/image"
import Link from "next/link"
import type { ComponentType } from "react"
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr"

import { Input } from "@/components/ui/input"
import {
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
import { ProgressCircle } from "@/components/progress-circle"
import type { ActiveRouteSummary } from "@/lib/data/sidebar"

/** The brand, and under it what the sidebar works in: the office's project, a provider's name. */
export function SidebarBrand({ scope }: { scope: string }) {
  return (
    <SidebarHeader className="px-3 pb-2 pt-3">
      <div className="flex items-center">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Image src="/logo-wrapper.png" alt="Waste" width={16} height={16} />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold">Waste</span>
            <span className="text-xs text-sidebar-foreground/60">{scope}</span>
          </div>
        </div>
      </div>
    </SidebarHeader>
  )
}

export function SidebarSearch() {
  return (
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
  )
}

export type SidebarPage = {
  href: string
  label: string
  icon: ComponentType<{ className?: string }>
  active: boolean
  badge?: number
}

export function SidebarPages({ pages }: { pages: readonly SidebarPage[] }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarGroup className="px-2 py-1">
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {pages.map((page) => {
            const Icon = page.icon
            return (
              <SidebarMenuItem key={page.href}>
                <SidebarMenuButton asChild isActive={page.active} className="h-7 rounded-md px-2.5 font-normal text-sidebar-foreground/70">
                  <Link href={page.href} onClick={() => setOpenMobile(false)}>
                    <Icon className="h-4 w-4" />
                    <span>{page.label}</span>
                  </Link>
                </SidebarMenuButton>
                {page.badge ? (
                  <SidebarMenuBadge className="rounded-full bg-sidebar-accent px-2 text-sidebar-foreground/65">
                    {page.badge}
                  </SidebarMenuBadge>
                ) : null}
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

export function SidebarActiveRoutes({ routes, hint }: { routes: readonly ActiveRouteSummary[]; hint: string }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarGroup className="px-2 pb-1 pt-2">
      <SidebarGroupLabel className="h-6 px-2.5 text-[11px] font-medium text-sidebar-foreground/55">
        Active Routes
      </SidebarGroupLabel>
      <SidebarGroupContent>
        {routes.length === 0 ? (
          <p className="px-2.5 py-1 text-xs text-sidebar-foreground/50">{hint}</p>
        ) : (
          <SidebarMenu className="gap-0.5">
            {routes.map((route) => (
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
  )
}
