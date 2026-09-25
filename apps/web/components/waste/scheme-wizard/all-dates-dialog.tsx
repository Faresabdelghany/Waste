"use client"

// "View all" (Issue #40): the whole next-dates list — every row the preview
// generated over the scheme's window, not the first rows the step 2 table
// shows — in a nested dialog with its own scroll. The rows are the same
// occurrencePreview rows the table reads; nothing is generated twice.

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { count } from "@waste/domain/text"
import {
  formatOccurrenceDate,
  type OccurrencePreview,
} from "@waste/domain/route-schemes/occurrences"
import { SERVICE_DAY_LABELS, serviceDayOf } from "@waste/domain/route-schemes/recurrence"

import { OccurrenceStatusBadge } from "./occurrence-status-badge"

export function AllDatesDialog({
  open,
  onOpenChange,
  occurrences,
  startTime,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  occurrences: OccurrencePreview
  /** The scheme's planned start, already formatted ("06:30"); empty when it has none. */
  startTime: string
}) {
  const span = occurrences.ongoing
    ? "the next 12 months"
    : occurrences.horizon
      ? `until ${formatOccurrenceDate(occurrences.horizon)}`
      : ""
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] max-w-3xl flex-col gap-0 overflow-hidden rounded-2xl bg-background p-0 sm:max-w-3xl"
        data-testid="all-dates-dialog"
      >
        <DialogHeader className="px-6 pb-4 pt-6 text-left">
          <DialogTitle className="text-lg">All next dates</DialogTitle>
          <DialogDescription>
            {count(occurrences.count, "collection")}
            {span ? ` · ${span}` : ""}
            {occurrences.rows.length > occurrences.count
              ? ` · ${count(occurrences.rows.length - occurrences.count, "skipped holiday")}`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 pl-6">#</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Day</TableHead>
                <TableHead>ISO week</TableHead>
                <TableHead>Start</TableHead>
                <TableHead className="pr-6">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {occurrences.rows.map((row, index) => (
                <TableRow
                  key={`${row.plannedDate}-${index}`}
                  className={row.status === "skipped" ? "text-muted-foreground" : undefined}
                >
                  <TableCell className="pl-6 tabular-nums text-muted-foreground">
                    {row.n ?? "—"}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatOccurrenceDate(row.date)}</TableCell>
                  <TableCell>{SERVICE_DAY_LABELS[serviceDayOf(row.date)]}</TableCell>
                  <TableCell className="tabular-nums">{row.week}</TableCell>
                  <TableCell className="tabular-nums">{startTime}</TableCell>
                  <TableCell className="pr-6">
                    <OccurrenceStatusBadge row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter className="border-t border-border px-6 py-4">
          <Button variant="outline" className="rounded-xl" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
