"use client"

// The rows of a preview or a commit (#291 slice 12): each row's spreadsheet
// number, its outcome, what it was matched on and, for a refusal, the API's
// sentence, the column it names first. A strip of outcomes above it narrows
// the table to one of them, the refusals being the ones a person fixes.

import { useState } from "react"

import type { ImportRowResult } from "@waste/contracts/imports"

import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { countsOf } from "@/lib/imports/import-file"
import { cn } from "@/lib/utils"

const OUTCOMES = [
  { id: "all", label: "All" },
  { id: "created", label: "New" },
  { id: "updated", label: "Changed" },
  { id: "unchanged", label: "Unchanged" },
  { id: "refused", label: "Refused" },
] as const

type OutcomeFilter = (typeof OUTCOMES)[number]["id"]

const OUTCOME_LABEL: Record<ImportRowResult["outcome"], string> = { created: "New", updated: "Changed", unchanged: "Unchanged", refused: "Refused" }

const OUTCOME_TONE: Record<ImportRowResult["outcome"], string> = {
  created: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  updated: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  unchanged: "border-border bg-muted/40 text-muted-foreground",
  refused: "border-destructive/30 bg-destructive/10 text-destructive",
}

export function OutcomeBadge({ outcome }: { outcome: ImportRowResult["outcome"] }) {
  return (
    <Badge variant="outline" className={cn("font-normal", OUTCOME_TONE[outcome])}>
      {OUTCOME_LABEL[outcome]}
    </Badge>
  )
}

export function ImportResultsTable({ results, testId }: { results: readonly ImportRowResult[]; testId?: string }) {
  const [filter, setFilter] = useState<OutcomeFilter>("all")
  const counts = countsOf(results)
  const shown = filter === "all" ? results : results.filter((result) => result.outcome === filter)
  return (
    <div className="min-w-0" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/70 px-4 py-2">
        <ToggleGroup type="single" size="sm" value={filter} onValueChange={(value) => value !== "" && setFilter(value as OutcomeFilter)} aria-label="Outcome">
          {OUTCOMES.map((option) => (
            <ToggleGroupItem key={option.id} value={option.id} className="h-7 px-2.5 text-xs" data-testid={`outcome-${option.id}`}>
              {option.label}
              <span className="ml-1.5 tabular-nums text-muted-foreground">{option.id === "all" ? results.length : counts[option.id]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="max-h-[480px] overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 text-xs">Row</TableHead>
              <TableHead className="w-28 text-xs">Outcome</TableHead>
              <TableHead className="text-xs">Matched on</TableHead>
              <TableHead className="text-xs">Why</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">
                  No rows came out this way.
                </TableCell>
              </TableRow>
            ) : (
              shown.map((result) => (
                <TableRow key={result.row} data-testid="import-result-row">
                  <TableCell className="text-xs tabular-nums">{result.row}</TableCell>
                  <TableCell>
                    <OutcomeBadge outcome={result.outcome} />
                  </TableCell>
                  <TableCell className="max-w-[320px] truncate text-xs" title={result.key ?? undefined}>
                    {result.key ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{result.detail ?? ""}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
