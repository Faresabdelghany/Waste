"use client"

// The Dashboard's Emissions card (M10 of #293), on the Performance tab: the
// planned CO₂e of the window's routes from `GET /reports/emissions`, read
// under Performance and the routes' grant like the service report beside it.
// It says the total, the routes it could not measure and why — counted,
// never summed as zero — and the optimiser's saving, then the totals by
// vehicle, by project, and by fraction split by stops, which the card names
// as the approximation it is. The words are lib/insight/emissions.ts'.

import { ReportCard, ReportNotice } from "./report-card"
import { useReport } from "./use-report"
import { emissionsKey, emissionsReport, type ReportWindowQuery } from "@/lib/api/reports"
import { fractionLabel, massOf, plannedSentence, savingSentence, shareOf, unmeasuredSentence, vehicleLabel } from "@/lib/insight/emissions"

type Row = { key: string; label: string; detail?: string; grams: number }

/** One group's rows, each with its share of the window's grams as a bar. */
function Breakdown({ title, rows, total }: { title: string; rows: readonly Row[]; total: number }) {
  return (
    <section className="min-w-0">
      <h3 className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">Nothing measured.</p>
      ) : (
        <ul className="divide-y divide-border/70">
          {rows.map((row) => (
            <li key={row.key} className="px-4 py-2">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-foreground">
                  {row.label}
                  {row.detail !== undefined && <span className="text-muted-foreground"> · {row.detail}</span>}
                </span>
                <span className="font-medium tabular-nums text-foreground">{massOf(row.grams)}</span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-muted" aria-hidden>
                <div className="h-1.5 rounded-full bg-[var(--chart-2)]" style={{ width: `${shareOf(row.grams, total) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function EmissionsCard({ current, routesShown }: { current: ReportWindowQuery; routesShown: boolean }) {
  const read = useReport(routesShown ? emissionsKey(current) : null, (client) => emissionsReport(client, current))
  const shown = read.shown
  const total = shown?.planned.grams ?? 0
  const unmeasured = shown === null ? "" : unmeasuredSentence(shown)
  const saving = shown === null ? "" : savingSentence(shown)

  return (
    <ReportCard title="Fleet emissions" subtitle="Planned CO₂e of the routes in this period, from each route's active Plan" loading={read.loading} testId="emissions">
      {routesShown && shown !== null && !read.problem ? (
        <div>
          <div className="space-y-1 border-b border-border/70 px-4 py-3">
            <p className="text-lg font-semibold tabular-nums text-foreground" data-testid="emissions-planned">
              {plannedSentence(shown)}
            </p>
            {unmeasured !== "" && (
              <p className="text-xs text-muted-foreground" data-testid="emissions-unmeasured">
                {unmeasured}
              </p>
            )}
            {saving !== "" && (
              <p className="text-xs text-muted-foreground" data-testid="emissions-saving">
                {saving}
              </p>
            )}
          </div>
          <div className="grid gap-x-2 pb-2 md:grid-cols-3">
            <Breakdown
              title="By vehicle"
              total={total}
              rows={shown.byVehicle.map((row) => ({ key: row.vehicleId, label: vehicleLabel(row), detail: `${row.routes} route${row.routes === 1 ? "" : "s"}`, grams: row.grams }))}
            />
            <Breakdown title="By project" total={total} rows={shown.byProject.map((row) => ({ key: row.projectId, label: row.name, grams: row.grams }))} />
            <Breakdown title="By fraction · split by stops" total={total} rows={shown.byFraction.map((row) => ({ key: row.wasteFractionId ?? "none", label: fractionLabel(row), grams: row.grams }))} />
          </div>
        </div>
      ) : (
        <ReportNotice notGranted={routesShown ? undefined : "routes"} problem={read.problem} />
      )}
    </ReportCard>
  )
}
