"use client"

import type { ReactNode } from "react"

import { PageTopBar } from "@/components/page-layout"
import { Breadcrumbs } from "@/components/projects/Breadcrumbs"
import { StatRow } from "@/components/projects/StatRow"
import { recordStatusTone } from "@/components/waste/business-record-views"
import { StatusBadge } from "@/components/ui/status-badge"
import { RouteSurfacePage } from "@/components/waste/commands/route-surfaces"
import type { BusinessRecord, ModuleDefinition } from "@/lib/data/business-modules"

/**
 * A route's own page on the Pilot: its name and status in the top bar, its
 * commands, its stops first, and beside them what the route record says and
 * its History. Fixture mode's is `RouteDetailsPage`; the generic side panel
 * shows a route only where the workspace opens no page.
 */
export function RouteDetailsOnApi({
  module,
  record,
  onBack,
  history,
  menu,
}: {
  module: ModuleDefinition
  record: BusinessRecord
  onBack: () => void
  /** The route's History, the API's audit log of the row. */
  history?: ReactNode
  /** The record's own actions (Delete, …), at the end of the command bar. */
  menu?: ReactNode
}) {
  return (
    <section aria-label={record.name} className="flex min-h-0 flex-1 flex-col" data-testid="route-page">
      <header>
        <PageTopBar>
          <div className="flex flex-wrap items-center gap-2">
            <Breadcrumbs items={[{ label: module.label, onClick: onBack }, { label: record.name }]} />
            <StatusBadge tone={recordStatusTone(record.status)} className="rounded-full text-[11px]">
              {record.status}
            </StatusBadge>
          </div>
          {record.description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{record.description}</p>}
        </PageTopBar>
      </header>
      <RouteSurfacePage
        record={record}
        menu={menu}
        aside={
          <>
            <section className="rounded-xl border border-border/60" aria-labelledby="route-information-heading">
              <h3 id="route-information-heading" className="border-b border-border px-4 py-2.5 text-sm font-semibold">
                Route information
              </h3>
              <div className="divide-y divide-border/60 px-4">
                {Object.entries(record.facts).map(([label, value]) => (
                  <StatRow key={label} label={label} value={value} className="py-2.5" />
                ))}
              </div>
            </section>
            {history && <div className="rounded-xl border border-border/60 p-4 empty:hidden">{history}</div>}
          </>
        }
      />
    </section>
  )
}
