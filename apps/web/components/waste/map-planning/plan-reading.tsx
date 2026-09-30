"use client"

// The route card's routing line (#173, #132 §5): what the route's active
// Plan reads — Not measured, Measuring…, Waiting for routing quota, the
// totals, Routing failed with Retry, Stale — from use-plan-legs.ts. Retry is
// Optimise, offered only where it can be asked.

import { Button } from "@/components/ui/button"
import type { PlanReading } from "@/lib/map-planning/plan-readings"

const NOT_MEASURED: PlanReading = { kind: "not-measured", sentence: "Not measured", retry: false }

export function PlanReadingRow({ reading = NOT_MEASURED, onRetry }: { reading?: PlanReading; onRetry: (() => void) | null }) {
  return (
    <>
      <dt className="text-muted-foreground">Routing</dt>
      <dd className="flex min-w-0 items-center gap-2" data-testid="route-card-routing" data-reading={reading.kind}>
        <span className="min-w-0 flex-1 truncate tabular-nums" title={reading.sentence}>
          {reading.sentence}
        </span>
        {reading.retry && (
          <Button variant="outline" size="sm" className="h-6 shrink-0 px-2 text-xs" disabled={onRetry === null} onClick={onRetry ?? undefined}>
            Retry
          </Button>
        )}
      </dd>
    </>
  )
}
