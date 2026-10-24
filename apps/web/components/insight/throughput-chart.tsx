"use client"

// The stops collected per interval of the window, beside the same interval
// of the period before (#292). One axis: both series are stops. This period
// is the accent's columns (`--chart-1`, validated against the card in both
// themes), the period before a 2px solid line in the de-emphasis gray, so
// the reader's eye goes to now; columns at most 24px with a 4px rounded top
// on one baseline, solid hairline gridlines, a legend for the two series and
// a tooltip that leads with the values. The table beside it (the schemes)
// and the tiles carry every number without hovering.

import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts"

import { countOf, type ThroughputPoint } from "@/lib/insight/dashboard"

function ThroughputTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || payload === undefined || payload.length === 0) return null
  const point = payload[0].payload as ThroughputPoint
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
      <p className="mb-1 text-[11px] text-muted-foreground">{point.label}</p>
      <p className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--chart-1)]" aria-hidden />
        <span className="font-semibold tabular-nums">{countOf(point.completed)}</span>
        <span className="text-muted-foreground">collected</span>
      </p>
      {point.missed > 0 && (
        <p className="mt-0.5 pl-[18px] text-muted-foreground">
          <span className="font-medium tabular-nums text-foreground">{countOf(point.missed)}</span> missed
        </p>
      )}
      <p className="mt-0.5 flex items-center gap-2">
        <span className="h-0.5 w-2.5 bg-muted-foreground" aria-hidden />
        <span className="font-semibold tabular-nums">{point.previous === null ? "—" : countOf(point.previous)}</span>
        <span className="text-muted-foreground">the period before</span>
      </p>
    </div>
  )
}

export function ThroughputChart({ points, intervalWord }: { points: readonly ThroughputPoint[]; intervalWord: string }) {
  return (
    <figure className="m-0" aria-label={`Pickups collected per ${intervalWord}, this period and the period before`}>
      <div className="flex flex-wrap items-center gap-3 px-4 pt-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px] bg-[var(--chart-1)]" aria-hidden />
          This period
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-muted-foreground" aria-hidden />
          The period before
        </span>
      </div>
      <div className="h-[240px] px-2 pb-2 pt-2 sm:px-3">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={[...points]} margin={{ top: 8, right: 8, left: -8, bottom: 0 }} barCategoryGap="24%">
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} interval="preserveStartEnd" minTickGap={16} />
            <YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} width={40} allowDecimals={false} />
            <Tooltip content={ThroughputTooltip} cursor={{ fill: "var(--accent)", opacity: 0.4 }} />
            <Bar dataKey="completed" name="This period" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
            <Line type="monotone" dataKey="previous" name="The period before" stroke="var(--muted-foreground)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dot={false} connectNulls={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </figure>
  )
}
