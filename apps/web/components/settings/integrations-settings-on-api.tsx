"use client"

// Settings › Administration › Integrations on the Pilot (#487): the services
// this deployment calls, from `GET /integrations` — the routing provider with
// its quota (`GET /routing/quota`, read where the role views the routes), the
// address register or none, and whether the proofs' Storage is set up — and
// the latest CSV import (`GET /imports`, where the role views the imports),
// each in a sentence (`integrationRowsOf`, lib/data/integrations.ts). Vendor
// connectors the deployment does not make — a GPS feed, an ERP, Digital Post,
// regulatory reporting — are not shown: no API holds them. Fixture mode
// keeps the browser's pane (`configure.integrations`).

import { useState } from "react"
import Link from "next/link"
import { ArrowClockwise, CheckCircle, Gear, Warning } from "@phosphor-icons/react/dist/ssr"

import { AssetPanelShell } from "@/components/settings/asset-management-settings"
import { useReport } from "@/components/insight/use-report"
import { Button } from "@/components/ui/button"
import { useApiSession } from "@/components/waste/api-session-store"
import { allows } from "@/lib/api/grants"
import { recentImportRuns } from "@/lib/api/imports"
import { deploymentIntegrations } from "@/lib/api/integrations"
import { problemSentence } from "@/lib/api/problem"
import { routingQuota } from "@/lib/api/routing"
import { importRow, integrationRowsOf, type IntegrationRow, type IntegrationTone } from "@/lib/data/integrations"
import { cn } from "@/lib/utils"

/** The module whose `view` reads the deployment's connections. */
const INTEGRATIONS_MODULE = "configure.integrations"

export function IntegrationsSettingsOnApi() {
  const { me } = useApiSession()
  const grants = me?.role.grants
  const granted = allows(grants, INTEGRATIONS_MODULE, "view")
  const readsQuota = allows(grants, "route-studio.routes", "view")
  const readsImports = allows(grants, "improve.imports", "view")
  const [reading, setReading] = useState(0)
  // The instant a quota's resumption is read against: when the pane was opened or last refreshed.
  const [now, setNow] = useState(() => new Date())
  const integrations = useReport(granted ? `integrations:${reading}` : null, deploymentIntegrations)
  const quota = useReport(granted && readsQuota ? `routing-quota:${reading}` : null, routingQuota)
  const imports = useReport(granted && readsImports ? `imports:${reading}` : null, (client) => recentImportRuns(client, { limit: 1 }))

  const rows: IntegrationRow[] =
    integrations.shown === null
      ? []
      : [
          ...integrationRowsOf({ integrations: integrations.shown, quota: quota.shown, now }),
          ...(imports.shown === null ? [] : [importRow(imports.shown.items[0] ?? null)]),
        ]

  return (
    <AssetPanelShell
      heading="Administration"
      title="Integrations"
      description="The services this deployment calls, which way data goes, and their state."
      toolbar={null}
      action={
        granted ? (
          <Button variant="outline" size="sm" onClick={() => {
              setNow(new Date())
              setReading((count) => count + 1)
            }} disabled={integrations.loading}>
            <ArrowClockwise className="h-4 w-4" />
            Refresh
          </Button>
        ) : null
      }
    >
      <section className="rounded-xl border border-border/60" aria-labelledby="integrations-connections">
        <h3 id="integrations-connections" className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          Connections
        </h3>
        {!granted && <p className="px-4 py-6 text-sm text-muted-foreground">The integrations are not shown to your role.</p>}
        {granted && integrations.problem !== null && <p className="px-4 py-6 text-sm text-muted-foreground">The integrations could not be read: {problemSentence(integrations.problem)}</p>}
        {granted && integrations.problem === null && integrations.shown === null && <p className="px-4 py-6 text-sm text-muted-foreground">Reading the integrations…</p>}
        {rows.length > 0 && (
          <ul aria-label="Connections" className={cn("divide-y divide-border/60", integrations.loading && "opacity-60")}>
            {rows.map((row) => (
              <li key={row.id} className="grid gap-2 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(240px,0.8fr)] md:items-center">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{row.name}</span>
                    <span className="rounded-full border px-2 py-0 text-[10px] text-muted-foreground">{row.direction}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{row.description}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <State tone={row.tone} value={row.state} />
                  {row.id === "imports" && (
                    <Link href="/improve/imports" className="text-xs text-primary underline-offset-4 hover:underline">
                      Open imports
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </AssetPanelShell>
  )
}

function State({ tone, value }: { tone: IntegrationTone; value: string }) {
  const Icon = tone === "healthy" ? CheckCircle : tone === "neutral" ? Gear : Warning
  const className = tone === "healthy" ? "text-emerald-600" : tone === "danger" ? "text-rose-600" : tone === "warning" ? "text-amber-600" : "text-muted-foreground"
  return (
    <span className={cn("inline-flex items-center gap-2 text-xs font-medium", className)}>
      <Icon className="h-4 w-4" weight={tone === "healthy" || tone === "danger" ? "fill" : "regular"} />
      {value}
    </span>
  )
}
