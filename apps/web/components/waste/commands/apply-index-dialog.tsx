"use client"
// Apply index over many prices on the Pilot (#291 C8): one dialog for a
// price list's rows (Settings › Commercial › Price lists) and for a
// provider's or an award's prices (the provider prices' header, an award's
// details). The office types the index — its label, the change as a percent,
// the day — and, for provider prices, the base; Preview asks the API the
// plan with `dryRun` and shows each price before and after, or why it stays;
// Apply sends the same body without it. Nothing is computed here: the prices
// are the API's (`indexedFee`, half away from zero), and a body changed after
// its preview is previewed again before it is applied. The day defaults to
// the project's (`defaultDay`, on its clock, never the browser's), and Preview
// says why it waits where it cannot be asked yet. The prices moved are read
// again by the caller's `onApplied`.
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { IndexLine, IndexResult } from "@waste/contracts/finance"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import { basisPointsOf, INDEX_REFUSAL, indexSummary, percentLabel, SKIP_SENTENCES } from "@/lib/commercial/indexation"
import { formatMinor } from "@/lib/commercial/money"

/** What the office typed, sent as the body's index. */
export type IndexTyped = { label: string; basisPoints: number; appliedFrom: string; base: "bid" | "current-fee" }

/** The dialog's own question beside the index: a scope picker, ready or not, and why not. */
export type ApplyIndexScope = { field: ReactNode; ready: boolean; waiting?: string }

export function ApplyIndexDialog({
  title,
  description,
  defaultDay,
  waiting,
  currencyOf,
  withBase = false,
  scope,
  scopeKey = "",
  nameOf,
  send,
  onApplied,
  onClose,
}: {
  title: string
  description: string
  /** The day the index applies from until one is typed: today on the project's clock. */
  defaultDay: string
  /** Why Preview cannot be asked yet — the rows a line is named by still being read — or undefined when it can. */
  waiting?: string
  /** A line's currency: its list's, or its project's for a provider price. */
  currencyOf: (line: IndexLine) => string
  /** Provider prices are indexed over the bid or the current fee; a customer row has its price alone. */
  withBase?: boolean
  scope?: ApplyIndexScope
  /** What the scope picker holds: a preview is of one scope, so a change asks again. */
  scopeKey?: string
  /** A line's price, by name: its product and, where it says more, its conditions. */
  nameOf: (line: IndexLine) => string
  send: (typed: IndexTyped, dryRun: boolean) => Promise<IndexResult>
  onApplied: (result: IndexResult) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState("")
  const [percent, setPercent] = useState("")
  const [typedDay, setTypedDay] = useState<string | null>(null)
  const appliedFrom = typedDay ?? defaultDay
  const [base, setBase] = useState<IndexTyped["base"]>("current-fee")
  const [preview, setPreview] = useState<{ of: string; result: IndexResult } | null>(null)
  const [busy, setBusy] = useState(false)

  const basisPoints = basisPointsOf(percent)
  const percentRefused = percent.trim() !== "" && Number.isNaN(basisPoints)
  const typed: IndexTyped = { label: label.trim(), basisPoints, appliedFrom, base }
  const held = waiting ?? (scope !== undefined && !scope.ready ? scope.waiting : undefined)
  const complete = typed.label !== "" && !Number.isNaN(basisPoints) && appliedFrom !== "" && (scope?.ready ?? true) && waiting === undefined
  // The preview shown is of exactly this body and scope; anything typed since asks again.
  const key = JSON.stringify([typed, withBase, scopeKey])
  const previewed = preview !== null && preview.of === key ? preview.result : null
  const moves = previewed?.lines.some((line) => line.skipped === null) ?? false

  const ask = (dryRun: boolean) => {
    if (busy || !complete) return
    setBusy(true)
    send(typed, dryRun)
      .then(
        (result) => {
          if (dryRun) setPreview({ of: key, result })
          else {
            toast.success("Index applied", { description: indexSummary(result) })
            onApplied(result)
          }
        },
        (error: unknown) => toast.error(dryRun ? "The index was not previewed" : "The index was not applied", { description: problemSentence(problemOfError(error)) }),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="apply-index">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {scope?.field}
          <div className="space-y-1.5">
            <Label htmlFor="apply-index-label">Index</Label>
            <Input id="apply-index-label" value={label} placeholder="CPI 2027" onChange={(event) => setLabel(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apply-index-percent">Change (%)</Label>
            <Input id="apply-index-percent" value={percent} placeholder="3.2" inputMode="decimal" aria-invalid={percentRefused} onChange={(event) => setPercent(event.target.value)} />
            <p className={percentRefused ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{percentRefused ? INDEX_REFUSAL : "Two decimals at most; negative for a deflator."}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="apply-index-from">From</Label>
            <Input id="apply-index-from" type="date" value={appliedFrom} onChange={(event) => setTypedDay(event.target.value)} />
          </div>
          {withBase && (
            <div className="space-y-1.5">
              <Label htmlFor="apply-index-base">Applied to</Label>
              <Select value={base} onValueChange={(value) => setBase(value as IndexTyped["base"])}>
                <SelectTrigger id="apply-index-base" aria-label="Applied to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current-fee">The current fee</SelectItem>
                  <SelectItem value="bid">The bid</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {held !== undefined && (
          <p className="text-sm text-muted-foreground" data-testid="apply-index-waiting">
            {held}
          </p>
        )}
        {previewed !== null && (
          <div className="space-y-2">
            <p className="text-sm" data-testid="apply-index-summary">
              {indexSummary(previewed)} {typed.label} {percentLabel(typed.basisPoints)} from {typed.appliedFrom}.
            </p>
            {previewed.lines.length > 0 && (
              <div className="max-h-[45vh] overflow-auto rounded-lg border border-border/60">
                <Table data-testid="apply-index-lines">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Price</TableHead>
                      <TableHead>Now</TableHead>
                      <TableHead>From {typed.appliedFrom}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewed.lines.map((line) => (
                      <TableRow key={line.id} data-skipped={line.skipped ?? undefined}>
                        <TableCell className="text-sm font-medium">{nameOf(line)}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{formatMinor(line.fromMinor, currencyOf(line))}</TableCell>
                        <TableCell className="text-sm">{line.toMinor === null ? <span className="text-muted-foreground">{line.skipped === null ? "—" : SKIP_SENTENCES[line.skipped]}</span> : formatMinor(line.toMinor, currencyOf(line))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy || !complete} onClick={() => ask(true)}>
            Preview
          </Button>
          <Button disabled={busy || !complete || !moves} onClick={() => ask(false)}>
            Apply index
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
