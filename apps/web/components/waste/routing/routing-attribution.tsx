"use client"

// The attribution a map owes the routing provider's geometry (#173, #124
// §6: OpenRouteService's results are CC-BY-SA 4.0): the directions sentence
// while any drawn road is its, and VROOM's while any drawn trip an optimiser
// ordered is; nothing while the roads drawn are no provider's data — the
// fake's straight legs — or there are none. Laid over the map's corner, out
// of the pointer's way.

import { attributionFor, type AttributionSource } from "@/lib/routing/readings"
import { cn } from "@/lib/utils"

export function RoutingAttribution({ sources, className }: { sources: Iterable<AttributionSource>; className?: string }) {
  const lines = attributionFor(sources)
  if (lines.length === 0) return null
  return (
    <div
      data-testid="routing-attribution"
      className={cn("pointer-events-none absolute bottom-1 left-1 z-10 max-w-[75%] rounded bg-background/85 px-1.5 py-0.5 text-[10px] leading-snug text-muted-foreground", className)}
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}
