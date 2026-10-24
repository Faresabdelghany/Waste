"use client"

// The tonnage report's rolled-up rows as bars (#292, #290 O12): one series,
// the net weight that counts, in the accent (`--chart-1`), so no legend —
// the card's title names it. By fraction or by station the bars run
// horizontally, heaviest first, their names beside them and each value at
// its tip; by period they stand as columns on one baseline in the period's
// order. At most 24px thick with a 4px rounded data end, solid hairline
// grid, a tooltip that leads with the value and says how much of it is
// reviewed; the table under the chart holds every number without hovering.

import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts"

import { tonnageLabelOf, weightOf, type TonnageLine } from "@/lib/insight/dashboard"

type Datum = { key: string; label: string; netKg: number; approvedKg: number; capturedKg: number; rejectedKg: number }

function TonnageTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || payload === undefined || payload.length === 0) return null
  const datum = payload[0].payload as Datum
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm">
      <p className="mb-1 text-[11px] text-muted-foreground">{datum.label}</p>
      <p>
        <span className="font-semibold tabular-nums">{weightOf(datum.netKg)}</span> <span className="text-muted-foreground">net</span>
      </p>
      <p className="text-muted-foreground">
        <span className="tabular-nums text-foreground">{weightOf(datum.approvedKg)}</span> approved · <span className="tabular-nums text-foreground">{weightOf(datum.capturedKg)}</span> not reviewed
      </p>
      {datum.rejectedKg > 0 && (
        <p className="text-muted-foreground">
          <span className="tabular-nums text-foreground">{weightOf(datum.rejectedKg)}</span> rejected, not counted
        </p>
      )}
    </div>
  )
}

const compactKg = (kg: number) => (kg >= 1000 ? `${Math.round(kg / 100) / 10} t` : `${kg} kg`)

export function TonnageChart({ lines, orientation }: { lines: readonly TonnageLine[]; orientation: "bars" | "columns" }) {
  const data: Datum[] = lines.map((line) => ({ key: line.key, label: tonnageLabelOf(line), netKg: line.netKg, approvedKg: line.approvedKg, capturedKg: line.capturedKg, rejectedKg: line.rejectedKg }))
  if (orientation === "bars") {
    return (
      <div className="px-2 pb-2 pt-3 sm:px-3" style={{ height: Math.max(120, data.length * 36 + 32) }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 56, left: 8, bottom: 0 }} barCategoryGap="28%">
            <CartesianGrid horizontal={false} stroke="var(--border)" />
            <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} tickFormatter={compactKg} />
            <YAxis type="category" dataKey="label" axisLine={false} tickLine={false} width={140} tick={{ fill: "var(--foreground)", fontSize: 11 }} />
            <Tooltip content={TonnageTooltip} cursor={{ fill: "var(--accent)", opacity: 0.4 }} />
            <Bar dataKey="netKg" name="Net" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={false}>
              <LabelList dataKey="netKg" position="right" formatter={(value: number) => weightOf(value)} style={{ fill: "var(--muted-foreground)", fontSize: 11 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    )
  }
  return (
    <div className="h-[240px] px-2 pb-2 pt-3 sm:px-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -4, bottom: 0 }} barCategoryGap="24%">
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} interval="preserveStartEnd" minTickGap={16} />
          <YAxis axisLine={false} tickLine={false} tick={{ fill: "var(--muted-foreground)", fontSize: 10 }} width={48} tickFormatter={compactKg} />
          <Tooltip content={TonnageTooltip} cursor={{ fill: "var(--accent)", opacity: 0.4 }} />
          <Bar dataKey="netKg" name="Net" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
