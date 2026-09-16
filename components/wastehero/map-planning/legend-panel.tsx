"use client"

// The map legend (2026-09-16): the fraction colours the markers use and the
// marker grammar, behind a button beside the Layers control so the map
// stays clear until someone asks.

import { ListBullets } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SELECTION_COLOR } from "@/lib/map-planning/colors"
import { cn } from "@/lib/utils"

export type LegendEntry = { fraction: string; color: string; count: number }

export function LegendPanel({
  entries,
  className,
}: {
  entries: readonly LegendEntry[]
  className?: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 gap-1.5 bg-background/95 text-xs shadow-sm", className)}
        >
          <ListBullets className="h-4 w-4" />
          Legend
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-60 space-y-3 p-3 text-xs" aria-label="Legend">
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Waste fractions
          </p>
          {entries.length === 0 ? (
            <p className="text-muted-foreground">No containers on the map.</p>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => (
                <li key={entry.fraction} className="flex items-center gap-2">
                  <span
                    className="size-3 shrink-0 rounded-full border border-background shadow"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="flex-1 truncate">{entry.fraction}</span>
                  <span className="font-mono text-muted-foreground">{entry.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Markers
          </p>
          <ul className="space-y-1 text-muted-foreground">
            <li className="flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-[10px] font-semibold text-foreground">
                12
              </span>
              <span>Containers nearby — click to zoom</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="flex shrink-0 items-center">
                <span className="size-3 rounded-full border border-background bg-emerald-600" />
                <span className="-ml-1 size-3 rounded-full border border-background bg-blue-600" />
              </span>
              <span>Fractions present in the cluster</span>
            </li>
            <li className="flex items-center gap-2">
              <span
                className="size-3 shrink-0 rounded-full bg-muted-foreground"
                style={{ boxShadow: `0 0 0 2px ${SELECTION_COLOR}` }}
              />
              <span>Selected</span>
            </li>
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  )
}
