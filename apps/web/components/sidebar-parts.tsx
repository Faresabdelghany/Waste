"use client"

// The parts the office's sidebar and a service provider's share: the brand
// over the scope it works in, the search field, the pages it lists, and the
// route days pinned to it.
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState, type ComponentType } from "react"
import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr"

import { useBusinessRecordStore } from "@/components/platform/business-record-store"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
import { SEARCH_MIN_LENGTH, searchPages, searchRecords, type SearchPage, type SearchSource } from "@/lib/data/global-search"
import type { ModuleLocation } from "@/lib/modules/manifest"

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

/** A module the sidebar's Search reads, and the page its records open on where not its workspace's. */
export type SidebarSearchModule = { location: ModuleLocation; label: string; page?: string }

const SEARCH_FIELD_CLASS =
  "flex h-9 w-full items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/45 pl-8 pr-2 text-left text-sm text-sidebar-foreground/50 hover:bg-sidebar-accent/70 focus-visible:border-sidebar-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring/25"

/**
 * The sidebar's Search (#648): the field, or ⌘K / Ctrl+K anywhere, opens a
 * search of the sidebar's pages and of the records the store holds for
 * `modules`, which are only those the person's role views. A hit opens where
 * it lives.
 */
export function SidebarSearch({ pages, modules }: { pages: readonly SearchPage[]; modules: readonly SidebarSearchModule[] }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const router = useRouter()
  const { setOpenMobile } = useSidebar()
  const { getRecords } = useBusinessRecordStore()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // Read only while the search is open: the store's rows as they stand then.
  const sources: SearchSource[] = open ? modules.map((module) => ({ ...module, records: getRecords(module.location.workspaceId, module.location.moduleId) })) : []
  const hits = searchRecords(sources, query)
  const pageHits = searchPages(pages, query)
  const groups = [...new Set(hits.map((hit) => hit.group))]
  const searched = query.trim().length >= SEARCH_MIN_LENGTH

  const choose = (href: string) => {
    setOpen(false)
    setQuery("")
    setOpenMobile(false)
    router.push(href)
  }

  return (
    <SidebarGroup className="px-2 py-1.5">
      <div className="relative px-0 py-0">
        <MagnifyingGlass className="pointer-events-none absolute left-4 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-sidebar-foreground/55" />
        <Button variant="unstyled" type="button" className={SEARCH_FIELD_CLASS} aria-keyshortcuts="Meta+K Control+K" onClick={() => setOpen(true)}>
          Search
        </Button>
        <kbd className="pointer-events-none absolute right-4 top-1/2 hidden h-5 -translate-y-1/2 select-none items-center gap-1 rounded border border-sidebar-border bg-sidebar-accent px-1.5 font-mono text-[10px] font-medium text-sidebar-foreground/60 sm:flex">
          <span className="text-xs">⌘</span>K
        </kbd>
      </div>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
      >
        <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>Search</DialogTitle>
            <DialogDescription>Search the pages and the records you can open.</DialogDescription>
          </DialogHeader>
          <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-2">
            <CommandInput placeholder="Search pages and records" value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{searched ? `Nothing you can open matches “${query.trim()}”.` : "Type two letters or more to search the records."}</CommandEmpty>
              {pageHits.length > 0 && (
                <CommandGroup heading="Pages">
                  {pageHits.map((page) => (
                    <CommandItem key={page.href} value={`page:${page.href}`} onSelect={() => choose(page.href)}>
                      {page.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {groups.map((group) => (
                <CommandGroup key={group} heading={group}>
                  {hits
                    .filter((hit) => hit.group === group)
                    .map((hit) => (
                      <CommandItem key={hit.id} value={hit.id} onSelect={() => choose(hit.href)}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{hit.title}</span>
                          {hit.detail && <span className="truncate text-xs text-muted-foreground">{hit.detail}</span>}
                        </span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
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
