"use client"

// Est. load per route: "3.8 t / 10 t", the percentage, and a thin bar —
// amber from 90 %, red above 100 %.

import type { RouteEstimate } from "@waste/domain/route-schemes/estimates"
import { cn } from "@/lib/utils"

export function LoadMeter({ estimate }: { estimate: RouteEstimate }) {
  const tone =
    estimate.pct > 100 ? "bg-red-500" : estimate.pct >= 90 ? "bg-amber-500" : "bg-emerald-500"
  return (
    <div className="min-w-32">
      <div className="flex items-center justify-between text-sm tabular-nums">
        <span>
          {estimate.loadT} t{" "}
          <span className="text-muted-foreground">/ {estimate.capacityT} t</span>
        </span>
        <span
          className={cn(
            estimate.pct > 100
              ? "text-red-600"
              : estimate.pct >= 90
                ? "text-amber-800"
                : "text-muted-foreground",
          )}
        >
          {estimate.pct}%
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full", tone)} style={{ width: `${Math.min(100, estimate.pct)}%` }} />
      </div>
    </div>
  )
}
