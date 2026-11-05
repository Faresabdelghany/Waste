// The small status pill Map Planning's panel and route card share
// (2026-09-16): success for live statuses, warning for the ones that need an
// eye, neutral for the rest.

import { StatusBadge, type StatusTone } from "@/components/ui/status-badge"
import { cn } from "@/lib/utils"

const POSITIVE_STATUSES = new Set(["active", "scheduled", "effective", "valid"])
const WARNING_STATUSES = new Set(["expiring", "overlap", "validated", "upcoming", "draft"])

function mapStatusTone(status: string): StatusTone {
  const key = status.trim().toLowerCase()
  if (POSITIVE_STATUSES.has(key)) return "success"
  if (WARNING_STATUSES.has(key)) return "warning"
  return "neutral"
}

export function MapStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <StatusBadge outlined tone={mapStatusTone(status)} className={cn("h-5 shrink-0 px-1.5 text-[10px] font-medium", className)}>
      {status}
    </StatusBadge>
  )
}
