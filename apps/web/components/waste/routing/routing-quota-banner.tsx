"use client"

// The one routing banner (#173, #132 §5): shown in Route Studio and in the
// guided setup's step 4 while a request family of the provider is spent or
// its key refused, off `GET /routing/quota` alone — "Waiting for routing
// quota: road measurements resume at 14:32", "Routing unavailable: key
// refused". A route's own waiting is its active Plan's, never this; nothing
// here gates dispatch or anything else, it only says.

import { Warning, WarningOctagon } from "@phosphor-icons/react/dist/ssr"

import { quotaBanner } from "@/lib/routing/readings"
import { cn } from "@/lib/utils"

import { useMinuteClock, useRoutingQuota } from "./use-routing-quota"

export function RoutingQuotaBanner({ className }: { className?: string }) {
  const quota = useRoutingQuota()
  const now = useMinuteClock()
  const banner = quotaBanner(quota, now)
  if (banner === null) return null
  const Icon = banner.tone === "refused" ? WarningOctagon : Warning
  return (
    <div
      role="status"
      data-testid="routing-quota-banner"
      data-tone={banner.tone}
      className={cn(
        "flex items-center gap-2 px-4 py-2 text-xs",
        banner.tone === "refused" ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200" : "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
        className,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span>{banner.sentence}</span>
    </div>
  )
}
