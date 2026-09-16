// The small status pill Map Planning's panel and route card share
// (2026-09-16): green for live statuses, amber for the ones that need an eye,
// plain for the rest.

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const POSITIVE_STATUSES = new Set(["active", "scheduled", "effective", "valid"])
const WARNING_STATUSES = new Set(["expiring", "overlap", "validated", "upcoming", "draft"])

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const key = status.trim().toLowerCase()
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 shrink-0 px-1.5 text-[10px] font-medium",
        POSITIVE_STATUSES.has(key) &&
          "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
        WARNING_STATUSES.has(key) &&
          "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
        className,
      )}
    >
      {status}
    </Badge>
  )
}
