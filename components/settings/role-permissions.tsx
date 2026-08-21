"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  CaretDown,
  CaretLeft,
  MagnifyingGlass,
} from "@phosphor-icons/react/dist/ssr"

import { useOrganizationStore } from "@/components/settings/organization-store"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ROLE_PERMISSION_ACTIONS,
  ROLE_PERMISSION_ACTION_LABELS,
  effectiveRoleAccess,
  rolePermissionCellCount,
  rolePermissionSections,
  type RoleAccessMap,
  type RolePermissionAction,
  type RolePermissionSection,
} from "@/lib/data/role-permissions"
import { cn } from "@/lib/utils"

type AccessDraft = Map<string, Set<RolePermissionAction>>

function sectionDomId(sectionId: string) {
  return `role-permission-section-${sectionId}`
}

function grantInDraft(
  draft: AccessDraft,
  key: string,
  action: RolePermissionAction,
) {
  const actions = draft.get(key) ?? new Set<RolePermissionAction>()
  actions.add(action)
  // Editing, creating, or deleting a record implies seeing it.
  if (action !== "view") actions.add("view")
  draft.set(key, actions)
}

function revokeInDraft(
  draft: AccessDraft,
  key: string,
  action: RolePermissionAction,
) {
  const actions = draft.get(key)
  if (!actions) return
  if (action === "view") {
    actions.clear()
  } else {
    actions.delete(action)
  }
}

function ProgressRing({ value }: { value: number }) {
  const radius = 7
  const circumference = 2 * Math.PI * radius
  return (
    <svg viewBox="0 0 18 18" className="size-4 -rotate-90" aria-hidden="true">
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        className="stroke-border"
      />
      {value > 0 && (
        <circle
          cx="9"
          cy="9"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.min(value, 1))}
          className="stroke-primary"
        />
      )}
    </svg>
  )
}

function triState(granted: number, total: number): boolean | "indeterminate" {
  if (granted === 0) return false
  return granted === total ? true : "indeterminate"
}

function PermissionSectionCard({
  section,
  visibleItems,
  open,
  onOpenChange,
  hasAction,
  onToggleCell,
  onToggleColumn,
  onToggleSection,
}: {
  section: RolePermissionSection
  visibleItems: RolePermissionSection["items"]
  open: boolean
  onOpenChange: (open: boolean) => void
  hasAction: (key: string, action: RolePermissionAction) => boolean
  onToggleCell: (
    key: string,
    action: RolePermissionAction,
    granted: boolean,
  ) => void
  onToggleColumn: (
    section: RolePermissionSection,
    action: RolePermissionAction,
    granted: boolean,
  ) => void
  onToggleSection: (section: RolePermissionSection, granted: boolean) => void
}) {
  const totalCells = section.items.length * ROLE_PERMISSION_ACTIONS.length
  const grantedCells = section.items.reduce(
    (sum, item) =>
      sum +
      ROLE_PERMISSION_ACTIONS.filter((action) => hasAction(item.key, action))
        .length,
    0,
  )
  const columnGranted = (action: RolePermissionAction) =>
    section.items.filter((item) => hasAction(item.key, action)).length

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <section className="overflow-hidden rounded-xl border border-border/60">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-muted/40"
          >
            <CaretDown
              weight="bold"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90"
            />
            <span className="text-sm font-semibold text-foreground">
              {section.label}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
              {grantedCells}/{totalCells}
              <ProgressRing value={totalCells === 0 ? 0 : grantedCells / totalCells} />
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/60">
            <label className="flex w-fit cursor-pointer items-center gap-2.5 px-4 py-3 text-sm text-foreground">
              <Checkbox
                checked={triState(grantedCells, totalCells)}
                onCheckedChange={(checked) =>
                  onToggleSection(section, checked === true)
                }
              />
              All permissions for {section.label}
            </label>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="h-10 pl-4 text-xs">
                    Items / Actions
                  </TableHead>
                  {ROLE_PERMISSION_ACTIONS.map((action) => (
                    <TableHead key={action} className="h-10 w-[132px]">
                      <label className="flex w-fit cursor-pointer items-center gap-2 whitespace-nowrap text-xs font-medium text-foreground">
                        <Checkbox
                          checked={triState(
                            columnGranted(action),
                            section.items.length,
                          )}
                          onCheckedChange={(checked) =>
                            onToggleColumn(section, action, checked === true)
                          }
                        />
                        {ROLE_PERMISSION_ACTION_LABELS[action]}
                      </label>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleItems.map((item) => (
                  <TableRow key={item.key} className="last:border-b-0">
                    <TableCell className="py-3 pl-4 text-foreground">
                      {item.label}
                    </TableCell>
                    {ROLE_PERMISSION_ACTIONS.map((action) => (
                      <TableCell key={action}>
                        <Checkbox
                          checked={hasAction(item.key, action)}
                          aria-label={`${ROLE_PERMISSION_ACTION_LABELS[action]} — ${item.label}`}
                          onCheckedChange={(checked) =>
                            onToggleCell(item.key, action, checked === true)
                          }
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

export function RolePermissionsPanel({
  roleId,
  userCount,
  onBack,
}: {
  roleId: string
  userCount: number
  onBack: () => void
}) {
  const { roles, updateRoleAccess } = useOrganizationStore()
  const [query, setQuery] = useState("")
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const [activeSectionId, setActiveSectionId] = useState<string | null>(
    rolePermissionSections[0]?.id ?? null,
  )
  const navRef = useRef<HTMLElement | null>(null)
  // While a menu click smooth-scrolls, the spy would sweep through the
  // sections in between; hold it briefly so the clicked item stays active.
  const spySuppressedUntil = useRef(0)

  const role = roles.find((candidate) => candidate.id === roleId)
  const access = useMemo(
    () => (role ? effectiveRoleAccess(role) : {}),
    [role],
  )

  const normalizedQuery = query.trim().toLowerCase()
  const visibleSections = useMemo(() => {
    if (!normalizedQuery) {
      return rolePermissionSections.map((section) => ({
        section,
        items: section.items,
      }))
    }
    return rolePermissionSections
      .map((section) => ({
        section,
        items: section.label.toLowerCase().includes(normalizedQuery)
          ? section.items
          : section.items.filter((item) =>
              item.label.toLowerCase().includes(normalizedQuery),
            ),
      }))
      .filter((entry) => entry.items.length > 0)
  }, [normalizedQuery])

  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      if (Date.now() < spySuppressedUntil.current) return
      // The sticky menu's top edge marks the visible top of the scroll area,
      // whichever container the settings shell scrolls in. The "current"
      // line sits a third down so short sections near the end of the page —
      // which can never reach the very top — still become active.
      const navTop = navRef.current?.getBoundingClientRect().top ?? 96
      const threshold = navTop + window.innerHeight * 0.3
      let current: string | null = null
      for (const { section } of visibleSections) {
        const element = document.getElementById(sectionDomId(section.id))
        if (!element) continue
        if (element.getBoundingClientRect().top <= threshold) {
          current = section.id
        } else {
          break
        }
      }
      setActiveSectionId(current ?? visibleSections[0]?.section.id ?? null)
    }
    const requestMeasure = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener("scroll", requestMeasure, true)
    window.addEventListener("resize", requestMeasure)
    return () => {
      window.removeEventListener("scroll", requestMeasure, true)
      window.removeEventListener("resize", requestMeasure)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [visibleSections, openSections])

  const goToSection = (sectionId: string) => {
    setOpenSections((current) => ({ ...current, [sectionId]: true }))
    setActiveSectionId(sectionId)
    spySuppressedUntil.current = Date.now() + 1000
    // Scroll only after the expanded section has painted — a layout shift
    // during a smooth scroll makes the browser abandon it midway.
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .getElementById(sectionDomId(sectionId))
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      ),
    )
  }

  if (!role) {
    return (
      <div className="flex flex-1 flex-col">
        <header className="flex items-center gap-1.5 border-b border-border px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
            onClick={onBack}
          >
            <CaretLeft className="h-3.5 w-3.5" weight="bold" />
            Roles
          </Button>
        </header>
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
          This role no longer exists.
        </div>
      </div>
    )
  }

  const hasAction = (key: string, action: RolePermissionAction) =>
    access[key]?.includes(action) ?? false

  const applyAccess = (mutate: (draft: AccessDraft) => void) => {
    const draft: AccessDraft = new Map(
      Object.entries(access).map(([key, actions]) => [key, new Set(actions)]),
    )
    mutate(draft)
    const next: RoleAccessMap = {}
    for (const [key, actions] of draft) {
      if (actions.size > 0) {
        next[key] = ROLE_PERMISSION_ACTIONS.filter((action) =>
          actions.has(action),
        )
      }
    }
    updateRoleAccess({ roleId: role.id, access: next })
  }

  const toggleCell = (
    key: string,
    action: RolePermissionAction,
    granted: boolean,
  ) =>
    applyAccess((draft) =>
      granted ? grantInDraft(draft, key, action) : revokeInDraft(draft, key, action),
    )

  const toggleColumn = (
    section: RolePermissionSection,
    action: RolePermissionAction,
    granted: boolean,
  ) =>
    applyAccess((draft) => {
      for (const item of section.items) {
        if (granted) grantInDraft(draft, item.key, action)
        else revokeInDraft(draft, item.key, action)
      }
    })

  const toggleSection = (section: RolePermissionSection, granted: boolean) =>
    applyAccess((draft) => {
      for (const item of section.items) {
        if (granted) {
          for (const action of ROLE_PERMISSION_ACTIONS) {
            grantInDraft(draft, item.key, action)
          }
        } else {
          draft.delete(item.key)
        }
      }
    })

  const grantedTotal = rolePermissionSections.reduce(
    (sum, section) =>
      sum +
      section.items.reduce(
        (itemSum, item) =>
          itemSum +
          ROLE_PERMISSION_ACTIONS.filter((action) =>
            hasAction(item.key, action),
          ).length,
        0,
      ),
    0,
  )

  const firstSectionId = rolePermissionSections[0]?.id

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center gap-1.5 border-b border-border px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 gap-1 px-2 text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <CaretLeft className="h-3.5 w-3.5" weight="bold" />
          Roles
        </Button>
        <span className="text-sm text-muted-foreground">/</span>
        <p className="text-base font-medium text-foreground">{role.name}</p>
      </header>
      <div className="flex-1 p-4">
        <div className="mx-auto flex w-full max-w-[1500px] items-start gap-6">
          <nav
            ref={navRef}
            aria-label="Permission sections"
            className="sticky top-4 hidden w-48 shrink-0 lg:block"
          >
            <div className="flex h-6 items-center px-2.5 text-sm font-medium text-muted-foreground/70">
              Sections
            </div>
            <div className="mt-0.5 flex flex-col gap-0.5">
              {visibleSections.map(({ section }) => {
                const isActive = section.id === activeSectionId
                return (
                  <button
                    key={section.id}
                    type="button"
                    onClick={() => goToSection(section.id)}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "flex h-7 cursor-pointer items-center rounded-md px-2.5 text-left text-xs font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      isActive && "bg-muted font-medium text-foreground",
                    )}
                  >
                    <span className="truncate">{section.label}</span>
                  </button>
                )
              })}
              {visibleSections.length === 0 && (
                <p className="px-2.5 py-1 text-xs text-muted-foreground">
                  No sections match.
                </p>
              )}
            </div>
          </nav>
          <div className="min-w-0 flex-1 space-y-4">
            <section className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg font-semibold tracking-tight">
                    {role.name}
                  </h1>
                  <Badge variant="muted">{role.type}</Badge>
                  <Badge
                    variant="outline"
                    className="rounded-full font-normal text-muted-foreground"
                  >
                    {role.scope}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {userCount} {userCount === 1 ? "user" : "users"}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{role.permissions}</p>
                <p className="text-xs text-muted-foreground">
                  Permission changes apply immediately and are saved on this
                  device.
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-medium tabular-nums text-foreground">
                  {grantedTotal} of {rolePermissionCellCount}
                </p>
                <p className="text-xs text-muted-foreground">
                  permissions granted
                </p>
              </div>
            </section>
  
            <div className="relative max-w-sm">
              <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pages and modules"
                className="h-8 pl-9 text-sm"
              />
            </div>
  
            <div className="space-y-3">
              {visibleSections.map(({ section, items }) => (
                <div
                  key={section.id}
                  id={sectionDomId(section.id)}
                  className="scroll-mt-4"
                >
                  <PermissionSectionCard
                    section={section}
                    visibleItems={items}
                    open={
                      normalizedQuery
                        ? true
                        : (openSections[section.id] ??
                          section.id === firstSectionId)
                    }
                    onOpenChange={(open) =>
                      setOpenSections((current) => ({
                        ...current,
                        [section.id]: open,
                      }))
                    }
                    hasAction={hasAction}
                    onToggleCell={toggleCell}
                    onToggleColumn={toggleColumn}
                    onToggleSection={toggleSection}
                  />
                </div>
              ))}
              {visibleSections.length === 0 && (
                <section className="rounded-xl border border-border/60 px-4 py-14 text-center">
                  <MagnifyingGlass className="mx-auto h-6 w-6 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">
                    No pages match your search.
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try a different search term.
                  </p>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
