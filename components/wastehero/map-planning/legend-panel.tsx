"use client"

// The map legend (2026-09-16): the fraction colours the markers use and the
// marker grammar, so the dotted badges never need decoding by heart.

import { useState } from "react"
import { CaretDown, Stack } from "@phosphor-icons/react/dist/ssr"

import { Button } from "@/components/ui/button"
import { SELECTION_COLOR } from "@/lib/map-planning/colors"
import { cn } from "@/lib/utils"

export type LegendEntry = { fraction: string; color: string; count: number }

export function LegendPanel({
  entries,
  mode,
  className,
}: {
  entries: readonly LegendEntry[]
  mode: "containers" | "properties"
  className?: string
}) {
  const [open, setOpen] = useState(true)

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className={cn("h-8 gap-1.5 bg-background/95 text-xs shadow-sm", className)}
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-controls="map-planning-legend"
      >
        <Stack className="h-4 w-4" />
        Legend
      </Button>
    )
  }

  return (
    <section
      id="map-planning-legend"
      aria-label="Legend"
      className={cn(
        "w-60 rounded-lg border border-border bg-background/95 text-xs shadow-sm backdrop-blur",
        className,
      )}
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 font-medium">
          <Stack className="h-4 w-4" />
          Legend
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setOpen(false)}
          aria-label="Collapse legend"
          aria-expanded
          aria-controls="map-planning-legend"
        >
          <CaretDown className="h-3.5 w-3.5" />
        </Button>
      </header>
      <div className="space-y-3 px-3 py-2">
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
              <span>{mode === "containers" ? "Containers" : "Properties"} nearby — click to zoom</span>
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
      </div>
    </section>
  )
}
