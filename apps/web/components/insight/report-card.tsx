"use client"

// The frame every card of the Dashboard on the Pilot sits in (#292), and the
// one way a card says it has nothing to show: not shown to the role (the
// grant the report's rows are read under), refused or unreachable (the API's
// sentence), or not read yet. A card whose read is on its way keeps what it
// showed, greyed, so the frame holds still.

import type { ReactNode } from "react"

import { problemSentence, type Problem } from "@/lib/api/problem"
import { cn } from "@/lib/utils"

export function ReportCard({ title, subtitle, actions, children, loading = false, className, testId }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode; loading?: boolean; className?: string; testId?: string }) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-lg border border-border/70 bg-card/55", className)} data-testid={testId} aria-busy={loading}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/70 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle !== undefined && <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className={cn("transition-opacity", loading && "opacity-60")}>{children}</div>
    </section>
  )
}

/** What a card says in place of its numbers. */
export function ReportNotice({ notGranted, problem, empty }: { notGranted?: string; problem?: Problem | null; empty?: string }) {
  const sentence = notGranted !== undefined ? `The ${notGranted} are not shown to your role.` : problem ? problemSentence(problem) : (empty ?? "Reading…")
  return (
    <p role={problem ? "alert" : "status"} className="px-4 py-8 text-center text-xs text-muted-foreground">
      {sentence}
    </p>
  )
}
