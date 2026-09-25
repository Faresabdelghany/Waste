"use client"

// The status badge a next-dates row wears — Planned, Shifted from …, Skipped ·
// …, Holiday · … — shared by the step 2 table, the View all dialog, and the
// simulation so a status reads the same wherever a row appears.

import { Badge } from "@/components/ui/badge"
import { shiftedNote, type Occurrence } from "@waste/domain/route-schemes/occurrences"

export function OccurrenceStatusBadge({ row }: { row: Occurrence }) {
  if (row.status === "planned") return <Badge variant="secondary">Planned</Badge>
  if (row.status === "shifted") {
    return (
      <Badge variant="secondary" className="bg-amber-50 text-amber-800">
        Shifted {shiftedNote(row)}
      </Badge>
    )
  }
  if (row.status === "skipped") {
    return <Badge variant="muted">Skipped · {row.note}</Badge>
  }
  return (
    <Badge variant="secondary" className="bg-amber-50 text-amber-800">
      Holiday · {row.note}
    </Badge>
  )
}
