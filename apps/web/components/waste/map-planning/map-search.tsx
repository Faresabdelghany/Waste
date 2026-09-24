"use client"

// The toolbar search (2026-09-16): type an address, a container id, or a
// planning-area name; pick a hit to fly the map there. A plain combobox —
// the hits come from lib/map-planning/search.ts over the points and area
// layers the page already holds, so nothing leaves the browser.

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Cube, MagnifyingGlass, MapPin, MapTrifold } from "@phosphor-icons/react/dist/ssr"

import { Input } from "@/components/ui/input"
import type { PlanningAreaLayer } from "@waste/domain/map-planning/areas"
import type { MapPoint } from "@waste/domain/map-planning/points"
import { searchMap, type SearchHit, type SearchHitKind } from "@/lib/map-planning/search"
import { cn } from "@/lib/utils"

const HIT_ICONS: Readonly<Record<SearchHitKind, typeof MapPin>> = {
  property: MapPin,
  container: Cube,
  area: MapTrifold,
}

export function MapSearch({
  points,
  areas,
  onPick,
  className,
}: {
  points: readonly MapPoint[]
  areas: readonly PlanningAreaLayer[]
  onPick: (hit: SearchHit) => void
  className?: string
}) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const hits = useMemo(() => searchMap(query, points, areas), [areas, points, query])
  const showList = open && query.trim().length > 0

  useEffect(() => setActive(0), [query])

  // Click outside closes the list.
  useEffect(() => {
    if (!showList) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [showList])

  const pick = (hit: SearchHit) => {
    onPick(hit)
    setQuery(hit.label)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        role="combobox"
        aria-label="Search the map"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
        placeholder="Search address, container, or area"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault()
            setOpen(true)
            setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)))
          } else if (event.key === "ArrowUp") {
            event.preventDefault()
            setActive((index) => Math.max(index - 1, 0))
          } else if (event.key === "Enter") {
            const hit = hits[active]
            if (showList && hit) {
              event.preventDefault()
              pick(hit)
            }
          } else if (event.key === "Escape") {
            setOpen(false)
          }
        }}
        className="h-8 w-64 pl-8 text-xs"
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Search results"
          className="absolute left-0 top-full z-50 mt-1 w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-md border border-border bg-popover p-1 text-xs shadow-md"
        >
          {hits.length === 0 ? (
            <li className="px-2 py-1.5 text-muted-foreground">No matches for “{query.trim()}”</li>
          ) : (
            hits.map((hit, index) => {
              const Icon = HIT_ICONS[hit.kind]
              return (
                <li
                  key={hit.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5",
                    index === active && "bg-accent",
                  )}
                  onPointerEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(hit)}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{hit.label}</span>
                    <span className="block truncate text-muted-foreground">{hit.sublabel}</span>
                  </span>
                </li>
              )
            })
          )}
        </ul>
      )}
    </div>
  )
}
