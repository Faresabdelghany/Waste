"use client"

// The selection bar (2026-09-16): what the drawn shapes picked, by
// container, property, and fraction, and what can happen to it — a Route
// Scheme through the Guided Setup wizard, an export, or nothing.

import { DownloadSimple, Plus, X } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import type { SelectionSummary } from "@/lib/map-planning/selection"
import { cn } from "@/lib/utils"

export function SelectionBar({
  summary,
  colorFor,
  canCreateScheme,
  onCreateScheme,
  onExport,
  onClear,
  className,
}: {
  summary: SelectionSummary
  colorFor: (fraction: string) => string
  canCreateScheme: boolean
  onCreateScheme: () => void
  onExport: () => void
  onClear: () => void
  className?: string
}) {
  return (
    <div
      role="region"
      aria-label="Selection"
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-xl border border-border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur",
        className,
      )}
    >
      <p className="font-medium">
        {summary.containers} container{summary.containers === 1 ? "" : "s"} selected
        <span className="text-muted-foreground">
          {" · "}
          {summary.properties} propert{summary.properties === 1 ? "y" : "ies"}
        </span>
      </p>
      {summary.byFraction.length > 0 && (
        <ul className="flex flex-wrap items-center gap-1.5">
          {summary.byFraction.map(([fraction, count]) => (
            <li
              key={fraction}
              className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5"
            >
              <span className="size-2 rounded-full" style={{ backgroundColor: colorFor(fraction) }} />
              {fraction} {count}
            </li>
          ))}
        </ul>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {canCreateScheme && (
          <Button size="sm" className="h-8" onClick={onCreateScheme}>
            <Plus className="h-4 w-4" weight="bold" />
            Create route scheme
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-8" onClick={onExport}>
          <DownloadSimple className="h-4 w-4" />
          Export
        </Button>
        <Button variant="ghost" size="sm" className="h-8" onClick={onClear} aria-label="Clear selection">
          <X className="h-4 w-4" />
          Clear
        </Button>
      </div>
    </div>
  )
}
