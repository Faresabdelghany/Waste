"use client"

// The status badge a next-dates row wears — Planned, Shifted from …, Skipped ·
// …, Holiday · … — shared by the step 2 table, the View all dialog, and the
// simulation so a status reads the same wherever a row appears.

import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/ui/status-badge"
import { shiftedNote, type Occurrence } from "@waste/domain/planning/occurrences"

export function OccurrenceStatusBadge({ row }: { row: Occurrence }) {
  if (row.status === "planned") return <Badge variant="secondary">Planned</Badge>
  if (row.status === "shifted") {
    return (
      <StatusBadge tone="warning">
        Shifted {shiftedNote(row)}
      </StatusBadge>
    )
  }
  if (row.status === "skipped") {
    return <Badge variant="muted">Skipped · {row.note}</Badge>
  }
  return (
    <StatusBadge tone="warning">
      Holiday · {row.note}
    </StatusBadge>
  )
}
