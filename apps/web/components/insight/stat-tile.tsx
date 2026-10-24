"use client"

// A stat tile of the Dashboard on the Pilot (#292): the label, the value,
// what it is out of, and its change against the named period before — an
// arrow and the words carrying the direction, the tone saying whether that
// is good news for this measure, never the colour alone. A change is only
// ever told from the two periods' own reads: while the period before is on
// its way the chip says so, and where it could not be read it says that,
// rather than comparing against whatever was read last. A tile whose read is
// on its way keeps its number greyed.

import type { ReactNode } from "react"
import { ArrowDown, ArrowRight, ArrowUp } from "@phosphor-icons/react/dist/ssr"

import type { Change } from "@/lib/insight/dashboard"
import { cn } from "@/lib/utils"

const TONE: Record<Change["tone"], string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  negative: "text-rose-600 dark:text-rose-400",
  neutral: "text-muted-foreground",
}

/** Where the period before stands: read, on its way, or not read. */
export type Comparison = "read" | "reading" | "unread"

/** The change against the period before, `against` being that period (`Oct 11 – Oct 17`). */
export function ChangeChip({ change, against, comparison = "read" }: { change: Change | null; against: string; comparison?: Comparison }) {
  if (comparison === "reading") return <p className="mt-2 truncate text-[11px] text-muted-foreground">Comparing with {against}…</p>
  if (comparison === "unread") return <p className="mt-2 truncate text-[11px] text-muted-foreground">{against} could not be read to compare</p>
  if (change === null) return <p className="mt-2 truncate text-[11px] text-muted-foreground">Nothing to compare in {against}</p>
  if (change.direction === "flat") {
    return (
      <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        <ArrowRight className="h-3 w-3" aria-hidden />
        <span className="truncate">The same as {against}</span>
      </p>
    )
  }
  const Arrow = change.direction === "up" ? ArrowUp : ArrowDown
  return (
    <p className={cn("mt-2 flex items-center gap-1 text-[11px] font-medium", TONE[change.tone])}>
      <Arrow className="h-3 w-3" aria-hidden />
      <span>
        {change.direction === "up" ? "Up" : "Down"} {change.text}
      </span>
      <span className="truncate font-normal text-muted-foreground">vs {against}</span>
    </p>
  )
}

export function StatTile({
  label,
  value,
  helper,
  change,
  against,
  comparison,
  loading = false,
  testId,
}: {
  label: string
  value: string
  helper: string
  change: Change | null
  against: string
  comparison?: Comparison
  loading?: boolean
  testId?: string
}) {
  return (
    <div className={cn("min-w-0 px-4 py-4 transition-opacity xl:px-5", loading && "opacity-60")} data-testid={testId} aria-busy={loading}>
      <p className="truncate text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground" data-testid={testId === undefined ? undefined : `${testId}-value`}>
        {value}
      </p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{helper}</p>
      <ChangeChip change={change} against={against} comparison={comparison} />
    </div>
  )
}

/** Where a pair of reads stands for a tile: the period before read, on its way, or not read. */
export const comparisonOf = (previous: { loading: boolean; problem: unknown }): Comparison => (previous.problem ? "unread" : previous.loading ? "reading" : "read")

/** A row of tiles, two across on a phone and four on a wide screen, hairlines between. */
export function StatRow({ children }: { children: ReactNode }) {
  return <section className="grid grid-cols-1 divide-y divide-border/70 border-b border-border/70 sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-4 xl:divide-x [&>*]:border-border/70 sm:[&>*:nth-child(-n+2)]:border-b xl:[&>*:nth-child(-n+2)]:border-b-0">{children}</section>
}
