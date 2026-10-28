"use client"

// Settings › Administration › Privacy, audit & retention on the Pilot
// (#487): what the API holds of it today. The company's whole history is the
// audit log's read without a row (`GET /audit-events`, under `view` on
// `configure.privacy`), newest first, a page at a time, each request one
// entry naming the rows it touched (`companyHistoryEntriesOf`). Beside it, the
// two controls the platform truly enforces. The GPS purpose, the monitoring
// register and every retention policy are C19's (#381) and have no API yet,
// so they are not shown here; fixture mode keeps the browser's pane
// (`configure.privacy`).

import { useState } from "react"
import { ArrowClockwise } from "@phosphor-icons/react/dist/ssr"
import type { AuditEvent } from "@waste/contracts/audit"

import { AssetPanelShell } from "@/components/settings/asset-management-settings"
import { useReport } from "@/components/insight/use-report"
import { Button } from "@/components/ui/button"
import { useApiClient, useApiSession } from "@/components/waste/api-session-store"
import { useServerResolver } from "@/components/waste/business-record-store"
import { allows } from "@/lib/api/grants"
import { problemSentence } from "@/lib/api/problem"
import { typed } from "@/lib/api/records/adapter"
import { COMPANY_HISTORY_MODULE, companyHistoryPage } from "@/lib/api/records/audit"
import { shownOn } from "@/lib/api/records/clock"
import { problemOfError } from "@/lib/api/records/server-records"
import type { Problem } from "@/lib/api/problem"
import { companyHistoryEntriesOf } from "@/lib/data/audit-history"

/** What the platform enforces whatever a setting says: each true of the code, never a policy of the browser's. */
export const ENFORCED_PRIVACY_CONTROLS = [
  {
    label: "Immutable audit history",
    description: "The database writes every change's history itself; no account, an administrator's included, can edit or delete it.",
  },
  {
    label: "Financial-record protection",
    description: "Issued invoices, credit notes, payments and accounting export lines are ledgers: a correction is a new document, never an edit.",
  },
] as const

/** The pages read after the first, by `Load older`. */
type Older = { events: AuditEvent[]; nextCursor: string | null; loading: boolean; problem: Problem | null }

export function PrivacySettingsOnApi() {
  const { me } = useApiSession()
  const client = useApiClient()
  const resolve = useServerResolver()
  const granted = allows(me?.role.grants, COMPANY_HISTORY_MODULE, "view")
  const [reading, setReading] = useState(0)
  const [older, setOlder] = useState<Older | null>(null)
  const first = useReport(granted ? `company-history:${reading}` : null, (asking) => companyHistoryPage(asking))

  const events = [...(first.shown?.items ?? []), ...(older?.events ?? [])]
  const nextCursor = older === null ? (first.shown?.nextCursor ?? null) : older.nextCursor
  const timezoneOf = (event: AuditEvent) => {
    const project = event.projectId === null ? undefined : resolve.byServerId(event.projectId)
    return project === undefined ? undefined : typed(project, "timezone")
  }
  const entries = companyHistoryEntriesOf(events, {
    nameOf: (serverId) => resolve.byServerId(serverId)?.name,
    when: (recordedAt, event) => shownOn(recordedAt, timezoneOf(event)),
  })

  const readAgain = () => {
    setOlder(null)
    setReading((count) => count + 1)
  }
  const loadOlder = () => {
    if (client === null || nextCursor === null) return
    setOlder((current) => ({ events: current?.events ?? [], nextCursor, loading: true, problem: null }))
    companyHistoryPage(client, nextCursor).then(
      (page) => setOlder((current) => ({ events: [...(current?.events ?? []), ...page.items], nextCursor: page.nextCursor, loading: false, problem: null })),
      (error: unknown) => setOlder((current) => ({ events: current?.events ?? [], nextCursor, loading: false, problem: problemOfError(error) })),
    )
  }

  return (
    <AssetPanelShell
      heading="Administration"
      title="Privacy, audit & retention"
      description="Who changed what across the company, newest first, and the controls the platform enforces."
      toolbar={null}
    >
      <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="privacy-enforced">
        <h3 id="privacy-enforced" className="text-sm font-semibold">
          Enforced by the platform
        </h3>
        <ul className="space-y-2">
          {ENFORCED_PRIVACY_CONTROLS.map((control) => (
            <li key={control.label}>
              <p className="text-sm font-medium">{control.label}</p>
              <p className="text-xs text-muted-foreground">{control.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3 rounded-xl border border-border/60 p-4" aria-labelledby="privacy-history">
        <div className="flex items-center justify-between gap-2">
          <h3 id="privacy-history" className="text-sm font-semibold">
            Audit history
          </h3>
          {granted && (
            <Button variant="outline" size="sm" onClick={readAgain} disabled={first.loading}>
              <ArrowClockwise className="h-4 w-4" />
              Refresh
            </Button>
          )}
        </div>
        {!granted && <p className="text-sm text-muted-foreground">The audit history is not shown to your role.</p>}
        {granted && first.problem !== null && <p className="text-sm text-muted-foreground">The audit history could not be read: {problemSentence(first.problem)}</p>}
        {granted && first.problem === null && first.shown === null && <p className="text-sm text-muted-foreground">Reading the audit history…</p>}
        {first.shown !== null && entries.length === 0 && <p className="text-sm text-muted-foreground">No change has been recorded.</p>}
        {entries.length > 0 && (
          <ol aria-label="Audit history" className={first.loading ? "divide-y divide-border/60 border-y border-border/60 opacity-60" : "divide-y divide-border/60 border-y border-border/60"}>
            {entries.map((entry) => (
              <li key={entry.key} className="space-y-1.5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{entry.who}</span>
                  <span>{entry.when}</span>
                </div>
                {entry.lines.map((line, index) => (
                  <div key={index} className="space-y-1">
                    <p className="text-sm">{line.what}</p>
                    {line.changes.length > 0 && (
                      <dl className="space-y-0.5 text-xs">
                        {line.changes.map((change) => (
                          <div key={change.label} className="flex flex-wrap gap-x-2">
                            <dt className="text-muted-foreground">{change.label}</dt>
                            <dd>
                              {change.before ?? "—"} → {change.after ?? "—"}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>
                ))}
                {entry.reason !== null && <p className="text-xs text-muted-foreground">Reason: {entry.reason}</p>}
              </li>
            ))}
          </ol>
        )}
        {older?.problem != null && <p className="text-sm text-muted-foreground">Older changes could not be read: {problemSentence(older.problem)}</p>}
        {nextCursor !== null && !first.loading && (
          <Button variant="outline" size="sm" onClick={loadOlder} disabled={older?.loading === true}>
            Load older changes
          </Button>
        )}
      </section>
    </AssetPanelShell>
  )
}
